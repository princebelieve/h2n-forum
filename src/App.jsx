import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Read server URL from Netlify/ENV
const SERVER_URL = (import.meta.env.VITE_API_URL || "").split(",")[0].trim();

export default function App() {
  // --- sockets / signaling ---
  const sref = useRef(null);

  // --- connection + identity ---
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState("Me");

  // --- create/join form ---
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");
  const [room, setRoom] = useState(null); // { code, name, requiresPin }

  // --- chat ---
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState([]);
  const addMsg = (m) => setMsgs((p) => [...p, m]);

  // --- WebRTC ---
  const [voiceOnly, setVoiceOnly] = useState(false);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null); // plays peer audio for voice-only

  // --- ringing assets ---
  const ringRef = useRef(null);     // /sounds/incoming.mp3
  const ringbackRef = useRef(null); // /sounds/ringback.mp3

  const stopAllRings = () => {
    [ringRef.current, ringbackRef.current].forEach((a) => {
      if (!a) return;
      a.pause();
      a.currentTime = 0;
    });
  };

  // ---------------- sockets ----------------
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    sref.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("hello", me);
      // (hide noisy "Socket connected" bubble)
    });

    s.on("disconnect", () => {
      setConnected(false);
      // (hide noisy "Socket disconnected" bubble)
    });

    s.on("chat", (m) => setMsgs((p) => [...p, m]));

    // incoming RTC offer
    s.on("rtc:offer", async ({ offer, from }) => {
      // ring until user answers or call ends
      try {
        ringRef.current?.play().catch(() => {});
      } catch {}
      pendingOfferRef.current = { offer, from };
      setIncoming(true);
    });

    // incoming RTC answer to OUR offer
    s.on("rtc:answer", async ({ answer }) => {
      if (!pcRef.current) return;
      try {
        await pcRef.current.setRemoteDescription(answer);
      } catch {}
      stopAllRings();
    });

    // incoming ICE from remote
    s.on("rtc:ice", async ({ candidate }) => {
      if (pcRef.current && candidate) {
        try {
          await pcRef.current.addIceCandidate(candidate);
        } catch {}
      }
    });

    return () => s.disconnect();
  }, []);

  useEffect(() => {
    sref.current?.emit("hello", me);
  }, [me]);

  // ---------------- rooms & chat ----------------
  const createRoom = () => {
    sref.current?.emit("create-room", { name: roomName, pin }, (res) => {
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
    sref.current?.emit(
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
    sref.current?.emit("leave-room");
    endCall();
    setRoom(null);
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
  };

  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    sref.current?.emit("chat", t);
    setText("");
  };

  // ---------------- WebRTC helpers ----------------
  const rtcConfig = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  };

  async function getLocalStream() {
    const constraints = voiceOnly
      ? { audio: true, video: false }
      : { audio: true, video: { width: 640, height: 480 } };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;

    // local preview only if video present
    if (!voiceOnly && localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    } else if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    return stream;
  }

  function wirePeer(pc) {
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && room?.code) {
        sref.current?.emit("rtc:ice", { roomId: room.code, candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") stopAllRings();
      if (st === "failed" || st === "closed" || st === "disconnected") {
        stopAllRings();
      }
    };
    pc.ontrack = (ev) => {
      const inbound = ev.streams[0];
      const hasVideo = inbound.getVideoTracks().length > 0;
      const hasAudio = inbound.getAudioTracks().length > 0;

      if (hasVideo && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = inbound;
      }
      if ((!hasVideo || voiceOnly) && hasAudio && remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = inbound;
      }
    };
  }

  function ensurePC() {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection(rtcConfig);
    wirePeer(pc);
    pcRef.current = pc;
    return pc;
  }

  async function addLocalTracks(pc) {
    const stream = localStreamRef.current || (await getLocalStream());
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  }

  // -------------- Outgoing call --------------
  async function startCall() {
    if (!room?.code) {
      addMsg({ sys: true, ts: Date.now(), text: "Join or create a room first." });
      return;
    }
    const pc = ensurePC();
    await addLocalTracks(pc);

    // play ringback while waiting for answer
    try {
      ringbackRef.current?.play().catch(() => {});
    } catch {}

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: !voiceOnly });
    await pc.setLocalDescription(offer);
    sref.current?.emit("rtc:offer", { roomId: room.code, offer });
  }

  // -------------- Incoming call --------------
  const [incoming, setIncoming] = useState(false);
  const pendingOfferRef = useRef(null);

  async function answerCall() {
    const entry = pendingOfferRef.current;
    if (!entry) return;
    setIncoming(false);
    stopAllRings();

    const pc = ensurePC();
    await addLocalTracks(pc);

    await pc.setRemoteDescription(entry.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sref.current?.emit("rtc:answer", { roomId: room.code, answer });
  }

  function rejectCall() {
    setIncoming(false);
    pendingOfferRef.current = null;
    stopAllRings();
    addMsg({ sys: true, ts: Date.now(), text: "Declined call" });
  }

  function endCall() {
    stopAllRings();
    try {
      pcRef.current?.getSenders().forEach((s) => s.track && s.track.stop());
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;

    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }

  // ---------------- UI ----------------
  return (
    <div className="shell">
      <div className="glass">
        <header className="head">
          <h1>H2N Forum</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>
        </header>

        {/* (Removed the “Client connects to: URL” row) */}

        <div className="row">
          <label>Your name</label>
          <input value={me} onChange={(e) => setMe(e.target.value)} />
        </div>

        {/* create / join */}
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
              Rooms auto-delete after being empty for a while. Share the
              6-digit code (and PIN if set).
            </div>
          </>
        )}

        {room && (
          <div className="row">
            <div className="inroom">
              In room: <b>{room.name}</b>{" "}
              <span className="mono">({room.code})</span>
              <button className="link" onClick={leaveRoom}>
                Leave
              </button>
            </div>
          </div>
        )}

        {/* call controls */}
        <div className="row callbar">
          <label className="chk">
            <input
              type="checkbox"
              checked={voiceOnly}
              onChange={(e) => setVoiceOnly(e.target.checked)}
            />{" "}
            Voice only
          </label>
          <button className="btn" onClick={startCall}>Start Call</button>
          <button className="btn" onClick={endCall}>End Call</button>
        </div>

        {/* incoming banner */}
        {incoming && (
          <div className="banner">
            Incoming {voiceOnly ? "voice" : "call"}…
            <div className="spacer" />
            <button className="btn primary" onClick={answerCall}>Answer</button>
            <button className="btn" onClick={rejectCall}>Decline</button>
          </div>
        )}

        {/* local/remote media */}
        {!voiceOnly && (
          <video ref={localVideoRef} autoPlay playsInline muted className="vid local" />
        )}
        <video ref={remoteVideoRef} autoPlay playsInline className="vid remote" />
        <audio ref={remoteAudioRef} autoPlay playsInline />

        {/* hidden ring sounds */}
        <audio ref={ringRef} src="/sounds/incoming.mp3" preload="auto" loop />
        <audio ref={ringbackRef} src="/sounds/ringback.mp3" preload="auto" loop />

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
                    <span className="ts">
                      {new Date(m.ts).toLocaleTimeString()}
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
            rows={3}
          />
          <button className="btn primary" onClick={sendChat}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
