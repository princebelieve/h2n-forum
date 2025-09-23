// src/App.jsx — Section 1: imports + refs + state
import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import "./App.css";

// ---- env / endpoints --------------------------------------------------------
const SERVER_URL =
  (import.meta.env?.VITE_SERVER_URL || "").split(",")[0]?.trim() ||
  window.location.origin;

const TURN_URL = (import.meta.env?.VITE_TURN_URL || "").trim(); // optional

// ---- component --------------------------------------------------------------
export default function App() {
  // ---- refs -----------------------------------------------------------------
  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // ICE list starts with public STUN; we may extend with TURN later
  const iceRef = useRef([{ urls: "stun:stun1.l.google.com:19302" }]);

  // who we are calling / who calls us
  const peerIdRef = useRef(null);

  // guest “ready” re-announce timer (prevents being stuck)
  const readyTimerRef = useRef(null);

  // audio elements (ringing / ringback)
  const incomingAudioRef = useRef(null);
  const ringbackAudioRef = useRef(null);

  // ---- state ----------------------------------------------------------------
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");

  const [room, setRoom] = useState({
    code: null,   // 6-digit code
    name: null,   // optional room name
    hostId: null, // socket id of current host
    locked: false,
    live: false,
  });

  // inputs
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  // flags
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  // chat
  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);

  // derived
  const isHost = !!room.code && room.hostId === socketId;

  // small helper to push a message and keep last ~200
  const addMsg = (m) =>
    setMsgs((p) => (p.length > 199 ? [...p.slice(-190), m] : [...p, m]));

  // (handlers, effects, UI come in later sections)

// =========================
  // Section 2 — Helpers
  // =========================

  // -- call quality constraints --
  const AUDIO_ONLY = { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
  const LOW_VIDEO = {
    audio: { echoCancellation: true, noiseSuppression: true },
    video: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { max: 15 }, facingMode: "user" },
  };

  // -- tiny message helper --
  const sys = (text) => addMsg({ sys: true, ts: Date.now(), text });

  // -- sounds: preload + unlock after first tap/click --
  useEffect(() => {
    incomingAudioRef.current = new Audio("/sounds/incoming.mp3"); // callee ringtone
    incomingAudioRef.current.loop = true;
    ringbackAudioRef.current = new Audio("/sounds/ringback.mp3"); // caller tone
    ringbackAudioRef.current.loop = true;

    const unlock = () => {
      // best-effort unlock; ignore failures
      incomingAudioRef.current?.play().catch(()=>{});
      incomingAudioRef.current?.pause();
      incomingAudioRef.current && (incomingAudioRef.current.currentTime = 0);
      ringbackAudioRef.current?.play().catch(()=>{});
      ringbackAudioRef.current?.pause();
      ringbackAudioRef.current && (ringbackAudioRef.current.currentTime = 0);
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
    };
    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock,   { capture: true });

    return () => {
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock,   { capture: true });
    };
  }, []);

  const playIncoming  = () => { try { incomingAudioRef.current?.play(); } catch {} };
  const stopIncoming  = () => { try { incomingAudioRef.current?.pause(); incomingAudioRef.current.currentTime = 0; } catch {} };
  const playRingback  = () => { try { ringbackAudioRef.current?.play(); } catch {} };
  const stopRingback  = () => { try { ringbackAudioRef.current?.pause(); ringbackAudioRef.current.currentTime = 0; } catch {} };

  // -- TURN fetch (optional) + ICE merge --
  async function ensureIceServers() {
    if (!TURN_URL) return; // keep STUN-only if no TURN configured
    try {
      const res = await fetch(TURN_URL);
      if (!res.ok) throw new Error(`TURN ${res.status}`);
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        // place TURN first, keep STUN as fallback
        iceRef.current = [...arr, { urls: "stun:stun1.l.google.com:19302" }];
      }
    } catch (e) {
      console.warn("TURN fetch failed, staying on STUN:", e?.message || e);
    }
  }

  // -- media helpers --
  async function getLocalStream(kind = "video") {
    const wantAudioOnly = kind === "audio";
    const ms = await navigator.mediaDevices.getUserMedia(wantAudioOnly || voiceOnly ? AUDIO_ONLY : LOW_VIDEO);
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  }
  function stopStream(ms) {
    if (!ms) return;
    ms.getTracks?.().forEach(t => { try { t.stop(); } catch {} });
  }

  // -- RTCPeerConnection setup (shared by host/guest) --
  async function setupPeer() {
    await ensureIceServers();
    const pc = new RTCPeerConnection({ iceServers: iceRef.current });

    pc.onicecandidate = (e) => {
      if (!e.candidate || !peerIdRef.current) return;
      socketRef.current?.emit("rtc:ice", { to: peerIdRef.current, candidate: e.candidate });
    };

    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (remoteRef.current && ms) remoteRef.current.srcObject = ms;
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed") {
        leaveCall(); // will be defined later
      }
    };

    pcRef.current = pc;
    return pc;
  }
// =========================
  // Section 3 — Socket & RTC handlers
  // =========================
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
    socketRef.current = s;

    // --- connection ---
    const onConnect = () => {
      setConnected(true);
      setSocketId(s.id);
      s.emit("hello", me);
      sys("Connected to server");
    };
    const onDisconnect = () => setConnected(false);
    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);

    // --- chat ---
    s.on("chat", (m) => addMsg(m));

    // --- room live/lock broadcasts ---
    s.on("room:live", (payload) => {
      const live = typeof payload === "boolean" ? payload : payload?.live;
      setRoom((r) => ({ ...r, live }));
      if (!live) { stopIncoming(); stopRingback(); }
    });
    s.on("room:locked", (locked) => setRoom((r) => ({ ...r, locked })));

    // --- guest announces readiness (host hears ringtone) ---
    s.on("rtc:ready", ({ id }) => {
      // only host cares; remember the latest ready guest
      if (!id) return;
      if (!room?.code) return;
      // we can't use isHost from state here reliably inside handler,
      // but comparing with room.hostId is fine:
      if (room.hostId && room.hostId === s.id) {
        peerIdRef.current = id;
        playIncoming();
        sys("Guest is ready");
      }
    });

    // --- host receives guest's ICE / answer; both sides receive ICE ---
    s.on("rtc:answer", async ({ answer }) => {
      try { await pcRef.current?.setRemoteDescription(answer); } catch {}
    });

    s.on("rtc:ice", async ({ candidate }) => {
      if (!candidate) return;
      try { await pcRef.current?.addIceCandidate(candidate); } catch {}
    });

    // --- guest receives host offer -> stop ringback, answer immediately ---
    s.on("rtc:offer", async ({ offer, from }) => {
      stopRingback();
      if (from) peerIdRef.current = from;

      const pc = await setupPeer();
      const ms = await getLocalStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.emit("rtc:answer", { to: from, answer });
      setInCall(true);
    });

    // --- server tells everyone to end ---
    s.on("end-call", () => leaveCall());

    return () => {
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
      s.off("chat");
      s.off("room:live");
      s.off("room:locked");
      s.off("rtc:ready");
      s.off("rtc:answer");
      s.off("rtc:ice");
      s.off("rtc:offer");
      s.off("end-call");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, room?.code, room?.hostId]);

  // persist name + re-hello
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // scroll chat to bottom
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  // prefill code/pin from URL once
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const c = q.get("code");
    const p = q.get("pin");
    if (c) setJoinCode(c);
    if (p) setJoinPin(p);
  }, []);

  // =========================
  // Section 4 — Rooms & Calls
  // =========================

  // ---- rooms ----
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) return sys("Create failed");
      setRoom(res.room || {});
      setRoomName("");
      setPin("");
      sys(`Created room: ${res.room?.name} (${res.room?.code})`);
    });
  };

  const joinRoom = () => {
    const code = (joinCode || "").trim();
    const p = (joinPin || "").trim();
    if (!code) return;
    socketRef.current?.emit("join-room", { code, pin: p }, (res) => {
      if (!res?.ok) return sys(`Join failed: ${res?.error || "unknown"}`);
      setRoom(res.room || {});
      sys(`Joined room: ${res.room?.name} (${res.room?.code})`);
    });
  };

  const leaveRoom = () => {
    socketRef.current?.emit("leave-room");
    setRoom({ code: null, name: null, hostId: null, locked: false, live: false });
    leaveCall();
    sys("Left room");
  };

  const toggleLock = () => {
    if (!room?.code || room?.hostId !== socketId) return;
    socketRef.current?.emit("room:lock", !room.locked, (res) => {
      if (res?.ok) setRoom((r) => ({ ...r, locked: res.locked }));
    });
  };

  // ---- calls ----

  // host starts a call (uses latest ready guest if available; otherwise broadcasts)
  const startCallHost = async () => {
    if (!room?.code || room?.hostId !== socketId || inCall || starting) return;
    setStarting(true);
    stopIncoming(); // stop the ringtone if it was playing

    try {
      // ensure room is live so guest "Join call" is enabled
      if (!room.live) {
        await new Promise((resolve) =>
          socketRef.current?.emit("room:live", true, () => resolve())
        );
        setRoom((r) => ({ ...r, live: true }));
      }

      const pc = await setupPeer();
      const ms = await getLocalStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // broadcast offer to room (server will fan out)
      socketRef.current?.emit("rtc:offer", { offer });

      setInCall(true);
    } catch (e) {
      sys("Start call failed");
      socketRef.current?.emit("room:live", false, () => {});
      setRoom((r) => ({ ...r, live: false }));
    } finally {
      setStarting(false);
    }
  };

  // guest announces readiness repeatedly until connected
  const joinCallGuest = async () => {
    if (!room?.code || inCall) return;

    // warm permissions so the answer step is smooth
    try {
      const tmp = await navigator.mediaDevices.getUserMedia(
        voiceOnly ? { audio: true, video: false } : { audio: true, video: true }
      );
      tmp.getTracks().forEach((t) => t.stop());
    } catch {
      return sys("Mic/Camera permission denied");
    }

    // ringback while waiting for host offer
    playRingback();

    // announce ready now and every 2s until connected or room goes idle
    const announce = () => socketRef.current?.emit("rtc:ready", { id: socketRef.current?.id });
    announce();
    clearInterval(readyTimerRef.current);
    readyTimerRef.current = setInterval(() => {
      if (!inCall && room?.live) announce();
      else clearInterval(readyTimerRef.current);
    }, 2000);
  };

  // host can end for everyone
  const endForAll = () => {
    if (!room?.code || room?.hostId !== socketId) return;
    socketRef.current?.emit("end-for-all");
    leaveCall();
  };

  // common teardown
  const leaveCall = () => {
    setInCall(false);
    stopIncoming();
    stopRingback();
    clearInterval(readyTimerRef.current);

    const pc = pcRef.current;
    pcRef.current = null;

    try {
      if (pc) {
        pc.getSenders?.().forEach((s) => s.track && s.track.stop?.());
        pc.getTransceivers?.().forEach((t) => t.stop?.());
        pc.close?.();
      }
    } catch {}

    if (localRef.current?.srcObject) {
      try { localRef.current.srcObject.getTracks().forEach((t) => t.stop()); } catch {}
      localRef.current.srcObject = null;
    }
    if (remoteRef.current?.srcObject) {
      try { remoteRef.current.srcObject.getTracks().forEach((t) => t.stop()); } catch {}
      remoteRef.current.srcObject = null;
    }
  };

  // media toggles
  const toggleMute = () => {
    const ms = localRef.current?.srcObject;
    if (!ms) return;
    ms.getAudioTracks?.().forEach((t) => (t.enabled = !t.enabled));
    setMuted((m) => !m);
  };

  const toggleVideo = () => {
    const ms = localRef.current?.srcObject;
    if (!ms) return;
    ms.getVideoTracks?.().forEach((t) => (t.enabled = !t.enabled));
    setVideoOff((v) => !v);
  };

  // share invite
  const copyInvite = async () => {
    if (!room?.code) return;
    const url = new URL(location.href);
    url.searchParams.set("code", room.code);
    if (room?.pin) url.searchParams.set("pin", room.pin);
    try {
      await navigator.clipboard.writeText(url.toString());
      sys("Invite link copied");
    } catch {
      sys(url.toString());
    }
  };

// =========================
  // Section 5 — UI (JSX)
  // =========================
  return (
    <div className="shell">
      <div className="glass">
        {/* Header */}
        <header className="head">
          <h1>{isHost ? "H2N Forum — Host" : "H2N Forum"}</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>
          <button
            className="chip"
            onClick={() => {
              const n = prompt("Enter your name", me || "");
              if (n !== null) {
                const v = (n || "").trim() || "Me";
                setMe(v);
              }
            }}
          >
            <span className="chip-label">You:</span>{" "}
            <b className="chip-name">{me}</b>{" "}
            <span className="chip-edit">✎</span>
          </button>
        </header>

        {/* Not in a room: create / join */}
        {!room?.code && (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row">
              <label>Room name</label>
              <input
                placeholder="Optional"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
              />
            </div>
            <div className="row">
              <label>PIN</label>
              <input
                placeholder="4–6 digits (optional)"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </div>
            <div className="row">
              <button className="btn primary" onClick={createRoom}>Create</button>
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
              <button className="btn" onClick={joinRoom}>Join</button>
            </div>

            <div className="hint">
              Rooms auto-delete after being empty for a while. Share the code (and PIN if set).
            </div>
          </>
        )}

        {/* In a room */}
        {room?.code && (
          <>
            <div className="row">
              <div className="inroom">
                In room: <b>{room.name || "Room"}</b>{" "}
                <span className="mono">({room.code})</span>
                <button className="link" onClick={copyInvite}>Copy invite</button>
                <button className="link" onClick={leaveRoom}>Leave</button>
              </div>
            </div>

            {/* Call controls */}
            <div className="row callbar">
              {/* Host controls */}
              {isHost && !inCall && (
                <button
                  className="btn primary"
                  onClick={startCallHost}
                  disabled={starting}
                >
                  {starting ? "Starting…" : "Start call"}
                </button>
              )}

              {/* Guest controls */}
              {!isHost && (
                <button
                  className="btn primary"
                  onClick={joinCallGuest}
                  disabled={inCall || !room.live}
                >
                  Join call
                </button>
              )}

              <button className="btn" onClick={toggleMute} disabled={!inCall}>
                {muted ? "Unmute" : "Mute"}
              </button>
              <button
                className="btn"
                onClick={toggleVideo}
                disabled={!inCall || voiceOnly}
              >
                {videoOff ? "Camera On" : "Camera Off"}
              </button>

              {isHost && (
                <button className="btn" onClick={toggleLock}>
                  {room.locked ? "Unlock room" : "Lock room"}
                </button>
              )}
              {isHost && inCall && (
                <button className="btn danger" onClick={endForAll}>
                  End call for all
                </button>
              )}

              <label className="chk">
                <input
                  type="checkbox"
                  checked={voiceOnly}
                  onChange={(e) => e && setVoiceOnly(e.target.checked)}
                />
                <span>Voice only</span>
              </label>
            </div>

            {!isHost && !room.live && (
              <div className="hint">Waiting for host to start the call…</div>
            )}

            {/* Media area */}
            <div className="media single">
              <div className="remotePane">
                <video ref={remoteRef} autoPlay playsInline />
                <video ref={localRef} autoPlay playsInline muted className="pip" />
              </div>
            </div>
          </>
        )}

        {/* Messages */}
        <div className="msgs" ref={msgsRef}>
          {msgs.length === 0 ? (
            <div className="muted">No messages yet. Say hi! 👋</div>
          ) : (
            msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.sys ? "sys" : ""}`}>
                {m.sys ? (
                  <div className="text">{m.text}</div>
                ) : (
                  <>
                    <div className="meta">
                      <span className="who">{m.name}</span>
                      <span className="ts">
                        {new Date(m.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text">{m.text}</div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        {/* Send box */}
        <SendBox
          disabled={!room?.code}
          onSend={(text) => {
            const t = String(text || "").trim();
            if (!t) return;
            const msg = { name: me, text: t, ts: Date.now() };
            socketRef.current?.emit("chat", msg);
            addMsg(msg);
          }}
        />
      </div>
    </div>
  );
} // <-- closes App()


// =========================
// Section 6 — SendBox
// =========================
function SendBox({ disabled, onSend }) {
  const [text, setText] = useState("");

  const send = () => {
    const t = (text || "").trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

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
            send();
          }
        }}
      />
      <button className="btn primary" disabled={disabled} onClick={send}>
        Send
      </button>
    </div>
  );
}
