// src/App.jsx
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// --- config ---
const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "").split(",")[0].trim();
const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
const AUDIO_ONLY = { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
const LOW_VIDEO = {
  audio: { echoCancellation: true, noiseSuppression: true },
  video: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { max: 15 }, facingMode: "user" },
};

// --- helpers for localStorage ---
const LS = {
  getName: () => localStorage.getItem("me") || "Me",
  setName: (v) => localStorage.setItem("me", v),
  saveHostToken: (code, token) => localStorage.setItem("h2n_host", JSON.stringify({ code, token })),
  readHostToken: () => {
    try { return JSON.parse(localStorage.getItem("h2n_host") || "null"); } catch { return null; }
  },
  clearHostToken: () => localStorage.removeItem("h2n_host"),
};

export default function App() {
  // socket / rtc
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // media els
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // ui/state
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [me, setMe] = useState(LS.getName);

  const [room, setRoom] = useState(null); // { code, name, hostId, locked, live }
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  const [voiceOnly, setVoiceOnly] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [starting, setStarting] = useState(false);
  const [joining, setJoining] = useState(false);

  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);

  const addMsg = (m) => setMsgs((p) => (p.length > 199 ? [...p.slice(-199), m] : [...p, m]));
  const isHost = !!room && room.hostId === socketId;

  // --- socket setup ---
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      setSocketId(s.id);
      s.emit("hello", me);

      // try reclaim host on connect if we have a saved token
      const saved = LS.readHostToken();
      if (saved && room && saved.code === room.code) {
        s.emit("claim-host", saved, (res) => {
          if (res?.ok && res.room) setRoom(res.room);
        });
      }
    });

    s.on("disconnect", () => setConnected(false));
    s.io.on("reconnect", () => setSocketId(s.id));

    // chat + room updates
    s.on("chat", (m) => addMsg(m));
    s.on("room:live", (live) => setRoom((r) => (r ? { ...r, live } : r)));
    s.on("room:locked", (locked) => setRoom((r) => (r ? { ...r, locked } : r)));

    // signalling
    s.on("rtc:offer", async ({ offer }) => {
      // guest receives host's offer
      if (pcRef.current) return; // already have a call
      setJoining(false);

      const pc = setupPC();
      const ms = await getStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit("rtc:answer", { answer });
      setInCall(true);
    });

    s.on("rtc:answer", async ({ answer }) => {
      try { await pcRef.current?.setRemoteDescription(answer); } catch {}
    });

    s.on("rtc:ice", async ({ candidate }) => {
      if (candidate) { try { await pcRef.current?.addIceCandidate(candidate); } catch {} }
    });

    s.on("end-call", () => {
      leaveCall();
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist name + say hello
  useEffect(() => {
    LS.setName(me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // autoscroll chat
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  // --- rtc helpers ---
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
      if (s === "disconnected" || s === "failed" || s === "closed") leaveCall();
    };
    return pc;
  };

  const getStream = async (kind) => {
    const c = kind === "audio" ? AUDIO_ONLY : LOW_VIDEO;
    const ms = await navigator.mediaDevices.getUserMedia(c);
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  };

  // --- rooms ---
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName.trim(), pin: pin.trim() }, (res) => {
      if (!res?.ok) return addMsg({ sys: true, ts: Date.now(), text: "Create failed" });
      setRoom(res.room);
      if (res.hostToken) LS.saveHostToken(res.room.code, res.hostToken);
      addMsg({ sys: true, ts: Date.now(), text: `Created room: ${res.room.name} (${res.room.code})` });
    });
  };

  const joinRoom = () => {
    socketRef.current?.emit("join-room", { code: joinCode.trim(), pin: joinPin.trim() }, (res) => {
      if (!res?.ok) return addMsg({ sys: true, ts: Date.now(), text: `Join failed: ${res?.error || ""}` });
      setRoom(res.room);
      // we are a guest; ensure we don't keep any stale host token
      LS.clearHostToken();
      addMsg({ sys: true, ts: Date.now(), text: `Joined room: ${res.room.name} (${res.room.code})` });
    });
  };

  const leaveRoom = () => {
    socketRef.current?.emit("leave-room");
    LS.clearHostToken();
    setRoom(null);
    leaveCall();
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
  };

  // --- host controls ---
  const toggleLock = () => {
    if (!isHost || !room) return;
    socketRef.current?.emit("room:lock", !room.locked, (res) => {
      if (res?.ok) setRoom((r) => ({ ...r, locked: res.locked }));
    });
  };

  const startCallHost = async () => {
    if (!isHost || inCall || !room) return;
    setStarting(true);
    try {
      // mark room live first so guests can click Join
      await new Promise((resolve) => socketRef.current?.emit("room:live", true, () => resolve()));

      const pc = setupPC();
      const ms = await getStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("rtc:offer", { offer });

      setInCall(true);
    } catch (e) {
      // ignore
    } finally {
      setStarting(false);
    }
  };

  const endForAll = () => {
    if (!isHost || !room) return;
    socketRef.current?.emit("end-for-all", () => {});
    leaveCall();
  };

  // --- guest join UX ---
  const joinCallGuest = async () => {
    if (!room?.live || inCall) return;
    setJoining(true);
    // prime permissions so the answer can be created instantly when offer arrives
    try {
      const c = voiceOnly ? AUDIO_ONLY : LOW_VIDEO;
      const ms = await navigator.mediaDevices.getUserMedia(c);
      ms.getTracks().forEach((t) => t.stop());
    } catch {}
  };

  // --- media controls ---
  const toggleMute = () => {
    const ms = localRef.current?.srcObject;
    if (!ms) return;
    const next = !muted;
    ms.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  };

  const toggleVideo = () => {
    const ms = localRef.current?.srcObject;
    if (!ms) return;
    const next = !videoOff;
    ms.getVideoTracks().forEach((t) => (t.enabled = !next));
    setVideoOff(next);
  };

  const swapVideos = () => {
    if (!inCall) return;
    localRef.current?.classList.toggle("pip");
    remoteRef.current?.classList.toggle("pip");
  };

  // --- call teardown ---
  const leaveCall = () => {
    setInCall(false);
    setMuted(false);
    setVideoOff(false);

    const pc = pcRef.current;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.getSenders().forEach((s) => { try { s.track?.stop(); } catch {} });
      pc.close();
      pcRef.current = null;
    }

    const ls = localRef.current?.srcObject;
    if (ls) { ls.getTracks().forEach((t) => t.stop()); localRef.current.srcObject = null; }
    if (remoteRef.current?.srcObject) remoteRef.current.srcObject = null;

    socketRef.current?.emit("end-call");
  };

  // --- ui helpers ---
  const copyInvite = async () => {
    if (!room) return;
    const url = `${location.origin}?c=${room.code}`;
    try { await navigator.clipboard.writeText(url); addMsg({ sys: true, ts: Date.now(), text: "Invite link copied" }); } catch {}
  };

  // deep-link join by code in URL (?c=123456)
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const code = p.get("c");
    if (code) setJoinCode(code);
  }, []);

  // render
  return (
    <div className="shell">
      <div className="glass">
        <header className="head">
          <h1>H2N Forum{isHost ? " — Host" : ""}</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>{connected ? "Connected to server" : "Disconnected"}</span>
          <div className="chip" title="Edit name" onClick={() => {
            const v = prompt("Enter display name", me);
            if (v && v.trim()) setMe(v.trim());
          }}>
            <span className="chip-label">You:</span>
            <span className="chip-name">{me}</span>
          </div>
        </header>

        {!room && (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row">
              <label>Room name (optional)</label>
              <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g. Team chat" />
            </div>
            <div className="row">
              <label>PIN (4–6 digits, optional)</label>
              <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="PIN (if required)" />
            </div>
            <div className="row">
              <button className="btn primary" onClick={createRoom} disabled={!connected}>Create</button>
              <span className="hint">Share the code after it’s created.</span>
            </div>

            <div className="row title">Code + optional PIN</div>
            <div className="row">
              <label>6-digit code</label>
              <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" />
              <input value={joinPin} onChange={(e) => setJoinPin(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="PIN (if required)" />
            </div>
            <div className="row">
              <button className="btn" onClick={joinRoom} disabled={!connected || joinCode.length !== 6}>Join</button>
            </div>

            <div className="hint">Rooms auto-delete after being empty for a while. Share the code (and PIN if set).</div>
          </>
        )}

        {room && (
          <>
            <div className="row"><label>In room:</label><div><b>{room.name || "Room"}</b> ({room.code})</div>
              <button className="btn" onClick={copyInvite}>Copy invite</button>
              <button className="btn link" onClick={leaveRoom}>Leave</button>
            </div>

            <div className="row callbar">
              {!inCall && isHost && (
                <button className="btn primary" onClick={startCallHost} disabled={starting}>
                  {starting ? "Starting…" : "Start call"}
                </button>
              )}
              {!isHost && (
                <button className="btn primary" onClick={joinCallGuest} disabled={!room.live || inCall}>
                  {room.live ? (joining ? "Requesting…" : "Join call") : "Waiting for host…"}
                </button>
              )}
              <button className="btn" onClick={toggleMute} disabled={!inCall}>{muted ? "Unmute" : "Mute"}</button>
              <button className="btn" onClick={toggleVideo} disabled={!inCall}>{videoOff ? "Camera On" : "Camera Off"}</button>
              {isHost && <button className="btn" onClick={toggleLock}>{room.locked ? "Unlock room" : "Lock room"}</button>}
              {isHost && <button className="btn danger" onClick={endForAll}>End call for all</button>}
              {inCall && <button className="btn" onClick={leaveCall}>Leave call</button>}
              <label className="chk"><input type="checkbox" checked={voiceOnly} onChange={(e) => setVoiceOnly(e.target.checked)} /> Voice only</label>
            </div>

            <div className="media single">
              <div className="remotePane" onClick={swapVideos}>
                <video ref={remoteRef} autoPlay playsInline muted={false} />
                <video ref={localRef} autoPlay playsInline muted className="pip" />
              </div>
            </div>
          </>
        )}

        <div className="msgs" ref={msgsRef}>
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.sys ? "sys" : ""}`}>
              {!m.sys && <div className="meta"><span className="who">{m.name}</span><span className="ts">{new Date(m.ts).toLocaleTimeString()}</span></div>}
              <div>{m.text}</div>
            </div>
          ))}
        </div>

        <SendBox disabled={!room} onSend={(text) => socketRef.current?.emit("chat", text)} />
      </div>
    </div>
  );
}

function SendBox({ disabled, onSend }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };
  return (
    <div className="send">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        }}
        disabled={disabled}
      />
      <button className="btn primary" onClick={send} disabled={disabled}>Send</button>
    </div>
  );
}
