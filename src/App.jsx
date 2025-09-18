// src/App.jsx
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// SERVER_URL from Vite env
const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "").split(",")[0].trim();

// STUN (add TURN later if you want)
const ICE = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] },
    // { urls: "turn:YOUR_TURN_HOST:3478", username: "XXX", credential: "YYY" },
  ],
};

// media constraints
const AUDIO_ONLY = { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
const LOW_VIDEO = {
  audio: { echoCancellation: true, noiseSuppression: true },
  video: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { max: 15 }, facingMode: "user" },
};

export default function App() {
  // sockets / rtc
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // media
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // sounds (optional files under /public/sounds)
  const ringInRef = useRef(null);
  const ringBackRef = useRef(null);

  // identity + server
  const [connected, setConnected] = useState(false);
  const [sid, setSid] = useState(null);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");
  const [showNameEdit, setShowNameEdit] = useState(false);
  const [nameDraft, setNameDraft] = useState(me);

  // room + chat
  const [room, setRoom] = useState(null); // {code,name,hostId,locked,live}
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");
  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);

  // call state
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  // UI
  const [mainVideo, setMainVideo] = useState("remote");
  const [fitContain, setFitContain] = useState(true);
  const addMsg = (m) => setMsgs((p) => (p.length > 199 ? [...p.slice(-199), m] : [...p, m]));
  const isHost = !!room && !!sid && room.hostId === sid;

  // -------- socket setup --------
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      setSid(s.id);
      s.emit("hello", me);
    });
    s.on("disconnect", () => setConnected(false));
    s.io.on("reconnect", () => setSid(s.id));

    // chat + room flags
    s.on("chat", (m) => addMsg(m));
    s.on("room:live", (live) => setRoom((r) => (r ? { ...r, live } : r)));
    s.on("room:locked", (locked) => setRoom((r) => (r ? { ...r, locked } : r)));

    // ---- broadcast signalling (host -> all) ----
    s.on("rtc:offer", async ({ offer }) => {
      // Any guest receives this when the host starts a call
      if (pcRef.current) return;
      const pc = setupPC();
      const ms = await getStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit("rtc:answer", { answer });
      setInCall(true);
    });

    s.on("rtc:answer", async ({ answer, from }) => {
      // host receives answers from guests
      try {
        await pcRef.current?.setRemoteDescription(answer);
      } catch {}
    });

    s.on("rtc:ice", async ({ candidate }) => {
      if (!candidate) return;
      try {
        await pcRef.current?.addIceCandidate(candidate);
      } catch {}
    });

    // ---- targeted signalling (late joiners) ----
    s.on("rtc:need-offer", async ({ peerId }) => {
      // host is asked to create an offer for a specific peer
      if (!isHost || !room?.live) return;
      const pc = setupPC(); // dedicated connection per host (we reuse pcRef)
      const ms = await getStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      s.emit("rtc:offer-to", { offer, targetId: peerId });
    });

    s.on("rtc:offer-to", async ({ from, offer }) => {
      // a guest receives targeted host offer after pressing Join
      if (pcRef.current) return;
      const pc = setupPC();
      const ms = await getStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit("rtc:answer-to", { answer, targetId: from });
      setInCall(true);
    });

    s.on("rtc:answer-to", async ({ answer }) => {
      try {
        await pcRef.current?.setRemoteDescription(answer);
      } catch {}
    });

    s.on("rtc:ice-to", async ({ candidate }) => {
      if (!candidate) return;
      try {
        await pcRef.current?.addIceCandidate(candidate);
      } catch {}
    });

    // global end
    s.on("end-call", () => leaveCall());

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, room?.live, voiceOnly]);

  // persist name + re-hello
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // auto-scroll messages
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  // -------- rtc helpers --------
  const setupPC = () => {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const s = socketRef.current;
      if (!s) return;

      // If we're currently in a targeted handshake, use targeted path, else broadcast path
      // We’ll just use broadcast and let server route host/guest:
      s.emit("rtc:ice", { candidate: e.candidate });
    };

    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (remoteRef.current && ms) remoteRef.current.srcObject = ms;
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (["disconnected", "failed", "closed"].includes(st)) {
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

  // -------- rooms --------
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) return addMsg({ sys: true, ts: Date.now(), text: "Create failed" });
      setRoom(res.room);
      addMsg({ sys: true, ts: Date.now(), text: `Created room: ${res.room.name} (${res.room.code})` });
    });
  };

  const joinRoom = () => {
    socketRef.current?.emit("join-room", { code: joinCode.trim(), pin: joinPin.trim() }, (res) => {
      if (!res?.ok) {
        addMsg({ sys: true, ts: Date.now(), text: `Join failed: ${res?.error || ""}` });
        return;
      }
      setRoom(res.room);
      addMsg({ sys: true, ts: Date.now(), text: `Joined room: ${res.room.name} (${res.room.code})` });
    });
  };

  const leaveRoom = () => {
    socketRef.current?.emit("leave-room");
    setRoom(null);
    leaveCall();
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
  };

  // -------- host controls --------
  const startCallHost = async () => {
    if (!isHost || inCall || !room) return;
    setStarting(true);
    try {
      await new Promise((r) => socketRef.current?.emit("room:live", true, () => r()));
      const pc = setupPC();
      const ms = await getStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("rtc:offer", { offer }, () => {});
      setInCall(true);
    } catch {}
    setStarting(false);
  };

  const endForAll = () => {
    if (!isHost || !room) return;
    socketRef.current?.emit("end-for-all", () => {});
    leaveCall();
  };

  const toggleLock = () => {
    if (!isHost) return;
    socketRef.current?.emit("room:lock", !room.locked, (res) => {
      if (res?.ok) setRoom((r) => ({ ...r, locked: res.locked }));
    });
  };

  // -------- guest join --------
  const joinCallGuest = async () => {
    if (inCall || !room) return;
    // Ask host for a targeted offer
    socketRef.current?.emit("rtc:need-offer");
    // prompt permissions early to speed up
    try {
      const kind = voiceOnly ? "audio" : "video";
      const ms = await navigator.mediaDevices.getUserMedia(kind === "audio" ? AUDIO_ONLY : LOW_VIDEO);
      ms.getTracks().forEach((t) => t.stop());
    } catch {}
  };

  // -------- common call controls --------
  const leaveCall = () => {
    setInCall(false);
    setMuted(false);
    setVideoOff(false);
    setMainVideo("remote");

    try {
      pcRef.current?.getSenders?.().forEach((s) => s.track && s.track.stop());
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;

    const s1 = localRef.current?.srcObject;
    if (s1) {
      s1.getTracks().forEach((t) => t.stop());
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

  const copyInvite = async () => {
    if (!room?.code) return;
    const url = new URL(location.href);
    url.searchParams.set("room", room.code);
    if (room?.pin) url.searchParams.set("pin", room.pin);
    await navigator.clipboard.writeText(url.toString());
    addMsg({ sys: true, ts: Date.now(), text: "Invite link copied" });
  };

  // prefill URL
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("room");
    const p = q.get("pin");
    if (code) setJoinCode(code);
    if (p) setJoinPin(p);
  }, []);

  // -------- UI --------
  return (
    <div className="shell">
      {/* Optional hidden audio players */}
      <audio ref={ringInRef} src="/sounds/incoming.mp3" loop />
      <audio ref={ringBackRef} src="/sounds/ringback.mp3" loop />

      <div className="glass">
        <header className="head">
          <h1>H2N {isHost ? "Forum — Host" : "Forum"}</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>{connected ? "Connected to server" : "Disconnected"}</span>

          <button
            className="chip"
            onClick={() => {
              setShowNameEdit((v) => !v);
              setNameDraft(me);
            }}
          >
            <span className="chip-label">You:</span> <b className="chip-name">{me}</b> <span className="chip-edit">✎</span>
          </button>

          {showNameEdit && (
            <div className="name-pop">
              <div className="name-row">
                <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
              </div>
              <div className="name-actions">
                <button className="btn" onClick={() => setShowNameEdit(false)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    setMe(nameDraft.trim() || "Me");
                    setShowNameEdit(false);
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </header>

        {!room && (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row">
              <input placeholder="Room name (optional)" value={roomName} onChange={(e) => setRoomName(e.target.value)} />
              <input placeholder="PIN (4–6 digits, optional)" value={pin} onChange={(e) => setPin(e.target.value)} />
              <button className="btn primary" onClick={createRoom}>
                Create Meeting
              </button>
            </div>

            <div className="row title right">Code + optional PIN</div>
            <div className="row">
              <input placeholder="6-digit code" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
              <input placeholder="PIN (if required)" value={joinPin} onChange={(e) => setJoinPin(e.target.value)} />
              <button className="btn" onClick={joinRoom}>
                Join
              </button>
            </div>

            <div className="hint">Rooms auto-delete after being empty for a while. Share the code (and PIN if set).</div>
          </>
        )}

        {room && (
          <>
            <div className="row">
              <div className="inroom">
                In room:&nbsp;<b>{room.name}</b>&nbsp;<span className="mono">({room.code})</span>
                <button className="link" onClick={copyInvite}>
                  Copy invite
                </button>
                <button className="link" onClick={leaveRoom}>
                  Leave
                </button>
              </div>
            </div>

            <div className="row callbar">
              {!isHost ? (
                <>
                  <label className="chk">
                    <input type="checkbox" checked={voiceOnly} onChange={(e) => setVoiceOnly(e.target.checked)} />
                    <span>Voice only</span>
                  </label>

                  <button className="btn primary" onClick={joinCallGuest} disabled={inCall}>
                    Join call
                  </button>
                  <button className="btn" onClick={toggleMute} disabled={!inCall}>
                    {muted ? "Unmute" : "Mute"}
                  </button>
                  <button className="btn" onClick={toggleVideo} disabled={!inCall || voiceOnly}>
                    {videoOff ? "Camera On" : "Camera Off"}
                  </button>
                </>
              ) : (
                <>
                  <button className="btn danger" onClick={endForAll} disabled={!room.live && !inCall}>
                    End call for all
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
                  {!room.live && !inCall && (
                    <button className="btn primary" onClick={startCallHost} disabled={starting}>
                      {starting ? "Starting…" : "Start call"}
                    </button>
                  )}
                </>
              )}
            </div>

            {!voiceOnly && (
              <div className="media single">
                <div className="remotePane">
                  <video
                    ref={remoteRef}
                    autoPlay
                    playsInline
                    className={mainVideo === "remote" ? (fitContain ? "fit" : "") : "pip"}
                    onClick={() => setMainVideo("remote")}
                    onDoubleClick={() => setFitContain((v) => !v)}
                  />
                  <video
                    ref={localRef}
                    autoPlay
                    playsInline
                    muted
                    className={mainVideo === "local" ? (fitContain ? "fit" : "") : "pip"}
                    onClick={() => setMainVideo("local")}
                    onDoubleClick={() => setFitContain((v) => !v)}
                  />
                </div>
              </div>
            )}
          </>
        )}

        {/* messages */}
        <div className="msgs" ref={msgsRef}>
          {msgs.length === 0 ? (
            <div className="muted">No messages yet. Say hi! 👋</div>
          ) : (
            msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.sys ? "sys" : ""}`}>
                {!m.sys && (
                  <div className="meta">
                    <span className="who">{m.name}</span>
                    <span className="ts">{typeof m.ts === "number" ? new Date(m.ts).toLocaleTimeString() : ""}</span>
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
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const t = e.currentTarget.value.trim();
                if (t) {
                  addMsg({ name: me, ts: Date.now(), text: t });
                  socketRef.current?.emit("chat", t);
                  e.currentTarget.value = "";
                }
              }
            }}
          />
          <button
            className="btn primary"
            onClick={() => {
              const el = document.querySelector(".send textarea");
              const t = el.value.trim();
              if (!t) return;
              addMsg({ name: me, ts: Date.now(), text: t });
              socketRef.current?.emit("chat", t);
              el.value = "";
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
