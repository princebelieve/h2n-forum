import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

/* ---------- ENV ---------- */
const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "").split(",")[0].trim();

// STUN + optional TURN (from env)
const TURN_URLS = (import.meta.env.VITE_TURN_URLS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TURN_USER = import.meta.env.VITE_TURN_USER || "";
const TURN_CRED = import.meta.env.VITE_TURN_CRED || "";

const ICE = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] },
    ...(TURN_URLS.length
      ? [{ urls: TURN_URLS, username: TURN_USER, credential: TURN_CRED }]
      : [])
  ]
};

// media constraints
const AUDIO_ONLY = { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
const LOW_VIDEO = {
  audio: { echoCancellation: true, noiseSuppression: true },
  video: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { max: 15 }, facingMode: "user" },
};

export default function App() {
  /* sockets / rtc */
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  /* media els */
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  /* sounds */
  const ringInRef = useRef(null);
  const ringBackRef = useRef(null);

  /* identity / connection */
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");

  /* rooms + chat */
  const [room, setRoom] = useState(null); // {code,name,hostId,locked,live}
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");
  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);

  /* call state */
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [status, setStatus] = useState("");

  /* ui video */
  const [mainVideo, setMainVideo] = useState("remote");
  const [videoFitContain, setVideoFitContain] = useState(true);

  /* helpers */
  const addMsg = (m) => setMsgs((p) => (p.length > 199 ? [...p.slice(-199), m] : [...p, m]));
  const isHost = !!room && !!socketId && room.hostId === socketId;

  /* unlock audio on first gesture */
  useEffect(() => {
    const once = async () => {
      try {
        for (const a of [ringInRef.current, ringBackRef.current]) {
          if (!a) continue;
          await a.play().catch(() => {});
          a.pause(); a.currentTime = 0;
        }
      } catch {}
    };
    const evts = ["pointerdown","keydown"];
    evts.forEach((e)=>window.addEventListener(e, once, { once:true }));
    return ()=>evts.forEach((e)=>window.removeEventListener(e, once));
  }, []);

  /* socket setup */
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
    socketRef.current = s;

    s.on("connect", () => { setConnected(true); setSocketId(s.id); s.emit("hello", me); });
    s.on("disconnect", () => setConnected(false));
    s.io.on("reconnect", () => setSocketId(s.id));

    // room updates
    s.on("room:live", (live) => setRoom((r) => (r ? { ...r, live } : r)));
    s.on("room:locked", (locked) => setRoom((r) => (r ? { ...r, locked } : r)));

    // chat
    s.on("chat", (m) => addMsg(m));

    // signaling (broadcast from host)
    s.on("rtc:offer", async ({ from, offer }) => {
      if (pcRef.current) return; // already answered
      try {
        const kind = voiceOnly ? "audio" : "video";
        const pc = setupPC();
        const ms = await getStream(kind);
        ms.getTracks().forEach((t) => pc.addTrack(t, ms));

        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // if host sent a room-broadcast offer, answer goes to host
        s.emit("rtc:answer", { answer, targetId: from || room?.hostId });
        setInCall(true);
      } catch (e) {
        console.error(e);
      }
    });

    // targeted offer (late join)
    s.on("rtc:offer-to", async ({ from, offer }) => {
      if (pcRef.current) return;
      try {
        const kind = voiceOnly ? "audio" : "video";
        const pc = setupPC();
        const ms = await getStream(kind);
        ms.getTracks().forEach((t) => pc.addTrack(t, ms));

        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        s.emit("rtc:answer-to", { answer, targetId: from });
        setInCall(true);
      } catch (e) { console.error(e); }
    });

    s.on("rtc:answer", async ({ answer }) => {
      try { await pcRef.current?.setRemoteDescription(answer); } catch {}
    });

    s.on("rtc:answer-to", async ({ answer }) => {
      try { await pcRef.current?.setRemoteDescription(answer); } catch {}
    });

    s.on("rtc:ice", async ({ candidate }) => {
      if (candidate) { try { await pcRef.current?.addIceCandidate(candidate); } catch {} }
    });

    s.on("rtc:ice-to", async ({ candidate }) => {
      if (candidate) { try { await pcRef.current?.addIceCandidate(candidate); } catch {} }
    });

    s.on("end-call", () => { leaveCall(); });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* persist name + re-hello */
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  /* prefill via URL */
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("room");
    const p = q.get("pin");
    if (code) setJoinCode(code);
    if (p) setJoinPin(p);
  }, []);

  /* auto scroll chat */
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  /* ---------- RTC helpers ---------- */
  const setupPC = () => {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const payload = { candidate: e.candidate };
      if (isHost && targetPeer.current) {
        socketRef.current?.emit("rtc:ice-to", { ...payload, targetId: targetPeer.current });
      } else if (!isHost) {
        socketRef.current?.emit("rtc:ice", payload);
      } else {
        // host during broadcast start
        socketRef.current?.emit("rtc:ice", payload);
      }
    };

    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (remoteRef.current && ms) remoteRef.current.srcObject = ms;
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (["disconnected","failed","closed"].includes(s)) leaveCall();
    };

    return pc;
  };

  const getStream = async (kind) => {
    const c = kind === "audio" ? AUDIO_ONLY : LOW_VIDEO;
    const ms = await navigator.mediaDevices.getUserMedia(c);
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  };

  /* ---------- Rooms ---------- */
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) { addMsg({ sys:true, ts:Date.now(), text:"Create failed" }); return; }
      setRoom(res.room);
      addMsg({ sys:true, ts:Date.now(), text:`Created room: ${res.room.name} (${res.room.code})` });
      setStatus("");
    });
  };

  const joinRoom = () => {
    socketRef.current?.emit("join-room", { code: joinCode.trim(), pin: joinPin.trim() }, (res) => {
      if (!res?.ok) { addMsg({ sys:true, ts:Date.now(), text:`Join failed: ${res?.error || ""}` }); return; }
      setRoom(res.room);
      addMsg({ sys:true, ts:Date.now(), text:`Joined room: ${res.room.name} (${res.room.code})` });
      setStatus("");
    });
  };

  const leaveRoom = () => {
    socketRef.current?.emit("leave-room");
    setRoom(null);
    leaveCall();
    addMsg({ sys:true, ts:Date.now(), text:"Left room" });
  };

  /* ---------- Host controls ---------- */
  const toggleLock = () => {
    if (!isHost) return;
    socketRef.current?.emit("room:lock", !room.locked, (res) => {
      if (res?.ok) setRoom((r)=>({ ...r, locked: res.locked }));
    });
  };

  const startCallHost = async () => {
    if (!isHost || inCall || !room) return;
    setStarting(true);
    try {
      await new Promise((resolve)=>socketRef.current?.emit("room:live", true, resolve));

      const kind = voiceOnly ? "audio" : "video";
      const pc = setupPC();
      const ms = await getStream(kind);
      ms.getTracks().forEach((t)=>pc.addTrack(t, ms));

      try { await ringBackRef.current?.play(); } catch {}
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // broadcast offer to everyone currently in room
      socketRef.current?.emit("rtc:offer", { offer });

      setInCall(true);
      setStatus("");
    } catch (e) {
      console.error(e);
    } finally { setStarting(false); }
  };

  const endForAll = () => {
    if (!isHost || !room) return;
    socketRef.current?.emit("end-for-all", () => {});
    leaveCall();
  };

  /* ---------- Guest join ---------- */

  // store a target peer id when the host is answering a specific guest
  const targetPeer = useRef(null);

  const joinCallGuest = async () => {
    if (inCall || !room) return;

    // If host already live, request a *targeted* offer.
    if (room.live) {
      socketRef.current?.emit("rtc:need-offer", {}); // server will ping host with our socket id
      setStatus("Requesting to join…");
    } else {
      setStatus("Waiting for host to start the call…");
    }

    // pre-warm permissions
    try {
      const kind = voiceOnly ? "audio" : "video";
      const ms = await navigator.mediaDevices.getUserMedia(kind === "audio" ? AUDIO_ONLY : LOW_VIDEO);
      ms.getTracks().forEach((t)=>t.stop());
    } catch {}
  };

  // host receives a request and sends a targeted offer back
  useEffect(() => {
    if (!socketRef.current) return;

    const onNeedOffer = async ({ peerId }) => {
      if (!isHost || !room?.live) return;
      try {
        targetPeer.current = peerId;

        const pc = pcRef.current || setupPC();
        if (!pcRef.current) {
          const kind = voiceOnly ? "audio" : "video";
          const ms = await getStream(kind);
          ms.getTracks().forEach((t)=>pc.addTrack(t, ms));
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socketRef.current.emit("rtc:offer-to", { offer, targetId: peerId });
      } catch (e) { console.error(e); }
    };

    socketRef.current.on("rtc:need-offer", onNeedOffer);
    return () => socketRef.current?.off("rtc:need-offer", onNeedOffer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, room?.live]);

  /* ---------- Call common ---------- */
  const leaveCall = () => {
    try {
      pcRef.current?.getSenders?.().forEach((s)=>s.track && s.track.stop());
    } catch {}
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    targetPeer.current = null;
    if (localRef.current?.srcObject) {
      localRef.current.srcObject.getTracks().forEach(t=>t.stop());
      localRef.current.srcObject = null;
    }
    if (remoteRef.current?.srcObject) remoteRef.current.srcObject = null;

    setInCall(false);
    setStarting(false);
    setMuted(false);
    setVideoOff(false);
    setMainVideo("remote");
    setStatus("");
    try { ringBackRef.current?.pause(); ringBackRef.current.currentTime = 0; } catch {}
    try { ringInRef.current?.pause(); ringInRef.current.currentTime = 0; } catch {}
  };

  const toggleMute = () => {
    const tracks = localRef.current?.srcObject?.getAudioTracks?.() || [];
    tracks.forEach((t)=>t.enabled = !t.enabled);
    setMuted((v)=>!v);
  };
  const toggleVideo = () => {
    const tracks = localRef.current?.srcObject?.getVideoTracks?.() || [];
    tracks.forEach((t)=>t.enabled = !t.enabled);
    setVideoOff((v)=>!v);
  };

  const copyInvite = async () => {
    if (!room?.code) return;
    const url = new URL(location.href);
    url.searchParams.set("room", room.code);
    if (room?.requiresPin) url.searchParams.set("pin", pin || "");
    await navigator.clipboard.writeText(url.toString());
    setStatus("Invite link copied");
  };

  const callButtonLabel = isHost
    ? (starting ? "Starting…" : inCall ? "End call for all" : "Start call")
    : (inCall ? "Leave call" : "Join call");

  /* ---------- UI ---------- */
  return (
    <div className="shell">
      <audio ref={ringInRef} src="/sounds/incoming.mp3" loop />
      <audio ref={ringBackRef} src="/sounds/ringback.mp3" loop />

      <div className="glass">
        <header className="head">
          <h1>H2N {isHost ? "Forum — Host" : "Forum"}</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>

          <button
            className="chip"
            onClick={() => {
              const v = prompt("Your display name", me);
              if (v != null) setMe((v.trim() || "Me").slice(0,40));
            }}
          >
            <span className="chip-label">You:</span>{" "}
            <b className="chip-name">{me}</b>{" "}
            <span className="chip-edit">✎</span>
          </button>
        </header>

        {!room && (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row">
              <input placeholder="Room name (optional)" value={roomName} onChange={(e)=>setRoomName(e.target.value)} />
              <input placeholder="PIN (4–6 digits, optional)" value={pin} onChange={(e)=>setPin(e.target.value)} />
              <button className="btn primary" onClick={createRoom}>Create Meeting</button>
            </div>

            <div className="row title right">Code + optional PIN</div>
            <div className="row">
              <input placeholder="6-digit code" value={joinCode} onChange={(e)=>setJoinCode(e.target.value)} />
              <input placeholder="PIN (if required)" value={joinPin} onChange={(e)=>setJoinPin(e.target.value)} />
              <button className="btn" onClick={joinRoom}>Join</button>
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
                In room: <b>{room.name}</b> <span className="mono">({room.code})</span>
                <button className="link" onClick={copyInvite}>Copy invite</button>
                <button className="link" onClick={leaveRoom}>Leave</button>
              </div>
            </div>

            <div className="row callbar">
              {!isHost && (
                <label className="chk">
                  <input type="checkbox" checked={voiceOnly} onChange={(e)=>setVoiceOnly(e.target.checked)} />
                  <span>Voice only</span>
                </label>
              )}

              {isHost ? (
                <>
                  <button className={`btn ${inCall ? "danger" : "primary"}`}
                          onClick={inCall ? endForAll : startCallHost}
                          disabled={!connected || starting}>
                    {callButtonLabel}
                  </button>
                  <button className="btn" onClick={toggleMute} disabled={!inCall}>{muted ? "Unmute" : "Mute"}</button>
                  <button className="btn" onClick={toggleVideo} disabled={!inCall || voiceOnly}>
                    {videoOff ? "Camera On" : "Camera Off"}
                  </button>
                  <button className="btn" onClick={toggleLock}>{room?.locked ? "Unlock room" : "Lock room"}</button>
                </>
              ) : (
                <>
                  <button className={`btn ${inCall ? "danger" : "primary"}`}
                          onClick={inCall ? leaveCall : joinCallGuest}
                          disabled={!connected}>
                    {callButtonLabel}
                  </button>
                  <button className="btn" onClick={toggleMute} disabled={!inCall}>{muted ? "Unmute" : "Mute"}</button>
                  <button className="btn" onClick={toggleVideo} disabled={!inCall || voiceOnly}>
                    {videoOff ? "Camera On" : "Camera Off"}
                  </button>
                </>
              )}
            </div>
            {status && <div className="hint">{status}</div>}

            {!voiceOnly && (
              <div className="media single">
                <div className="remotePane">
                  <video
                    ref={remoteRef}
                    autoPlay
                    playsInline
                    className={mainVideo === "remote" ? (videoFitContain ? "fit" : "") : "pip"}
                    onClick={() => setMainVideo("remote")}
                    onDoubleClick={() => setVideoFitContain((v) => !v)}
                  />
                  <video
                    ref={localRef}
                    autoPlay
                    playsInline
                    muted
                    className={mainVideo === "local" ? (videoFitContain ? "fit" : "") : "pip"}
                    onClick={() => setMainVideo("local")}
                    onDoubleClick={() => setVideoFitContain((v) => !v)}
                  />
                </div>
              </div>
            )}
          </>
        )}

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
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const t = e.currentTarget.value.trim();
                if (!t) return;
                addMsg({ name: me, ts: Date.now(), text: t });
                socketRef.current?.emit("chat", t);
                e.currentTarget.value = "";
              }
            }}
          />
          <button className="btn primary" onClick={() => {}}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
