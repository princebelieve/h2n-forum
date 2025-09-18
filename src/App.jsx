// src/App.jsx
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Render/Vercel env — set VITE_SERVER_URL in your frontend .env
const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "").split(",")[0].trim();

// WebRTC constraints
const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
const AUDIO_ONLY = {
  audio: { echoCancellation: true, noiseSuppression: true },
  video: false,
};
const LOW_VIDEO = {
  audio: { echoCancellation: true, noiseSuppression: true },
  video: {
    width: { ideal: 640, max: 640 },
    height: { ideal: 360, max: 360 },
    frameRate: { max: 15 },
    facingMode: "user",
  },
};

export default function App() {
  // socket / rtc refs
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // media elements
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // connection + identity
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");

  // room state (server returns: { code, name, hostId, locked, live })
  const [room, setRoom] = useState(null);
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState(""); // optional (only needed when creating/locked)
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  // call state
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  // chat (lightweight)
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const msgsRef = useRef(null);

  const addMsg = (m) =>
    setMsgs((p) => (p.length > 199 ? [...p.slice(-199), m] : [...p, m]));
  const isHost = !!room && !!socketId && room.hostId === socketId;

  // ---------- socket setup ----------
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      setSocketId(s.id);
      s.emit("hello", me);
    });
    s.on("disconnect", () => setConnected(false));
    s.io.on("reconnect", () => setSocketId(s.id));

    // room updates
    s.on("room:live", (live) => setRoom((r) => (r ? { ...r, live } : r)));
    s.on("room:locked", (locked) => setRoom((r) => (r ? { ...r, locked } : r)));

    // chat
    s.on("chat", (m) => addMsg(m));

    // signaling
    s.on("rtc:offer", async ({ offer }) => {
      // Guest receives host offer (or peer receives your offer). Join it.
      if (pcRef.current) return; // already in a call
      const kind = voiceOnly ? "audio" : "video";
      const pc = setupPC();
      const ms = await getStream(kind);
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit("rtc:answer", { answer });
      setInCall(true);
    });

    s.on("rtc:answer", async ({ answer }) => {
      try {
        await pcRef.current?.setRemoteDescription(answer);
      } catch {}
    });

    s.on("rtc:ice", async ({ candidate }) => {
      if (candidate) {
        try {
          await pcRef.current?.addIceCandidate(candidate);
        } catch {}
      }
    });

    // host ended the call for everyone
    s.on("end-call", () => {
      leaveCall();
      addMsg({ sys: true, ts: Date.now(), text: "Host ended the call" });
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist name + re-hello
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // prefill join via URL (?room=xxxxxx&pin=1234)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("room");
    const p = q.get("pin");
    if (code) setJoinCode(code);
    if (p) setJoinPin(p);
  }, []);

  // auto-scroll chat
  useEffect(() => {
    msgsRef.current?.scrollTo({
      top: msgsRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [msgs]);

  // ---------- helpers ----------
  const setupPC = () => {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) socketRef.current?.emit("rtc:ice", { candidate: e.candidate });
    };
    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (remoteRef.current && ms) remoteRef.current.srcObject = ms;
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "disconnected" || s === "failed" || s === "closed") {
        leaveCall();
      }
    };
    return pc;
  };

  const getStream = async (kind) => {
    const c = kind === "audio" ? AUDIO_ONLY : LOW_VIDEO;
    const ms = await navigator.mediaDevices.getUserMedia(c);
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  };

  // ---------- rooms ----------
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) return addMsg({ sys: true, ts: Date.now(), text: "Create failed" });
      setRoom(res.room);
      addMsg({
        sys: true,
        ts: Date.now(),
        text: `Created room: ${res.room.name} (${res.room.code})`,
      });
    });
  };

  const joinRoom = () => {
    socketRef.current?.emit(
      "join-room",
      { code: joinCode.trim(), pin: joinPin.trim() },
      (res) => {
        if (!res?.ok)
          return addMsg({
            sys: true,
            ts: Date.now(),
            text: `Join failed: ${res?.error || ""}`,
          });
        setRoom(res.room);
        addMsg({
          sys: true,
          ts: Date.now(),
          text: `Joined room: ${res.room.name} (${res.room.code})`,
        });
      }
    );
  };

  const leaveRoom = () => {
    socketRef.current?.emit("leave-room");
    setRoom(null);
    leaveCall();
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
  };

  // ---------- host controls ----------
  const toggleLock = () => {
    if (!isHost) return;
    socketRef.current?.emit("room:lock", !room.locked, (res) => {
      if (res?.ok) setRoom((r) => ({ ...r, locked: res.locked }));
    });
  };

  const startCallHost = async () => {
    if (!isHost || inCall || !room) return;
    setStarting(true);
    try {
      // let server mark room "live" so guests can Join
      await new Promise((resolve) => {
        socketRef.current?.emit("room:live", true, () => resolve());
      });

      const kind = voiceOnly ? "audio" : "video";
      const pc = setupPC();
      const ms = await getStream(kind);
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("rtc:offer", { offer });

      setInCall(true);
    } catch {}
    setStarting(false);
  };

  const endForAll = () => {
    if (!isHost || !room) return;
    socketRef.current?.emit("end-for-all", () => {});
    leaveCall();
  };

  // ---------- guest join UX ----------
  const joinCallGuest = async () => {
    // Guests wait for host offer. This primes permission so the answer can be created quickly.
    if (inCall) return;
    try {
      const kind = voiceOnly ? "audio" : "video";
      const ms = await navigator.mediaDevices.getUserMedia(
        kind === "audio" ? AUDIO_ONLY : LOW_VIDEO
      );
      ms.getTracks().forEach((t) => t.stop());
    } catch {}
  };

  // ---------- call common ----------
  const leaveCall = () => {
    setInCall(false);
    setStarting(false);
    setMuted(false);
    setVideoOff(false);

    try {
      pcRef.current?.getSenders?.().forEach((s) => s.track && s.track.stop());
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;

    const s = localRef.current?.srcObject;
    if (s) {
      try {
        s.getTracks().forEach((t) => t.stop());
      } catch {}
      localRef.current.srcObject = null;
    }
    if (remoteRef.current?.srcObject) remoteRef.current.srcObject = null;
  };

  const toggleMute = () => {
    const tracks = localRef.current?.srcObject?.getAudioTracks?.() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setMuted((v) => !v);
  };
  const toggleVideo = () => {
    const tracks = localRef.current?.srcObject?.getVideoTracks?.() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setVideoOff((v) => !v);
  };

  // ---------- chat ----------
  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    const mine = { name: me, ts: Date.now(), text: t };
    addMsg(mine);
    socketRef.current?.emit("chat", t);
    setText("");
  };

  // invite
  const copyInvite = async () => {
    if (!room?.code) return;
    const url = new URL(location.href);
    url.searchParams.set("room", room.code);
    if (room.locked && pin) url.searchParams.set("pin", pin);
    await navigator.clipboard.writeText(url.toString());
    addMsg({ sys: true, ts: Date.now(), text: "Invite link copied" });
  };

  // ---------- UI ----------
  return (
    <div className="shell">
      <div className="glass">
        <header className="head">
          <h1>{isHost ? "H2N Forum — Host" : "H2N Forum"}</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>
          <button
            className="chip"
            onClick={() => {
              const n = prompt("Your display name:", me);
              if (n !== null) setMe(n.trim() || "Me");
            }}
          >
            <span className="chip-label">You:</span>
            <b className="chip-name">{me}</b>
            <span className="chip-edit">✎</span>
          </button>
        </header>

        {!room && (
          <>
            <div className="row title">Create a room</div>
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
              <button className="btn primary" onClick={createRoom} disabled={!connected}>
                Create Room
              </button>
            </div>

            <div className="row title right">Or join with code + optional PIN</div>
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
              <button className="btn" onClick={joinRoom} disabled={!connected}>
                Join
              </button>
            </div>

            <div className="hint">
              Rooms auto-delete after being empty. Share the code (and PIN if set).
            </div>
          </>
        )}

        {room && (
          <>
            <div className="row">
              <div className="inroom">
                In room: <b>{room.name}</b> <span className="mono">({room.code})</span>
                <button className="link" onClick={copyInvite}>
                  Copy invite
                </button>
                <button className="link" onClick={leaveRoom}>
                  Leave
                </button>
              </div>
            </div>

            {/* Host vs Guest control bar */}
            <div className="row callbar">
              <label className="chk">
                <input
                  type="checkbox"
                  checked={voiceOnly}
                  onChange={(e) => setVoiceOnly(e.target.checked)}
                />
                <span>Voice only</span>
              </label>

              {isHost ? (
                <>
                  <button
                    className="btn primary"
                    onClick={startCallHost}
                    disabled={starting || inCall}
                  >
                    {starting ? "Starting…" : "Start call"}
                  </button>
                  <button className="btn" onClick={toggleMute} disabled={!inCall}>
                    {muted ? "Unmute" : "Mute"}
                  </button>
                  <button className="btn" onClick={toggleVideo} disabled={!inCall || voiceOnly}>
                    {videoOff ? "Camera On" : "Camera Off"}
                  </button>
                  <button className="btn" onClick={toggleLock}>
                    {room.locked ? "Unlock room" : "Lock room"}
                  </button>
                  <button className="btn danger" onClick={endForAll} disabled={!inCall}>
                    End call for all
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn primary"
                    onClick={joinCallGuest}
                    disabled={inCall || !room.live}
                  >
                    Join call
                  </button>
                  <button className="btn" onClick={toggleMute} disabled={!inCall}>
                    {muted ? "Unmute" : "Mute"}
                  </button>
                  <button className="btn" onClick={toggleVideo} disabled={!inCall || voiceOnly}>
                    {videoOff ? "Camera On" : "Camera Off"}
                  </button>
                </>
              )}
            </div>

            {!room.live && !isHost && (
              <div className="hint">
                Waiting for the host to start the call. You’ll be able to <b>Join call</b> once it
                starts.
              </div>
            )}

            {/* Media area */}
            {!voiceOnly && (
              <div className="media single">
                <div className="remotePane">
                  <video ref={remoteRef} autoPlay playsInline />
                  <video ref={localRef} autoPlay playsInline muted className="pip" />
                </div>
              </div>
            )}
          </>
        )}

        {/* Messages */}
        <div className="msgs" ref={msgsRef}>
          {msgs.length === 0 ? (
            <div className="muted">No messages yet. Say hi! 👋</div>
          ) : (
            msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.sys ? "sys" : ""}`}>
                {!m.sys && (
                  <div className="meta">
                    <span className="who">{m.name || "Anon"}</span>
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
