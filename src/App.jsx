import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

/* ---------- Config ---------- */
const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL || "").trim() || window.location.origin;

// STUN only (good default; easy on mobile data)
const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

// Media presets
const AUDIO_ONLY = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};
const LOW_VIDEO = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: {
    width: { ideal: 640, max: 640 },
    height: { ideal: 360, max: 360 },
    frameRate: { max: 15 },
    facingMode: "user",
  },
};

export default function App() {
  /* ---------- Refs ---------- */
  const socketRef = useRef(null);
  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);

  // peerId -> { pc, stream, videoEl }
  const peersRef = useRef(new Map());

  /* ---------- UI State ---------- */
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");

  const [room, setRoom] = useState(null); // { code, name, requiresPin }
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  const [voiceOnly, setVoiceOnly] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [starting, setStarting] = useState(false);

  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);
  const [text, setText] = useState("");
  const addMsg = (m) => setMsgs((p) => (p.length > 199 ? [...p.slice(-199), m] : [...p, m]));

  const remotePeers = useMemo(() => {
    return Array.from(peersRef.current.entries()).map(([peerId, p]) => ({
      peerId,
      stream: p.stream || null,
    }));
  }, [inCall, room, peersRef.current.size, msgs.length]); // coarse invalidation is fine

  /* ---------- Socket setup ---------- */
  useEffect(() => {
    const s = io(SERVER_URL, { path: "/socket.io", transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("hello", me);
    });
    s.on("disconnect", () => setConnected(false));

    // system + chat
    s.on("chat", (m) => addMsg(m));

    // ---- WebRTC signaling (mesh) ----
    s.on("rtc:peer-joined", ({ peerId }) => {
      // A new peer entered the room; we (existing peer) initiate an offer to them.
      if (!inCall || !room?.code || peerId === s.id) return;
      createPeerAndOffer(peerId).catch(() => {});
    });

    s.on("rtc:peer-left", ({ peerId }) => {
      removePeer(peerId);
    });

    s.on("rtc:offer", async ({ from, offer }) => {
      // If we don't have a PC for this sender yet, create it (we are the answerer)
      if (!peersRef.current.has(from)) {
        await createPeer(from, /*initiator*/ false);
      }
      const { pc } = peersRef.current.get(from);
      try {
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current?.emit("rtc:answer", { roomId: room?.code, answer });
      } catch (e) {
        console.error("setRemoteDescription/answer failed", e);
      }
    });

    s.on("rtc:answer", async ({ from, answer }) => {
      const rec = peersRef.current.get(from);
      if (!rec) return;
      try {
        await rec.pc.setRemoteDescription(answer);
      } catch (e) {
        console.error("setRemoteDescription(answer) failed", e);
      }
    });

    s.on("rtc:ice", async ({ from, candidate }) => {
      const rec = peersRef.current.get(from);
      if (!rec || !candidate) return;
      try {
        await rec.pc.addIceCandidate(candidate);
      } catch (e) {
        // ignore late/closed
      }
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist name + notify server
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // prefill join fields from URL (room, pin)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("room");
    const p = q.get("pin");
    if (code) setJoinCode(code);
    if (p) setJoinPin(p);
  }, []);

  // autoscroll chat
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  /* ---------- Room actions ---------- */
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) return;
      setRoom(res.room);
      setJoinCode(res.room.code);
      addMsg({ sys: true, ts: Date.now(), text: `Created room: ${res.room.name} (${res.room.code})` });
    });
  };

  const joinRoom = () => {
    socketRef.current?.emit("join-room", { code: joinCode.trim(), pin: joinPin.trim() }, (res) => {
      if (!res?.ok) {
        addMsg({ sys: true, ts: Date.now(), text: `Join failed: ${res?.error || "unknown error"}` });
        return;
      }
      setRoom(res.room);
      addMsg({ sys: true, ts: Date.now(), text: `Joined room: ${res.room.name} (${res.room.code})` });
    });
  };

  const leaveRoom = () => {
    stopCall();
    socketRef.current?.emit("leave-room");
    setRoom(null);
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
  };

  /* ---------- Call controls (mesh) ---------- */
  const startCall = async () => {
    if (!room?.code || inCall || starting) return;
    setStarting(true);

    try {
      // 1) Get local media
      const constraints = voiceOnly ? AUDIO_ONLY : LOW_VIDEO;
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      // 2) Join the RTC signaling room
      socketRef.current?.emit("rtc:join", { roomId: room.code });

      // 3) For peers already in the room, the server will cause THEM to send offers to us
      //    via 'rtc:peer-joined' we also create offers to newcomers.

      setInCall(true);
      addMsg({ sys: true, ts: Date.now(), text: "Call started" });
    } catch (e) {
      console.error(e);
      stopCall(); // cleanup on failure
    } finally {
      setStarting(false);
    }
  };

  const stopCall = () => {
    // stop local
    const s = localStreamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;

    // close all peers
    for (const [peerId, rec] of peersRef.current) {
      try { rec.pc.close(); } catch {}
      if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    }
    peersRef.current.clear();

    setInCall(false);
    socketRef.current?.emit("rtc:leave", { roomId: room?.code });
  };

  const toggleCall = async () => (inCall ? stopCall() : startCall());

  /* ---------- Peer helpers ---------- */
  function makePC(peerId) {
    const pc = new RTCPeerConnection(ICE);

    // Send our local tracks to this peer
    const ls = localStreamRef.current;
    if (ls) ls.getTracks().forEach((t) => pc.addTrack(t, ls));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current?.emit("rtc:ice", {
          roomId: room?.code,
          candidate: e.candidate,
        });
      }
    };

    pc.ontrack = (ev) => {
      let rec = peersRef.current.get(peerId);
      if (!rec) {
        rec = { pc, stream: null };
        peersRef.current.set(peerId, rec);
      }
      const stream = ev.streams?.[0];
      if (stream) {
        rec.stream = stream;
        // trigger re-render by bumping chat (cheap) or toggling state:
        setMsgs((m) => [...m]); // tiny tick to re-render video list
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        removePeer(peerId);
      }
    };

    return pc;
  }

  async function createPeer(peerId, initiator) {
    const pc = makePC(peerId);
    peersRef.current.set(peerId, { pc, stream: null });

    if (initiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.emit("rtc:offer", { roomId: room?.code, offer });
      } catch (e) {
        console.error("createOffer failed", e);
      }
    }
    return pc;
  }

  async function createPeerAndOffer(peerId) {
    const pc = await createPeer(peerId, true);
    return pc;
  }

  function removePeer(peerId) {
    const rec = peersRef.current.get(peerId);
    if (!rec) return;
    try { rec.pc.close(); } catch {}
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    peersRef.current.delete(peerId);
    setMsgs((m) => [...m]); // tick UI
  }

  /* ---------- Chat ---------- */
  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    addMsg({ name: me, text: t, ts: Date.now() });
    socketRef.current?.emit("chat", t);
    setText("");
  };

  /* ---------- Invite ---------- */
  const copyInvite = async () => {
    if (!room?.code) return;
    const url = new URL(location.href);
    url.searchParams.set("room", room.code);
    if (room?.requiresPin) url.searchParams.set("pin", pin || "");
    await navigator.clipboard.writeText(url.toString());
    addMsg({ sys: true, ts: Date.now(), text: "Invite link copied" });
  };

  /* ---------- Render ---------- */
  return (
    <div className="shell">
      <div className="glass">
        <header className="head">
          <h1>H2N Forum</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>

          <div className="spacer" />

          <div className="you">
            You:&nbsp;
            <input
              value={me}
              onChange={(e) => setMe(e.target.value)}
              className="who"
              style={{ width: Math.max(2, me.length) + "ch" }}
            />
          </div>
        </header>

        {!room && (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row">
              <input
                placeholder="Room name (optional)"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
              />
              <input
                placeholder="PIN (4–6 digits, optional)"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              <button className="btn primary" onClick={createRoom}>
                Create Meeting
              </button>
            </div>

            <div className="row title right">Code + optional PIN</div>
            <div className="row">
              <input
                placeholder="6-digit code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
              />
              <input
                placeholder="PIN (if required)"
                value={joinPin}
                onChange={(e) => setJoinPin(e.target.value)}
              />
              <button className="btn" onClick={joinRoom}>
                Join
              </button>
            </div>

            <div className="hint">
              Rooms auto-delete after being empty for a while. Share the code (and PIN if set).
            </div>
          </>
        )}

        {room && (
          <>
            <div className="row">
              <div className="inroom">
                In room: <b>{room.name}</b>{" "}
                <span className="mono">({room.code})</span>
                <button className="link" onClick={copyInvite}>
                  Copy invite
                </button>
                <button className="link" onClick={leaveRoom}>
                  Leave
                </button>
              </div>
            </div>

            <div className="row callbar">
              <label className="chk">
                <input
                  type="checkbox"
                  checked={voiceOnly}
                  onChange={(e) => setVoiceOnly(e.target.checked)}
                  disabled={inCall}
                />
                <span>Voice only</span>
              </label>

              <button
                className={`btn ${inCall ? "danger" : "primary"}`}
                onClick={toggleCall}
                disabled={!connected || starting}
              >
                {starting ? "Starting…" : inCall ? "End Call" : "Start Call"}
              </button>
            </div>

            {/* Media grid (local + all remotes) */}
            <div className="media-grid">
              {/* Local self-view */}
              {!voiceOnly && (
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="tile self"
                />
              )}

              {/* Remotes */}
              {!voiceOnly &&
                remotePeers.map(({ peerId, stream }) => (
                  <VideoTile key={peerId} stream={stream} />
                ))}
            </div>
          </>
        )}

        {/* Chat */}
        <div className="msgs" ref={msgsRef}>
          {msgs.length === 0 ? (
            <div className="muted">No messages yet. Say hi! 👋</div>
          ) : (
            msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.sys ? "sys" : ""}`}>
                {!m.sys && (
                  <div className="meta">
                    <span className="who">{m.name}</span>
                    <span className="ts">
                      {typeof m.ts === "number" ? new Date(m.ts).toLocaleTimeString() : ""}
                    </span>
                  </div>
                )}
                <div className="text">{m.text}</div>
              </div>
            ))
          )}
        </div>

        <div className="send">
          <textarea
            placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChat();
              }
            }}
          />
          <button className="btn primary" onClick={sendChat}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Small helper for remote tiles ---------- */
function VideoTile({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline className="tile" />;
}
