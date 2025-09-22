// src/App.jsx
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "").split(",")[0].trim();
const TURN_URL = (import.meta.env.VITE_TURN_URL || "").trim();

const AUDIO_ONLY = { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
const LOW_VIDEO = {
  audio: { echoCancellation: true, noiseSuppression: true },
  video: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { max: 15 }, facingMode: "user" },
};

async function getIceServers() {
  try {
    if (!TURN_URL) throw new Error("TURN_URL missing");
    const res = await fetch(TURN_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`TURN fetch ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data?.iceServers ?? data);
    if (!Array.isArray(list) || list.length === 0) throw new Error("Empty TURN list");
    return list;
  } catch (err) {
    console.warn("TURN fetch failed, fallback to STUN:", err?.message || err);
    return [{ urls: ["stun:stun.l.google.com:19302"] }];
  }
}

export default function App() {
  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const iceRef = useRef([{ urls: ["stun:stun.l.google.com:19302"] }]);

  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const peerIdRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");

  const [room, setRoom] = useState(null); // {code,name,hostId,locked,live}
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);
  const addMsg = (m) => setMsgs((p) => (p.length > 199 ? [...p.slice(-199), m] : [...p, m]));
  const isHost = !!room && !!socketId && room.hostId === socketId;

  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      setSocketId(s.id);
      s.emit("hello", me);
    });
    s.on("disconnect", () => setConnected(false));
    s.on("reconnect", () => setSocketId(s.id));

    s.on("chat", (m) => addMsg(m));
    s.on("room:live", (payload) => {
  // payload might be a boolean or an object like { live: true }
  const live = typeof payload === "boolean" ? payload : payload?.live;

  console.log("room:live >", live);
  setRoom((r) => ({ ...r, live }));

  // If this client is a guest and the host just went live, ask for an offer
  if (live && !isHost) {
    socketRef.current?.emit("rtc:ready");
  }
});
    s.on("room:locked", (locked) => setRoom((r) => (r ? { ...r, locked } : r)));

  // Host: when a guest is ready, start an offer to that specific guest
s.on("rtc:ready", ({ guestId }) => {
  if (!isHost || !guestId) return;
  peerIdRef.current = guestId;   // 👈 store the guest ID so ICE knows where to go
  startCallHost(guestId);        // pass the peer id into start
});

    s.on("rtc:offer", async ({ offer, from }) => {
  if (pcRef.current) return;
  iceRef.current = await getIceServers();
  const pc = await setupPeer();
  const ms = await getLocalStream();
  ms.getTracks().forEach((t) => pc.addTrack(t, ms));

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // Answer back to the host that sent the offer
  socketRef.current?.emit("rtc:answer", { to: from, answer });
  setInCall(true);
});

    s.on("rtc:answer", async ({ answer }) => {
      if (!pcRef.current) return;
      try { await pcRef.current.setRemoteDescription(answer); } catch {}
    });

    s.on("rtc:ice", async ({ candidate }) => {
      if (!candidate || !pcRef.current) return;
      try { await pcRef.current.addIceCandidate(candidate); } catch {}
    });

    s.on("end-call", () => leaveCall());

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const c = p.get("code"), pin0 = p.get("pin");
    if (c) setJoinCode(c);
    if (pin0) setJoinPin(pin0);
  }, []);

  async function setupPeer() {
  const pc = new RTCPeerConnection({ iceServers: iceRef.current });
  pcRef.current = pc;

  // ✅ ICE candidate handler
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socketRef.current?.emit("rtc:ice", { candidate: e.candidate });
    }
  };

  pc.ontrack = (ev) => {
    const ms = ev.streams?.[0];
    if (remoteRef.current && ms) remoteRef.current.srcObject = ms;
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "failed" || st === "disconnected" || st === "closed") leaveCall();
  };

  return pc;
}

  async function getLocalStream() {
    const wantsAudioOnly = voiceOnly || videoOff;
    const ms = await navigator.mediaDevices.getUserMedia(wantsAudioOnly ? AUDIO_ONLY : LOW_VIDEO);
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  }

  function stopStream(ms) {
    if (!ms) return;
    for (const t of ms.getTracks()) { try { t.stop(); } catch {} }
  }

  // Rooms
  const createRoom = () => {
  socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
    if (!res?.ok) return addMsg({ sys: true, ts: Date.now(), text: "Create failed" });
    setRoom(res.room);
    // no addMsg here — server already announces "Created room ..."
  });
};
  const joinRoom = () => {
  socketRef.current?.emit("join-room", { code: joinCode.trim(), pin: joinPin.trim() }, (res) => {
    if (!res?.ok) return addMsg({ sys: true, ts: Date.now(), text: `Join failed: ${res?.error || ""}` });
    setRoom(res.room);
    // no addMsg here — server already announces "Joined room ..."
  });
};
  const leaveRoom = () => {
  socketRef.current?.emit("leave-room");
  setRoom(null);
  leaveCall();
  // no addMsg here — server already announces "Left room"
};

  // Host controls
  const toggleLock = () => {
    if (!isHost) return;
    socketRef.current?.emit("room:lock", !room.locked, (res) => {
      if (res?.ok) setRoom((r) => ({ ...r, locked: res.locked }));
    });
  };
  const startCallHost = async (toId) => {
  if (!isHost || inCall || !room) return;
  setStarting(true);
  try {
    peerIdRef.current = toId;                 // remember target peer
    iceRef.current = await getIceServers();
    const pc = await setupPeer();
    const ms = await getLocalStream();
    ms.getTracks().forEach((t) => pc.addTrack(t, ms));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // send offer to the specific guest
    socketRef.current?.emit("rtc:offer", { to: toId, offer });

    setInCall(true);
  } catch (err) {
    addMsg({ sys: true, ts: Date.now(), text: "Start failed" });
    socketRef.current?.emit("room:live", false, () => {});
  } finally {
    setStarting(false);
};
  const endForAll = () => {
    if (!isHost || !room) return;
    socketRef.current?.emit("end-for-all", () => {});
    leaveCall();
  };

  /// Guest pre-permission
const joinCallGuest = async () => {
  if (inCall || !room?.live) return;
  try {
    // Pre-warm mic (or mic+cam if voiceOnly is false) so permissions are granted
    const ms = await navigator.mediaDevices.getUserMedia(
      voiceOnly ? AUDIO_ONLY : LOW_VIDEO
    );
    stopStream(ms); // we only needed permission, not the stream yet

    // Tell the host we're ready to receive an offer
    socketRef.current?.emit("rtc:ready");
  } catch {
    addMsg({ sys: true, ts: Date.now(), text: "Mic/Camera permission denied" });
  }
};

  // Call teardown
  const leaveCall = () => {
    setInCall(false);
    try {
      const pc = pcRef.current;
      pcRef.current = null;
      if (pc) {
        try { pc.getSenders?.().forEach((s) => s.track && s.track.stop()); } catch {}
        try { pc.getTransceivers?.().forEach((t) => t.stop?.()); } catch {}
        try { pc.close(); } catch {}
      }
    } finally {
      if (localRef.current?.srcObject) { stopStream(localRef.current.srcObject); localRef.current.srcObject = null; }
      if (remoteRef.current?.srcObject) { stopStream(remoteRef.current.srcObject); remoteRef.current.srcObject = null; }
    }
  };
  const toggleMute = () => {
    const ms = localRef.current?.srcObject; if (!ms) return;
    ms.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    setMuted((m) => !m);
  };
  const toggleVideo = () => {
    const ms = localRef.current?.srcObject; if (!ms) return;
    ms.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    setVideoOff((v) => !v);
  };

  const copyInvite = async () => {
    if (!room) return;
    const text = `${location.origin}?code=${room.code}${room.pin ? `&pin=${room.pin}` : ""}`;
    try { await navigator.clipboard.writeText(text); addMsg({ sys: true, ts: Date.now(), text: "Invite link copied" }); }
    catch { addMsg({ sys: true, ts: Date.now(), text }); }
  };

  return (
    <div className="shell">
      <div className="glass">
        <div className="head">
          <h1>{isHost ? "H2N Forum — Host" : "H2N Forum"}</h1>
        <span className={`pill ${connected ? "ok" : ""}`}>{connected ? "Connected to server" : "Disconnected"}</span>
          <span className="chip" onClick={() => { const n = prompt("Enter your name", me || ""); if (n !== null) setMe((n || "").trim() || "Me"); }}>
            <span className="chip-label">You:</span><span className="chip-name">{me}</span><span className="chip-edit">✎</span>
          </span>
        </div>

        {!room && (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row"><label>Room name</label><input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="Optional" /></div>
            <div className="row"><label>PIN</label><input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="4–6 digits (optional)" /></div>
            <div className="row"><button className="btn primary" onClick={createRoom}>Create</button></div>

            <div className="row title">Code + optional PIN</div>
            <div className="row">
              <label>6-digit code</label>
              <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="XXXXXX" />
              <input value={joinPin} onChange={(e) => setJoinPin(e.target.value)} placeholder="PIN (if required)" />
              <button className="btn" onClick={joinRoom}>Join</button>
            </div>
            <div className="hint">Rooms auto-delete after being empty for a while.</div>
          </>
        )}

        {room && (
          <>
            <div className="row">
              <div className="inroom">
                In room: <b>{room.name || "Room"}</b> <span style={{ opacity: 0.85 }}>({room.code})</span>
              </div>
              <button className="link" onClick={copyInvite}>Copy invite</button>
              <button className="link" onClick={leaveRoom}>Leave</button>
            </div>

            <div className="row callbar">
              {isHost && !inCall && (
                <button className="btn primary" disabled={starting} onClick={startCallHost}>
                  {starting ? "Starting…" : "Start call"}
                </button>
              )}
              {!isHost && (
                <button className="btn primary" disabled={!room.live || inCall} onClick={joinCallGuest}>
                  Join call
                </button>
              )}
              <button className="btn" disabled={!inCall} onClick={toggleMute}>{muted ? "Unmute" : "Mute"}</button>
              <button className="btn" disabled={!inCall} onClick={toggleVideo}>{videoOff ? "Camera On" : "Camera Off"}</button>
              {isHost && <button className="btn" onClick={toggleLock}>{room.locked ? "Unlock room" : "Lock room"}</button>}
              {isHost && inCall && <button className="btn danger" onClick={endForAll}>End call for all</button>}
              <div className="chk" style={{ marginLeft: "auto" }}>
                <input type="checkbox" checked={voiceOnly} onChange={(e) => setVoiceOnly(e.target.checked)} />
                <span>Voice only</span>
              </div>
            </div>

            <div className="media single">
              <div className="remotePane">
                <video ref={remoteRef} playsInline autoPlay />
                <video ref={localRef} playsInline autoPlay muted className="pip" />
              </div>
            </div>
          </>
        )}

        <div className="msgs" ref={msgsRef} style={{ marginTop: 12 }}>
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.sys ? "sys" : ""}`}>
              {m.sys ? m.text : (
                <>
                  <div className="meta"><span className="who">{m.name}</span><span className="ts">{new Date(m.ts).toLocaleTimeString()}</span></div>
                  <div>{m.text}</div>
                </>
              )}
            </div>
          ))}
        </div>

        <SendBox
  disabled={!room}
  onSend={(t) => {
    // send to server only — let the server's "chat" event render it
    socketRef.current?.emit("chat", { name: me, text: t, ts: Date.now() });
  }}
/>

function SendBox({ disabled, onSend }) {
  const [text, setText] = useState("");

  return (
    <div className="send">
      <textarea
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (text.trim()) onSend(text);
            setText("");
          }
        }}
      />
      <button
        className="btn primary"
        disabled={disabled}
        onClick={() => {
          if (text.trim()) onSend(text);
          setText("");
        }}
      >
        Send
      </button>
    </div>
  );
}
