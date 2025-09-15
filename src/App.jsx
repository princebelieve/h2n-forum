import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Server URL from Netlify/ENV
const SERVER_URL = (import.meta.env.VITE_API_URL || "").split(",")[0].trim();

// Public Google STUN. (No Twilio URL — the one with ?transport=udp was invalid.)
const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

export default function App() {
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // media elements
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // sounds
  const ringInRef = useRef(null);    // /sounds/incoming.mp3
  const ringBackRef = useRef(null);  // /sounds/ringback.mp3
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // connection / identity
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState("Me");

  // rooms + chat
  const [room, setRoom] = useState(null); // {code,name,requiresPin}
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");

  // calls
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [calling, setCalling] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [incoming, setIncoming] = useState(null); // { from, kind, sdp }

  const addMsg = (m) => setMsgs((p) => [...p, m]);

  // --- Unlock audio on first user gesture (mobile browsers require this)
  useEffect(() => {
    const once = async () => {
      if (audioUnlocked) return;
      try {
        // prime both audio tags so future play() is allowed
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

  const stopRings = () => {
    const a = ringInRef.current;
    const b = ringBackRef.current;
    if (a) { a.pause(); a.currentTime = 0; }
    if (b) { b.pause(); b.currentTime = 0; }
  };

  // --- Socket setup
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => { setConnected(true); s.emit("hello", me); });
    s.on("disconnect", () => setConnected(false));
    s.on("chat", (m) => addMsg(m));

    // Signaling
    s.on("rtc:offer", async ({ from, offer, kind = "video" }) => {
      setIncoming({ from, kind, sdp: offer });
      // Try to ring for incoming call (works after audio unlocked by any tap)
      try { await ringInRef.current?.play(); } catch {}
    });
    s.on("rtc:answer", async ({ answer }) => {
      await pcRef.current?.setRemoteDescription(answer);
    });
    s.on("rtc:ice", async ({ candidate }) => {
      if (candidate) {
        try { await pcRef.current?.addIceCandidate(candidate); } catch {}
      }
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    socketRef.current?.emit("hello", me);
  }, [me]);

  // --- Rooms
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) return;
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
          addMsg({ sys: true, ts: Date.now(), text: `Join failed: ${res?.error || "unknown error"}` });
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
  };

  // --- Chat
  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    socketRef.current?.emit("chat", t);
    setText("");
  };

  // --- WebRTC helpers
  const setupPC = (kind) => {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current?.emit("rtc:ice", { roomId: room?.code, candidate: e.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        stopRings();
        setInCall(true);
        setCalling(false);
      }
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
    const constraints = kind === "audio"
      ? { audio: true, video: false }
      : { audio: true, video: { facingMode: "user" } };
    const ms = await navigator.mediaDevices.getUserMedia(constraints);
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  };

  // --- Start (or end) call via single toggle button
  const toggleCall = async () => {
    if (!room?.code) return;
    if (calling || inCall) {
      hangUp();
      return;
    }
    // start call
    const kind = voiceOnly ? "audio" : "video";
    setCalling(true);
    try {
      const pc = setupPC(kind);
      const ms = await getStream(kind);
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      // ringback starts inside user gesture -> should play on mobile
      try { await ringBackRef.current?.play(); } catch {}

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("rtc:offer", { roomId: room.code, offer, kind });
    } catch (e) {
      console.error(e);
      setCalling(false);
      stopRings();
    }
  };

  const acceptIncoming = async () => {
    const inc = incoming;
    if (!inc) return;
    stopRings();
    setIncoming(null);
    try {
      const pc = setupPC(inc.kind || "video");
      const ms = await getStream(inc.kind || "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      await pc.setRemoteDescription(inc.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.emit("rtc:answer", { roomId: room?.code, answer });
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
    setInCall(false);

    // stop local media
    const v = localRef.current;
    const s = v?.srcObject;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
    if (remoteRef.current?.srcObject) remoteRef.current.srcObject = null;

    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;

    socketRef.current?.emit("rtc:leave", { roomId: room?.code });
  };

  const callButtonLabel = (calling || inCall) ? "End Call" : "Start Call";

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
        </header>

        <div className="row">
          <label>Your name</label>
          <input value={me} onChange={(e) => setMe(e.target.value)} />
        </div>

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
              <button className="btn primary" onClick={createRoom}>Create Meeting</button>
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

        {room && (
          <>
            <div className="row">
              <div className="inroom">
                In room: <b>{room.name}</b> <span className="mono">({room.code})</span>
                <button className="link" onClick={leaveRoom}>Leave</button>
              </div>
            </div>

            {/* one toggle button + voice-only checkbox */}
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
              >
                {callButtonLabel}
              </button>
            </div>

            {/* incoming call dialog */}
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

            {/* media: remote large, local small PiP */}
            <div className="media single">
              <div className="remotePane">
                <video ref={remoteRef} autoPlay playsInline />
                <video ref={localRef} autoPlay playsInline muted className="pip" />
              </div>
            </div>
          </>
        )}

        {/* messages */}
        <div className="msgs">
          {msgs.length === 0 ? (
            <div className="muted">No messages yet. Say hi! 👋</div>
          ) : (
            msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.sys ? "sys" : ""}`}>
                {!m.sys && (
                  <div className="meta">
                    <span className="who">{m.name}</span>
                    <span className="ts">{new Date(m.ts).toLocaleTimeString()}</span>
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
