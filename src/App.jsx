import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Server URL from Netlify/ENV
const SERVER_URL = (import.meta.env.VITE_API_URL || "").split(",")[0].trim();

// STUN only
const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

// Performance-friendly constraints
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
  // sockets / rtc
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // media elements
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // sounds
  const ringInRef = useRef(null); // /sounds/incoming.mp3
  const ringBackRef = useRef(null); // /sounds/ringback.mp3
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // identity + connection
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");
  const [showNameEdit, setShowNameEdit] = useState(false);
  const [nameDraft, setNameDraft] = useState(me);

  // rooms + chat
  const [room, setRoom] = useState(null); // {code,name,requiresPin}
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const msgsRef = useRef(null);
  const dedupeMapRef = useRef(new Map()); // name|text -> ts

  // calls
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [calling, setCalling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [incoming, setIncoming] = useState(null); // { from, kind, sdp }
  const [status, setStatus] = useState("");
  const [net, setNet] = useState("Idle"); // Idle | Connecting | Connected | Reconnecting

  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  // UI: stable main/PiP + fit/fill for main
  const [mainVideo, setMainVideo] = useState("remote"); // "remote" | "local"
  const [videoFitContain, setVideoFitContain] = useState(true); // default to FIT (show whole face)

  // no-answer protection
  const offerTimeoutRef = useRef(null);
  const offerBackupRef = useRef(null);

  // helpers
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
      for (const [k, ts] of dedupeMapRef.current)
        if (ts < cutoff) dedupeMapRef.current.delete(k);
    }
    return false;
  };
  const stopRings = () => {
    const a = ringInRef.current,
      b = ringBackRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    if (b) {
      b.pause();
      b.currentTime = 0;
    }
  };

  // Unlock audio on first gesture
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

  // Socket setup
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("hello", me);
    });
    s.on("disconnect", () => setConnected(false));

    // chat
    s.on("chat", (m) => {
      if (seenRecently(m)) return;
      addMsg(m);
    });

    // signaling (1:1)
    s.on("rtc:offer", async ({ from, offer, kind = "video" }) => {
      setIncoming({ from, kind, sdp: offer });
      try {
        await ringInRef.current?.play();
      } catch {}
    });
    s.on("rtc:answer", async ({ answer }) => {
      try {
        await pcRef.current?.setRemoteDescription(answer);
      } finally {
        clearTimeout(offerTimeoutRef.current);
        clearTimeout(offerBackupRef.current);
      }
    });
    s.on("rtc:ice", async ({ candidate }) => {
      if (candidate) {
        try {
          await pcRef.current?.addIceCandidate(candidate);
        } catch {}
      }
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist name + re-hello
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // prefill join via URL
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("room");
    const p = q.get("pin");
    if (code) setJoinCode(code);
    if (p) setJoinPin(p);
  }, []);

  // auto-scroll messages
  useEffect(() => {
    msgsRef.current?.scrollTo({
      top: msgsRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [msgs]);

  // Rooms
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) return;
      setRoom(res.room);
      setJoinCode(res.room.code);
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
        if (!res?.ok) {
          addMsg({
            sys: true,
            ts: Date.now(),
            text: `Join failed: ${res?.error || "unknown error"}`,
          });
          return;
        }
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
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
    hangUp();
  };

  // Chat
  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    const mine = { name: me, ts: Date.now(), text: t };
    seenRecently(mine); // so server echo is deduped
    addMsg(mine);
    socketRef.current?.emit("chat", t);
    setText("");
  };

  // WebRTC helpers (1:1)
  const setupPC = (kind) => {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current?.emit("rtc:ice", {
          roomId: room?.code,
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
      } else {
        setNet("Idle");
      }
    };
    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        hangUp();
      }
    };
    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (remoteRef.current && ms) {
        remoteRef.current.srcObject = ms;
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

  const preflight = async (kind) => {
    try {
      setStatus("Requesting mic/camera…");
      const test = await navigator.mediaDevices.getUserMedia(
        kind === "audio" ? AUDIO_ONLY : LOW_VIDEO
      );
      test.getTracks().forEach((t) => t.stop());
      return true;
    } catch (e) {
      console.error(e);
      setStatus("Permission denied or device not available");
      return false;
    }
  };

  // Call controls
  const toggleCall = async () => {
    if (!room?.code) return;

    // end?
    if (calling || inCall) {
      hangUp();
      return;
    }

    const kind = voiceOnly ? "audio" : "video";
    setCalling(true);
    setStarting(true);

    try {
      const ok = await preflight(kind);
      if (!ok) {
        setCalling(false);
        setStarting(false);
        return;
      }

      const pc = setupPC(kind);
      const ms = await getStream(kind);
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      try {
        await ringBackRef.current?.play();
      } catch {}
      setStatus("Creating offer…");

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("rtc:offer", { roomId: room.code, offer, kind });
      setNet("Connecting");

      // Auto-hangup if no answer
      clearTimeout(offerTimeoutRef.current);
      clearTimeout(offerBackupRef.current);

      offerTimeoutRef.current = setTimeout(() => {
        if (!inCall && pcRef.current && pcRef.current.connectionState !== "connected") {
          stopRings();
          setStatus("No answer");
          addMsg({ sys: true, ts: Date.now(), text: "Call ended: no answer" });
          hangUp();
        }
      }, 20000);

      // backup watchdog (page sleep, backgrounded tabs, etc.)
      offerBackupRef.current = setTimeout(() => {
        if (!inCall) {
          stopRings();
          setStatus("No answer");
          addMsg({
            sys: true,
            ts: Date.now(),
            text: "Call ended: no answer (backup)",
          });
          hangUp();
        }
      }, 35000);
    } catch (e) {
      console.error(e);
      setCalling(false);
      setStarting(false);
      setStatus("");
      stopRings();
    }
  };

  const acceptIncoming = async () => {
    const inc = incoming;
    if (!inc) return;
    stopRings();
    setIncoming(null);
    try {
      setStatus("Answering…");
      const pc = setupPC(inc.kind || "video");
      const ms = await getStream(inc.kind || "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      await pc.setRemoteDescription(inc.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.emit("rtc:answer", { roomId: room?.code, answer });
      setNet("Connecting");
      setStatus("Connecting…");
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
    setCalling(false);
    setStarting(false);
    setInCall(false);
    setStatus("");
    setNet("Idle");
    setMuted(false);
    setVideoOff(false);
    setMainVideo("remote");
    clearTimeout(offerTimeoutRef.current);
    clearTimeout(offerBackupRef.current);

    try {
      pcRef.current?.getSenders?.().forEach((s) => s.track && s.track.stop());
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;

    const s = localRef.current?.srcObject;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      localRef.current.srcObject = null;
    }
    if (remoteRef.current?.srcObject) remoteRef.current.srcObject = null;

    socketRef.current?.emit("rtc:leave", { roomId: room?.code });
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
    if (room?.requiresPin) url.searchParams.set("pin", pin || "");
    await navigator.clipboard.writeText(url.toString());
    setStatus("Invite link copied");
  };

  const callButtonLabel = calling || inCall ? "End Call" : "Start Call";

  return (
    <div className="shell">
      {/* hidden audio players */}
      <audio ref={ringInRef} src="/sounds/incoming.mp3" loop />
      <audio ref={ringBackRef} src="/sounds/ringback.mp3" loop />

      <div className="glass">
        <header className="head">
          <h1>H2N Forum</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>

          {/* Compact identity chip with inline editor */}
          <button
            className="chip"
            onClick={() => {
              setShowNameEdit((v) => !v);
              setNameDraft(me);
            }}
          >
            <span className="chip-label">You:</span>{" "}
            <b className="chip-name">{me}</b>{" "}
            <span className="chip-edit">✎</span>
          </button>

          {showNameEdit && (
            <div className="name-pop">
              <div className="name-row">
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                />
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
              Rooms auto-delete after being empty for a while. Share the code
              (and PIN if set).
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

            {/* call controls */}
            <div className="row callbar">
              <label className="chk">
                <input
                  type="checkbox"
                  checked={voiceOnly}
                  onChange={(e) => setVoiceOnly(e.target.checked)}
                />
                <span>Voice only</span>
              </label>

              <button
                className={`btn ${calling || inCall ? "danger" : ""}`}
                onClick={toggleCall}
                disabled={!connected || starting}
              >
                {starting ? "Starting…" : callButtonLabel}
              </button>
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
            </div>
            {status && <div className="hint">{status}</div>}

            {/* incoming call dialog */}
            {incoming && (
              <div className="incoming">
                <div className="box">
                  <div className="title">
                    Incoming {incoming.kind === "audio" ? "voice" : "video"} call
                  </div>
                  <div className="buttons">
                    <button className="btn primary" onClick={acceptIncoming}>
                      Accept
                    </button>
                    <button className="btn danger" onClick={declineIncoming}>
                      Decline
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* media area — always render both videos; swap via classes */}
            {!voiceOnly && (
              <div className="media single">
                <div className="remotePane">
                  {/* REMOTE (click to make main) */}
                  <video
                    ref={remoteRef}
                    autoPlay
                    playsInline
                    className={mainVideo === "remote" ? (videoFitContain ? "fit" : "") : "pip"}
                    onClick={() => setMainVideo("remote")}
                    onDoubleClick={() => setVideoFitContain((v) => !v)}
                  />
                  {/* LOCAL (click to make main) */}
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
                      {typeof m.ts === "number"
                        ? new Date(m.ts).toLocaleTimeString()
                        : ""}
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
