import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

/* ---------- Config ---------- */
const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "").split(",")[0].trim();
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
  /* sockets */
  const socketRef = useRef(null);

  /* peer connections (mesh) */
  const pcsRef = useRef(new Map());           // peerId -> RTCPeerConnection
  const remoteStreamsRef = useRef(new Map()); // peerId -> MediaStream

  /* media elements */
  const localRef = useRef(null);
  const mainRemoteRef = useRef(null);

  /* sounds */
  const ringInRef = useRef(null);
  const ringBackRef = useRef(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  /* identity + connection */
  const [connected, setConnected] = useState(false);
  const [myId, setMyId] = useState("");
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");
  const [showNameEdit, setShowNameEdit] = useState(false);
  const [nameDraft, setNameDraft] = useState(me);

  /* rooms + chat */
  const [room, setRoom] = useState(null); // { code,name,requiresPin, ownerId, locked }
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");
  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);
  const [text, setText] = useState("");
  const dedupeMapRef = useRef(new Map()); // name|text -> ts

  /* call state */
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [calling, setCalling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [incoming, setIncoming] = useState(null); // { from, kind, sdp }
  const [status, setStatus] = useState("");
  const [net, setNet] = useState("Idle");

  /* ui */
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [mainVideo, setMainVideo] = useState("remote");
  const [videoFitContain, setVideoFitContain] = useState(true);

  /* peers list for UI */
  const [peerIds, setPeerIds] = useState([]); // remote peer ids we know about

  /* timers */
  const offerTimeoutRef = useRef(null);
  const offerBackupRef = useRef(null);

  const isHost = !!room && myId && room.ownerId === myId;

  /* ---------- helpers ---------- */
  const addMsg = (m) =>
    setMsgs((p) => (p.length > 199 ? [...p.slice(-199), m] : [...p, m]));

  const seenRecently = (m) => {
    if (!m?.name || !m?.text) return false;
    const key = `${m.name}|${m.text}`;
    const now = Date.now();
    const t = dedupeMapRef.current.get(key);
    if (t && now - t < 5000) return true;
    dedupeMapRef.current.set(key, now);
    if (dedupeMapRef.current.size > 200) {
      const cutoff = now - 60000;
      for (const [k, ts] of dedupeMapRef.current) if (ts < cutoff) dedupeMapRef.current.delete(k);
    }
    return false;
  };

  const stopRings = () => {
    for (const a of [ringInRef.current, ringBackRef.current]) {
      if (!a) continue;
      try { a.pause(); a.currentTime = 0; } catch {}
    }
  };

  /* ---------- unlock audio once ---------- */
  useEffect(() => {
    const once = async () => {
      if (audioUnlocked) return;
      try {
        for (const a of [ringInRef.current, ringBackRef.current]) {
          if (!a) continue;
          await a.play().catch(() => {});
          a.pause(); a.currentTime = 0;
        }
        setAudioUnlocked(true);
      } catch {}
    };
    const evts = ["pointerdown", "keydown"];
    evts.forEach((e) => window.addEventListener(e, once, { once: true }));
    return () => evts.forEach((e) => window.removeEventListener(e, once));
  }, [audioUnlocked]);

  /* ---------- sockets ---------- */
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("hello", me);
    });
    s.on("disconnect", () => setConnected(false));

    s.on("welcome", ({ id }) => setMyId(id));

    // chat
    s.on("chat", (m) => { if (!seenRecently(m)) addMsg(m); });

    // presence
    s.on("rtc:peer-joined", ({ peerId }) => {
      setPeerIds((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]));
    });
    s.on("rtc:peer-left", ({ peerId }) => {
      cleanupPeer(peerId);
    });

    // moderation
    s.on("room:locked", ({ locked }) => {
      setRoom((r) => (r ? { ...r, locked } : r));
      addMsg({ sys: true, ts: Date.now(), text: locked ? "Host locked the room" : "Host unlocked the room" });
    });
    s.on("moderation:mute", () => {
      // mute local mic
      const tracks = localRef.current?.srcObject?.getAudioTracks?.() || [];
      tracks.forEach((t) => (t.enabled = false));
      setMuted(true);
      addMsg({ sys: true, ts: Date.now(), text: "Host muted everyone" });
    });
    s.on("moderation:endcall", () => {
      addMsg({ sys: true, ts: Date.now(), text: "Host ended the call" });
      hangUp();
    });
    s.on("moderation:kicked", ({ reason }) => {
      addMsg({ sys: true, ts: Date.now(), text: reason || "Removed by host" });
      leaveRoom();
    });

    // signaling
    s.on("rtc:offer", async ({ from, offer, kind = "video" }) => {
      setIncoming({ from, kind, sdp: offer });
      try { await ringInRef.current?.play(); } catch {}
    });

    s.on("rtc:answer", async ({ from, answer }) => {
      const pc = pcsRef.current.get(from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(answer);
      } finally {
        clearTimeout(offerTimeoutRef.current);
        clearTimeout(offerBackupRef.current);
      }
    });

    s.on("rtc:ice", async ({ from, candidate }) => {
      const pc = pcsRef.current.get(from);
      if (pc && candidate) {
        try { await pc.addIceCandidate(candidate); } catch {}
      }
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* persist name */
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  /* prefill join via URL */
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("room");
    const p = q.get("pin");
    if (code) setJoinCode(code);
    if (p) setJoinPin(p);
  }, []);

  /* auto-scroll chat */
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  /* ---------- room actions ---------- */
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) {
        addMsg({ sys: true, ts: Date.now(), text: `Create failed: ${res?.error || "unknown"}` });
        return;
      }
      setRoom(res.room);
      setJoinCode(res.room.code);
      addMsg({ sys: true, ts: Date.now(), text: `Created room: ${res.room.name} (${res.room.code})` });
    });
  };

  const joinRoom = () => {
    socketRef.current?.emit(
      "join-room",
      { code: joinCode.trim(), pin: joinPin.trim() },
      (res) => {
        if (!res?.ok) {
          addMsg({ sys: true, ts: Date.now(), text: `Join failed: ${res?.error || "unknown"}` });
          return;
        }
        setRoom(res.room);
        addMsg({ sys: true, ts: Date.now(), text: `Joined room: ${res.room.name} (${res.room.code})` });
      }
    );
  };

  const leaveRoom = () => {
    socketRef.current?.emit("leave-room");
    setRoom(null);
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
    hangUp();
    setPeerIds([]);
  };

  /* ---------- media / webrtc ---------- */
  const getStream = async (kind) => {
    const c = kind === "audio" ? AUDIO_ONLY : LOW_VIDEO;
    const ms = await navigator.mediaDevices.getUserMedia(c);
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  };

  const makePC = (peerId) => {
    const pc = new RTCPeerConnection(ICE);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current?.emit("rtc:ice", {
          roomId: room?.code,
          to: peerId,
          candidate: e.candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        stopRings();
        setInCall(true);
        setCalling(false);
        setStarting(false);
        setNet("Connected");
        setStatus("");
        clearTimeout(offerTimeoutRef.current);
        clearTimeout(offerBackupRef.current);
      } else if (s === "checking") {
        setNet("Connecting");
      } else if (s === "disconnected" || s === "failed") {
        setNet("Reconnecting");
      }
    };

    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        cleanupPeer(peerId);
      }
    };

    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (!ms) return;
      remoteStreamsRef.current.set(peerId, ms);

      if (mainRemoteRef.current && !mainRemoteRef.current.srcObject) {
        mainRemoteRef.current.srcObject = ms;
      }
      setPeerIds((prev) => (prev.includes(peerId) ? [...prev] : [...prev, peerId]));
    };

    pcsRef.current.set(peerId, pc);
    return pc;
  };

  const cleanupPeer = (peerId) => {
    const pc = pcsRef.current.get(peerId);
    try { pc?.getSenders?.().forEach((s) => s.track && s.track.stop()); } catch {}
    try { pc?.close?.(); } catch {}
    pcsRef.current.delete(peerId);

    const ms = remoteStreamsRef.current.get(peerId);
    if (ms) { try { ms.getTracks().forEach((t) => t.stop()); } catch {} }
    remoteStreamsRef.current.delete(peerId);

    if (mainRemoteRef.current?.srcObject === ms) {
      mainRemoteRef.current.srcObject = null;
      for (const [, stream] of remoteStreamsRef.current) {
        mainRemoteRef.current.srcObject = stream; break;
      }
    }
    setPeerIds((list) => list.filter((id) => id !== peerId));
  };

  /* ---------- calling flow (mesh) ---------- */
  const preflight = async (kind) => {
    try {
      setStatus("Requesting mic/camera…");
      const t = await navigator.mediaDevices.getUserMedia(kind === "audio" ? AUDIO_ONLY : LOW_VIDEO);
      t.getTracks().forEach((x) => x.stop());
      return true;
    } catch {
      setStatus("Permission denied or device not available");
      return false;
    }
  };

  const startOfferTo = async (peerId, kind, ms) => {
    const pc = makePC(peerId);
    ms.getTracks().forEach((t) => pc.addTrack(t, ms));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socketRef.current?.emit("rtc:offer", { roomId: room.code, to: peerId, offer, kind });
  };

  const toggleCall = async () => {
    if (!room?.code) return;

    if (calling || inCall) { hangUp(); return; }

    const kind = voiceOnly ? "audio" : "video";
    setCalling(true);
    setStarting(true);

    try { await ringBackRef.current?.play(); } catch {}

    const ok = await preflight(kind);
    if (!ok) { setCalling(false); setStarting(false); return; }

    try {
      const ms = await getStream(kind);
      setStatus("Calling…"); setNet("Connecting");

      socketRef.current?.emit("rtc:join", { roomId: room.code });

      const others = peerIds.filter((id) => id !== myId);
      await Promise.all(others.map((pid) => startOfferTo(pid, kind, ms)));

      clearTimeout(offerTimeoutRef.current);
      clearTimeout(offerBackupRef.current);
      offerTimeoutRef.current = setTimeout(() => {
        if (!inCall) { stopRings(); setStatus("No answer"); addMsg({ sys: true, ts: Date.now(), text: "Call ended: no answer" }); hangUp(); }
      }, 20000);
      offerBackupRef.current = setTimeout(() => {
        if (!inCall) { stopRings(); setStatus("No answer"); addMsg({ sys: true, ts: Date.now(), text: "Call ended: no answer (backup)" }); hangUp(); }
      }, 35000);
    } catch (e) {
      console.error(e);
      setCalling(false); setStarting(false); setStatus(""); stopRings();
    }
  };

  const acceptIncoming = async () => {
    const inc = incoming;
    if (!inc) return;
    stopRings();
    setIncoming(null);

    try {
      setStatus("Answering…");
      const kind = inc.kind || "video";
      const ms = await getStream(kind);

      const pc = makePC(inc.from);
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      await pc.setRemoteDescription(inc.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current?.emit("rtc:answer", { roomId: room?.code, to: inc.from, answer });
      setNet("Connecting"); setStatus("Connecting…");
    } catch (e) {
      console.error(e);
      hangUp();
    }
  };

  const declineIncoming = () => {
    stopRings();
    setIncoming(null);
  };

  const hangUp = () => {
    stopRings();
    setCalling(false); setStarting(false); setInCall(false);
    setStatus(""); setNet("Idle");
    setMuted(false); setVideoOff(false); setMainVideo("remote");
    clearTimeout(offerTimeoutRef.current); clearTimeout(offerBackupRef.current);

    for (const pid of [...pcsRef.current.keys()]) cleanupPeer(pid);

    const s = localRef.current?.srcObject;
    if (s) { s.getTracks().forEach((t) => t.stop()); localRef.current.srcObject = null; }
    if (mainRemoteRef.current?.srcObject) mainRemoteRef.current.srcObject = null;

    socketRef.current?.emit("rtc:leave", { roomId: room?.code });
  };

  /* ---------- chat ---------- */
  const sendChat = () => {
    const t = text.trim(); if (!t) return;
    const mine = { name: me, ts: Date.now(), text: t };
    seenRecently(mine); addMsg(mine);
    socketRef.current?.emit("chat", t); setText("");
  };

  /* ---------- local controls ---------- */
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
    if (room?.requiresPin) url.searchParams.set("pin", pin || "");
    await navigator.clipboard.writeText(url.toString());
    setStatus("Invite link copied");
  };

  /* ---------- host actions ---------- */
  const hostLock = (on) => socketRef.current?.emit("host:lock", !!on, (res) => {
    if (!res?.ok) setStatus(res?.error || "Lock failed");
  });
  const hostMuteAll = () => socketRef.current?.emit("host:mute-all");
  const hostEndCall = () => socketRef.current?.emit("host:endcall");
  const hostKick = (peerId) => socketRef.current?.emit("host:kick", { peerId });

  const callButtonLabel = calling || inCall ? "End Call" : "Start Call";

  /* ---------- UI ---------- */
  return (
    <div className="shell">
      {/* hidden audio players */}
      <audio ref={ringInRef} src="/sounds/incoming.mp3" preload="auto" loop />
      <audio ref={ringBackRef} src="/sounds/ringback.mp3" preload="auto" loop />

      <div className="glass">
        <header className="head">
          <h1>H2N Forum {isHost ? "— Host" : ""}</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>

          <button className="chip" onClick={() => { setShowNameEdit((v) => !v); setNameDraft(me); }}>
            <span className="chip-label">You:</span><b className="chip-name">{me}</b><span className="chip-edit">✎</span>
          </button>

          {showNameEdit && (
            <div className="name-pop">
              <div className="name-row"><input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} /></div>
              <div className="name-actions">
                <button className="btn" onClick={() => setShowNameEdit(false)}>Cancel</button>
                <button className="btn primary" onClick={() => { setMe(nameDraft.trim() || "Me"); setShowNameEdit(false); }}>Save</button>
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
              <button className="btn primary" onClick={createRoom}>Create Meeting</button>
            </div>

            <div className="row title right">Code + optional PIN</div>
            <div className="row">
              <input placeholder="6-digit code" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
              <input placeholder="PIN (if required)" value={joinPin} onChange={(e) => setJoinPin(e.target.value)} />
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
                {room.locked && <span className="pill">Locked</span>}
                <button className="link" onClick={copyInvite}>Copy invite</button>
                <button className="link" onClick={leaveRoom}>Leave</button>
              </div>
            </div>

            <div className="row callbar">
              <label className="chk">
                <input type="checkbox" checked={voiceOnly} onChange={(e) => setVoiceOnly(e.target.checked)} />
                <span>Voice only</span>
              </label>

              <button className={`btn ${calling || inCall ? "danger" : ""}`} onClick={toggleCall} disabled={!connected || starting}>
                {starting ? "Starting…" : callButtonLabel}
              </button>
              <button className="btn" onClick={toggleMute} disabled={!inCall}>{muted ? "Unmute" : "Mute"}</button>
              <button className="btn" onClick={toggleVideo} disabled={!inCall || voiceOnly}>{videoOff ? "Camera On" : "Camera Off"}</button>

              {/* Host-only moderation */}
              {isHost && (
                <>
                  <button className="btn" onClick={() => hostLock(!room.locked)}>{room.locked ? "Unlock" : "Lock"} room</button>
                  <button className="btn" onClick={hostMuteAll}>Mute all</button>
                  <button className="btn danger" onClick={hostEndCall}>End call for all</button>
                </>
              )}
            </div>

            {/* Kick list (host only) */}
            {isHost && peerIds.length > 0 && (
              <div className="hint">
                Participants:{" "}
                {peerIds.map((pid, i) => (
                  <button key={pid} className="link" onClick={() => hostKick(pid)}>
                    Kick #{i + 1}
                  </button>
                ))}
              </div>
            )}

            {status && <div className="hint">{status}</div>}

            {/* incoming call */}
            {incoming && (
              <div className="incoming">
                <div className="box">
                  <div className="title">Incoming {incoming.kind === "audio" ? "voice" : "video"} call</div>
                  <div className="buttons">
                    <button className="btn primary" onClick={acceptIncoming}>Accept</button>
                    <button className="btn danger" onClick={declineIncoming}>Decline</button>
                  </div>
                </div>
              </div>
            )}

            {/* media */}
            {!voiceOnly && (
              <div className="media single">
                <div className="remotePane">
                  {/* Main remote */}
                  <video
                    ref={mainRemoteRef}
                    autoPlay playsInline
                    className={mainVideo === "remote" ? (videoFitContain ? "fit" : "") : "pip"}
                    onClick={() => setMainVideo("remote")}
                    onDoubleClick={() => setVideoFitContain((v) => !v)}
                  />

                  {/* Local */}
                  <video
                    ref={localRef}
                    autoPlay playsInline muted
                    className={mainVideo === "local" ? (videoFitContain ? "fit" : "") : "pip"}
                    onClick={() => setMainVideo("local")}
                    onDoubleClick={() => setVideoFitContain((v) => !v)}
                  />

                  {/* Extra remotes as PiPs */}
                  {peerIds
                    .filter((pid) => remoteStreamsRef.current.has(pid))
                    .map((pid) => (
                      <video
                        key={pid}
                        autoPlay playsInline muted className="pip"
                        ref={(el) => {
                          if (!el) return;
                          const ms = remoteStreamsRef.current.get(pid);
                          if (ms && el.srcObject !== ms) el.srcObject = ms;
                        }}
                        onClick={() => {
                          const ms = remoteStreamsRef.current.get(pid);
                          if (ms && mainRemoteRef.current) {
                            mainRemoteRef.current.srcObject = ms;
                            setMainVideo("remote");
                          }
                        }}
                      />
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
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
          />
          <button className="btn primary" onClick={sendChat}>Send</button>
        </div>
      </div>
    </div>
  );
}
