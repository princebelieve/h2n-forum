import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

/* --------------------------
   Config
--------------------------- */
// Accept either name (use whichever you already set)
const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL ||
    import.meta.env.VITE_API_URL ||
    "").split(",")[0].trim();

const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

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

/* --------------------------
   App
--------------------------- */
export default function App() {
  /* sockets */
  const socketRef = useRef(null);

  /* identity */
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");
  const [connected, setConnected] = useState(false);
  const [showNameEdit, setShowNameEdit] = useState(false);
  const [nameDraft, setNameDraft] = useState(me);

  /* room/lobby */
  const [room, setRoom] = useState(null); // { code, name, locked, hostId, requiresPin }
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");
  const isHost = useMemo(
    () => !!room && socketRef.current && room.hostId === socketRef.current.id,
    [room, socketRef.current?.id]
  );

  /* chat */
  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);
  const addMsg = (m) =>
    setMsgs((p) => (p.length > 199 ? [...p.slice(-199), m] : [...p, m]));
  const [text, setText] = useState("");

  /* media + call */
  const localVideoRef = useRef(null);
  const ringInRef = useRef(null);
  const ringBackRef = useRef(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [status, setStatus] = useState("");
  const [net, setNet] = useState("Idle");

  // Mesh state: one RTCPeerConnection per peerId
  const pcsRef = useRef(new Map());               // peerId -> RTCPeerConnection
  const remMediaRef = useRef(new Map());          // peerId -> MediaStream
  const [peers, setPeers] = useState([]);         // [{peerId}]
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  // UI: swap & fit
  const [mainVideo, setMainVideo] = useState("remote"); // "remote" or "local"
  const [videoFitContain, setVideoFitContain] = useState(true);

  // helpers
  const localStreamRef = useRef(null);
  const offerWatchdog = useRef(null);

  const updatePeersView = () => {
    setPeers(Array.from(remMediaRef.current.keys()).map((peerId) => ({ peerId })));
  };

  /* --------------------------
     Audio unlock (tones)
  --------------------------- */
  useEffect(() => {
    const once = async () => {
      if (audioUnlocked) return;
      try {
        if (ringInRef.current) {
          await ringInRef.current.play().catch(() => {});
          ringInRef.current.pause();
          ringInRef.current.currentTime = 0;
        }
        if (ringBackRef.current) {
          await ringBackRef.current.play().catch(() => {});
          ringBackRef.current.pause();
          ringBackRef.current.currentTime = 0;
        }
        setAudioUnlocked(true);
      } catch {}
    };
    const evts = ["pointerdown", "keydown"];
    evts.forEach((e) => window.addEventListener(e, once, { once: true }));
    return () => evts.forEach((e) => window.removeEventListener(e, once));
  }, [audioUnlocked]);

  /* --------------------------
     Socket setup
  --------------------------- */
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("hello", me);
    });
    s.on("disconnect", () => setConnected(false));

    // Chat
    s.on("chat", (m) => addMsg(m));

    // Room updates from server (lock, host changes, etc.)
    s.on("room:update", (r) => setRoom((prev) => ({ ...(prev || {}), ...r })));

    // Mesh signaling hooks
    s.on("rtc:peer-joined", ({ peerId }) => {
      // Someone else joined the call room; create outbound offer if we’re already inCall
      if (inCall && room?.code) makeOfferTo(peerId);
    });
    s.on("rtc:peer-left", ({ peerId }) => {
      try {
        pcsRef.current.get(peerId)?.close();
      } catch {}
      pcsRef.current.delete(peerId);
      remMediaRef.current.delete(peerId);
      updatePeersView();
    });
    s.on("rtc:offer", async ({ from, offer }) => {
      // Prepare local if not already
      await ensureLocal(voiceOnly ? "audio" : "video");
      const pc = ensurePC(from);
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit("rtc:answer", { roomId: room?.code, answer });
    });
    s.on("rtc:answer", async ({ from, answer }) => {
      try {
        await pcsRef.current.get(from)?.setRemoteDescription(answer);
      } catch {}
    });
    s.on("rtc:ice", async ({ from, candidate }) => {
      try {
        if (candidate) await pcsRef.current.get(from)?.addIceCandidate(candidate);
      } catch {}
    });

    // Host actions
    s.on("call:endall", () => leaveCall());
    s.on("mute:all", () => {
      const tracks = localStreamRef.current?.getAudioTracks?.() || [];
      tracks.forEach((t) => (t.enabled = false));
      setMuted(true);
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep name persisted + tell server
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // prefill join via URL (?room=&pin=)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("room");
    const p = q.get("pin");
    if (code) setJoinCode(code);
    if (p) setJoinPin(p);
  }, []);

  // autoscroll chat
  useEffect(() => {
    msgsRef.current?.scrollTo({
      top: msgsRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [msgs]);

  /* --------------------------
     Room actions
  --------------------------- */
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) return addMsg({ sys: true, ts: Date.now(), text: "Create failed" });
      setRoom(res.room); // room: { code,name,requiresPin,hostId,locked? }
      setJoinCode(res.room.code);
      addMsg({ sys: true, ts: Date.now(), text: `Created room: ${res.room.name} (${res.room.code})` });
    });
  };

  const joinRoom = () => {
    socketRef.current?.emit("join-room", { code: joinCode.trim(), pin: joinPin.trim() }, (res) => {
      if (!res?.ok) {
        return addMsg({ sys: true, ts: Date.now(), text: `Join failed: ${res?.error || "unknown"}` });
      }
      setRoom(res.room);
      addMsg({ sys: true, ts: Date.now(), text: `Joined room: ${res.room.name} (${res.room.code})` });
    });
  };

  const leaveRoom = () => {
    socketRef.current?.emit("leave-room");
    setRoom(null);
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
    leaveCall();
  };

  /* --------------------------
     Chat
  --------------------------- */
  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    const mine = { name: me, ts: Date.now(), text: t };
    addMsg(mine);
    socketRef.current?.emit("chat", t);
    setText("");
  };

  /* --------------------------
     WebRTC helpers (mesh)
  --------------------------- */
  const ensurePC = (peerId) => {
    let pc = pcsRef.current.get(peerId);
    if (pc) return pc;

    pc = new RTCPeerConnection(ICE);
    pcsRef.current.set(peerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current?.emit("rtc:ice", {
          roomId: room?.code,
          candidate: e.candidate,
          to: peerId,
        });
      }
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") setNet("Connected");
      else if (s === "checking") setNet("Connecting");
      else if (s === "failed" || s === "disconnected") setNet("Reconnecting");
    };
    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        // drop remote on hard fail
        pcsRef.current.delete(peerId);
        remMediaRef.current.delete(peerId);
        updatePeersView();
      }
    };
    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (!ms) return;
      remMediaRef.current.set(peerId, ms);
      updatePeersView();
    };

    // Attach local tracks if we have them
    const ls = localStreamRef.current;
    if (ls) ls.getTracks().forEach((t) => pc.addTrack(t, ls));
    return pc;
  };

  const ensureLocal = async (kind) => {
    if (localStreamRef.current) return localStreamRef.current;
    const constraints = kind === "audio" ? AUDIO_ONLY : LOW_VIDEO;
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    return stream;
  };

  const makeOfferTo = async (peerId) => {
    try {
      const pc = ensurePC(peerId);
      // prepare local if not ready
      await ensureLocal(voiceOnly ? "audio" : "video");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("rtc:offer", { roomId: room?.code, offer, to: peerId });
    } catch (e) {
      console.error(e);
    }
  };

  /* --------------------------
     Call controls
  --------------------------- */
  const startCallHost = async () => {
    if (!isHost || !room?.code) return;
    setStarting(true);
    setStatus("Starting call…");
    try {
      await ensureLocal(voiceOnly ? "audio" : "video");

      // Join the room’s “call channel” (same code) so we receive rtc:peer-joined
      socketRef.current.emit("rtc:join", { roomId: room.code });

      // Create offers to everyone already in the room
      const { sockets } = await socketRef.current.emitWithAck?.("room:list-peers", { roomId: room.code }).catch(() => ({ sockets: [] })) || {};
      (sockets || [])
        .filter((id) => id !== socketRef.current.id)
        .forEach((id) => makeOfferTo(id));

      try { await ringBackRef.current?.play(); } catch {}
      setInCall(true);
      setStarting(false);
      setStatus("");
    } catch (e) {
      console.error(e);
      setStarting(false);
      setStatus("Failed to start");
    }
  };

  const joinCallGuest = async () => {
    if (!room?.code) return;
    setStarting(true);
    setStatus("Joining…");
    try {
      await ensureLocal(voiceOnly ? "audio" : "video");
      socketRef.current.emit("rtc:join", { roomId: room.code });
      setInCall(true);
      setStarting(false);
      setStatus("");
    } catch (e) {
      console.error(e);
      setStarting(false);
      setStatus("Failed to join");
    }
  };

  const leaveCall = () => {
    try { ringBackRef.current?.pause(); } catch {}
    setInCall(false);
    setStarting(false);
    setStatus("");
    setNet("Idle");
    setMuted(false);
    setVideoOff(false);
    setMainVideo("remote");

    // close pcs
    pcsRef.current.forEach((pc) => { try { pc.close(); } catch {} });
    pcsRef.current.clear();
    remMediaRef.current.clear();
    updatePeersView();

    // stop local
    const s = localStreamRef.current;
    if (s) { s.getTracks().forEach((t) => t.stop()); }
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;

    socketRef.current?.emit("rtc:leave", { roomId: room?.code });
  };

  const toggleMute = () => {
    const tracks = localStreamRef.current?.getAudioTracks?.() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setMuted((v) => !v);
  };
  const toggleVideo = () => {
    const tracks = localStreamRef.current?.getVideoTracks?.() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setVideoOff((v) => !v);
  };

  // Host-only controls (no-ops if server doesn’t support, but safe to emit)
  const lockRoom = () => socketRef.current.emit("room:lock", { roomId: room?.code, lock: !room?.locked });
  const muteAll = () => socketRef.current.emit("mute:all", { roomId: room?.code });
  const endCallAll = () => { socketRef.current.emit("call:endall", { roomId: room?.code }); leaveCall(); };

  const copyInvite = async () => {
    if (!room?.code) return;
    const url = new URL(location.href);
    url.searchParams.set("room", room.code);
    if (room?.requiresPin) url.searchParams.set("pin", pin || "");
    await navigator.clipboard.writeText(url.toString());
    setStatus("Invite link copied");
  };

  /* --------------------------
     Render helpers
  --------------------------- */
  const callButton = (() => {
    if (!room) return null;
    if (inCall) {
      return (
        <button className="btn danger" onClick={leaveCall}>
          Leave call
        </button>
      );
    }
    if (isHost) {
      return (
        <button className="btn primary" disabled={starting} onClick={startCallHost}>
          {starting ? "Starting…" : "Start call"}
        </button>
      );
    }
    return (
      <button className="btn primary" disabled={starting} onClick={joinCallGuest}>
        {starting ? "Joining…" : "Join call"}
      </button>
    );
  })();

  return (
    <div className="shell">
      {/* hidden ring sounds */}
      <audio ref={ringInRef} src="/sounds/incoming.mp3" loop />
      <audio ref={ringBackRef} src="/sounds/ringback.mp3" loop />

      <div className="glass">
        <header className="head">
          <h1>{isHost ? "H2N Forum — Host" : "H2N Forum"}</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>

          <button
            className="chip"
            onClick={() => { setShowNameEdit((v) => !v); setNameDraft(me); }}
            title="Edit your display name"
          >
            <span className="chip-label">You:</span>
            <b className="chip-name">{me}</b>
            {isHost && <span className="badge-host">Host</span>}
            <span className="chip-edit">✎</span>
          </button>

          {showNameEdit && (
            <div className="name-pop">
              <div className="name-row">
                <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
              </div>
              <div className="name-actions">
                <button className="btn" onClick={() => setShowNameEdit(false)}>Cancel</button>
                <button
                  className="btn primary"
                  onClick={() => { setMe(nameDraft.trim() || "Me"); setShowNameEdit(false); }}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </header>

        {/* LOBBY (not in a room) */}
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
              <button className="btn primary" onClick={createRoom}>Create room</button>
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
              <button className="btn" onClick={joinRoom}>Join room</button>
            </div>

            <div className="hint">
              Rooms auto-delete after being empty for a while. Share the code (and PIN if set).
            </div>
          </>
        )}

        {/* IN ROOM */}
        {room && (
          <>
            <div className="row">
              <div className="inroom">
                In room: <b>{room.name}</b>{" "}
                <span className="mono">({room.code})</span>
                <button className="btn ghost" onClick={copyInvite}>Copy invite</button>
                <button className="link" onClick={leaveRoom}>Leave</button>
              </div>
            </div>

            {/* host/guest call controls */}
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

              {callButton}

              <button className="btn" onClick={toggleMute} disabled={!inCall}>
                {muted ? "Unmute" : "Mute"}
              </button>
              <button className="btn" onClick={toggleVideo} disabled={!inCall || voiceOnly}>
                {videoOff ? "Camera On" : "Camera Off"}
              </button>

              {isHost && (
                <>
                  <button className="btn" onClick={lockRoom}>
                    {room?.locked ? "Unlock room" : "Lock room"}
                  </button>
                  <button className="btn" onClick={muteAll} disabled={!inCall}>
                    Mute all
                  </button>
                  <button className="btn danger" onClick={endCallAll}>
                    End call for all
                  </button>
                </>
              )}
            </div>

            {/* waiting message for guests when not in a call yet */}
            {!isHost && !inCall && (
              <div className="banner-wait">
                Waiting for the host to start the call. You’ll be able to <b>Join call</b> once it starts.
              </div>
            )}

            {status && <div className="hint">{status}</div>}

            {/* MEDIA AREA
                - local video always rendered
                - remote peers show as first big tile + small tiles (pip-like) */}
            {!voiceOnly && (
              <div className="media single">
                <div className="remotePane">
                  {/* main tile: if any peer streams exist, show the first one; else show local */}
                  <VideoTile
                    stream={
                      remMediaRef.current.size
                        ? remMediaRef.current.values().next().value
                        : localStreamRef.current
                    }
                    main
                    fit={videoFitContain}
                    onClick={() => setMainVideo("remote")}
                    onDoubleClick={() => setVideoFitContain((v) => !v)}
                  />

                  {/* local pip */}
                  <VideoTile
                    stream={localStreamRef.current}
                    pip
                    fit={videoFitContain}
                    onClick={() => setMainVideo("local")}
                    onDoubleClick={() => setVideoFitContain((v) => !v)}
                    refEl={localVideoRef}
                  />

                  {/* additional remote pips */}
                  {Array.from(remMediaRef.current.entries())
                    .slice(1) // first one is in the main tile
                    .map(([peerId, stream]) => (
                      <SmallPip key={peerId} stream={stream} />
                    ))}
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
          <button className="btn primary" onClick={sendChat}>Send</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------
   Small components
--------------------------- */
function VideoTile({ stream, main, pip, fit, onClick, onDoubleClick, refEl }) {
  const vref = useRef(null);
  useEffect(() => {
    const v = refEl || vref.current;
    if (v && stream && v.srcObject !== stream) v.srcObject = stream;
  }, [stream, refEl]);

  return (
    <video
      ref={refEl || vref}
      autoPlay
      playsInline
      muted={pip || !main} /* local/pip stays muted */
      className={
        pip
          ? "pip"
          : fit
          ? "fit"
          : ""
      }
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={pip ? undefined : { width: "100%" }}
    />
  );
}

function SmallPip({ stream }) {
  const vref = useRef(null);
  useEffect(() => {
    if (vref.current && stream && vref.current.srcObject !== stream) {
      vref.current.srcObject = stream;
    }
  }, [stream]);
  return <video ref={vref} autoPlay playsInline className="pip" />;
}
