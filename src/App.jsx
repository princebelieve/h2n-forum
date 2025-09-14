// src/App.jsx
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Read server URL from Netlify/ENV
const SERVER_URL = (import.meta.env.VITE_API_URL || "").split(",")[0].trim();

// Use valid ICE servers (no ?transport=udp here)
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  // Add TURN later if needed, e.g. { urls: "turn:...", username: "...", credential: "..." }
];

export default function App() {
  /** Socket **/
  const sref = useRef(null);
  const [connected, setConnected] = useState(false);

  /** Identity & room **/
  const [me, setMe] = useState("Me");
  const [room, setRoom] = useState(null);          // {code,name,requiresPin}
  const [roomName, setRoomName] = useState("");    // create
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");    // join
  const [joinPin, setJoinPin] = useState("");

  /** Chat **/
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState([]);
  const addMsg = (m) => setMsgs((p) => [...p, m]);

  /** Media / WebRTC **/
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const [inCall, setInCall] = useState(false);
  const [incomingOffer, setIncomingOffer] = useState(null); // offer from peer
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  /** Ringtones **/
  const ringElRef = useRef(null);     // incoming
  const ringbackElRef = useRef(null); // caller side

  /* -------------------- socket connection -------------------- */
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    sref.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("hello", me);
      addMsg({ sys: true, ts: Date.now(), text: "Socket connected" });
    });

    s.on("disconnect", () => {
      setConnected(false);
      addMsg({ sys: true, ts: Date.now(), text: "Socket disconnected" });
    });

    s.on("chat", (m) => addMsg(m));

    // ---- WebRTC signaling: receive offer/answer/ice ----
    s.on("rtc:offer", async ({ from, offer }) => {
      setIncomingOffer({ from, offer });
      // play incoming ring
      try { ringElRef.current?.play(); } catch {}
    });

    s.on("rtc:answer", async ({ from, answer }) => {
      await pcRef.current?.setRemoteDescription(answer).catch(console.error);
    });

    s.on("rtc:ice", async ({ from, candidate }) => {
      if (!pcRef.current || !candidate) return;
      try {
        await pcRef.current.addIceCandidate(candidate);
      } catch (e) {
        console.error("addIceCandidate error:", e);
      }
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sref.current?.emit("hello", me);
  }, [me]);

  /* -------------------- room actions -------------------- */
  const createRoom = () => {
    sref.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) {
        addMsg({ sys: true, ts: Date.now(), text: "Failed to create room" });
        return;
      }
      setRoom(res.room);
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
    endCall(); // also hang up if in call
    setRoom(null);
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
  };

  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    sref.current?.emit("chat", t);
    setText("");
  };

  /* -------------------- webrtc helpers -------------------- */
  async function ensureLocalStream() {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      try { await localVideoRef.current.play(); } catch {}
    }
    return stream;
  }

  function newPeer() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sref.current?.emit("rtc:ice", {
          roomId: room?.code,
          candidate: e.candidate,
        });
      }
    };

    pc.ontrack = (e) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = e.streams[0];
        remoteVideoRef.current.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        stopRingback();
        setInCall(true);
      }
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        stopRing();
        stopRingback();
        setInCall(false);
      }
    };

    pcRef.current = pc;
    return pc;
  }

  function stopRing() {
    const el = ringElRef.current;
    if (!el) return;
    try { el.pause(); el.currentTime = 0; } catch {}
  }
  function stopRingback() {
    const el = ringbackElRef.current;
    if (!el) return;
    try { el.pause(); el.currentTime = 0; } catch {}
  }

  /* -------------------- call actions -------------------- */
  const startCall = async () => {
    if (!room?.code) {
      addMsg({ sys: true, ts: Date.now(), text: "Join or create a room first." });
      return;
    }
    const stream = await ensureLocalStream();
    const pc = newPeer();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    // Caller plays ringback until connected
    try { ringbackElRef.current?.play(); } catch {}

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sref.current?.emit("rtc:offer", { roomId: room.code, offer });
  };

  const answerCall = async () => {
    const incoming = incomingOffer;
    if (!incoming) return;

    stopRing();
    const stream = await ensureLocalStream();
    const pc = newPeer();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    await pc.setRemoteDescription(incoming.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sref.current?.emit("rtc:answer", { roomId: room?.code, answer });
    setIncomingOffer(null);
  };

  const declineCall = () => {
    stopRing();
    setIncomingOffer(null);
    // No signal needed; the caller will time out / stay ringing until they hang up
  };

  const endCall = () => {
    stopRing();
    stopRingback();
    setInCall(false);

    try {
      pcRef.current?.getSenders().forEach((s) => s.track && s.track.stop());
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;

    // keep local preview off after hang-up
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
  };

  /* -------------------- UI -------------------- */
  return (
    <div className="shell">
      <div className="glass">
        {/* hidden audio elements for tones */}
        <audio id="incoming-audio" ref={ringElRef} src="/sounds/incoming.mp3" preload="auto" />
        <audio id="ringback-audio" ref={ringbackElRef} src="/sounds/ringback.mp3" preload="auto" />

        <header className="head">
          <h1>H2N Forum</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>
        </header>

        <div className="row meta">
          <div className="mono small">Client connects to:</div>
          <div className="mono">{SERVER_URL}</div>
        </div>

        <div className="row">
          <label>Name</label>
          <input value={me} onChange={(e) => setMe(e.target.value)} placeholder="Your display name" />
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
                Create
              </button>
            </div>

            <div className="row title right">Join with code</div>
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
          </>
        )}

        {room && (
          <>
            <div className="row">
              <div className="inroom">
                In room: <b>{room.name}</b>{" "}
                <span className="mono">({room.code})</span>
                <button className="link" onClick={leaveRoom}>
                  Leave
                </button>
              </div>
            </div>

            {/* Call controls */}
            <div className="row">
              {!inCall && !incomingOffer && (
                <button className="btn primary" onClick={startCall}>Start call</button>
              )}
              {incomingOffer && !inCall && (
                <>
                  <button className="btn primary" onClick={answerCall}>Answer</button>
                  <button className="btn" onClick={declineCall}>Decline</button>
                </>
              )}
              {inCall && (
                <button className="btn danger" onClick={endCall}>Hang up</button>
              )}
            </div>

            {/* Videos */}
            <div className="row">
              <div style={{display:"grid", gap:"12px", width:"100%"}}>
                <div>
                  <div className="mono small">You</div>
                  <video
                    ref={localVideoRef}
                    muted
                    playsInline
                    autoPlay
                    style={{ width: "100%", background: "#000", borderRadius: 8 }}
                  />
                </div>
                <div>
                  <div className="mono small">Peer</div>
                  <video
                    ref={remoteVideoRef}
                    playsInline
                    autoPlay
                    style={{ width: "100%", background: "#000", borderRadius: 8 }}
                  />
                </div>
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
          <button className="btn primary" onClick={sendChat}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
