import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = (import.meta.env.VITE_API_URL || "").split(",")[0].trim();

export default function App() {
  const sref = useRef(null);

  // connection
  const [connected, setConnected] = useState(false);

  // identity
  const [me, setMe] = useState("Me");

  // create
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");

  // join
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  // room & chat
  const [room, setRoom] = useState(null); // {code,name,requiresPin}
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState([]);
  const addMsg = (m) => setMsgs((p) => [...p, m]);

  // --- WebRTC state ---
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const [calling, setCalling] = useState(false);

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

    // --- signaling for WebRTC ---
    s.on("rtc:peer-joined", () => {
      if (pcRef.current && calling) makeOffer(); // renegotiate if needed
    });

    s.on("rtc:offer", async ({ offer }) => {
      ensurePeer();
      await pcRef.current.setRemoteDescription(offer);
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);
      sref.current.emit("rtc:answer", { roomId: room?.code, answer });
    });

    s.on("rtc:answer", async ({ answer }) => {
      if (!pcRef.current) return;
      await pcRef.current.setRemoteDescription(answer);
    });

    s.on("rtc:ice", async ({ candidate }) => {
      try {
        if (pcRef.current && candidate) {
          await pcRef.current.addIceCandidate(candidate);
        }
      } catch {}
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sref.current?.emit("hello", me);
  }, [me]);

  const createRoom = () => {
    sref.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) {
        addMsg({ sys: true, ts: Date.now(), text: "Failed to create room" });
        return;
      }
      setRoom(res.room);
      setJoinCode(res.room.code);
      addMsg({
        sys: true,
        ts: Date.now(),
        text: `Created room: ${res.room.name} (${res.room.code})`,
      });
      sref.current.emit("rtc:join", { roomId: res.room.code });
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
        sref.current.emit("rtc:join", { roomId: res.room.code });
      }
    );
  };

  const leaveRoom = () => {
    stopCall(); // hang up if calling
    sref.current?.emit("leave-room");
    sref.current?.emit("rtc:leave", { roomId: room?.code });
    setRoom(null);
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
  };

  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    sref.current?.emit("chat", t);
    setText("");
  };

  // ---------- WebRTC helpers ----------
  function ensurePeer() {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478?transport=udp" },
      ],
    });
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sref.current.emit("rtc:ice", {
          roomId: room?.code,
          candidate: e.candidate,
        });
      }
    };

    pc.ontrack = (e) => {
      const [stream] = e.streams;
      remoteStreamRef.current = stream;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    };

    return pc;
  }

  async function makeOffer() {
    const pc = ensurePeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sref.current.emit("rtc:offer", { roomId: room?.code, offer });
  }

  const startCall = async () => {
    if (!room) {
      addMsg({ sys: true, ts: Date.now(), text: "Join or create a room first." });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = ensurePeer();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      setCalling(true);
      await makeOffer();
      addMsg({ sys: true, ts: Date.now(), text: "Calling…" });
    } catch (err) {
      addMsg({ sys: true, ts: Date.now(), text: `Cannot start call: ${err.message}` });
    }
  };

  const stopCall = () => {
    setCalling(false);
    try {
      localStreamRef.current?.getTracks()?.forEach((t) => t.stop());
    } catch {}
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    try { pcRef.current?.getSenders()?.forEach((s) => s.track && s.track.stop()); } catch {}
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;

    if (room?.code) sref.current.emit("rtc:leave", { roomId: room.code });
  };

  return (
    <div className="shell">
      <div className="glass">
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
          <label>Your name</label>
          <input value={me} onChange={(e) => setMe(e.target.value)} />
        </div>

        {/* create / join */}
        {!room && (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row">
              <input
                placeholder="Family Room (optional)"
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
          <>
            <div className="row">
              <div className="inroom">
                In room: <b>{room.name}</b>{" "}
                <span className="mono">({room.code})</span>
                <button className="link" onClick={leaveRoom}>Leave</button>
              </div>

              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                {!calling ? (
                  <button className="btn primary" onClick={startCall}>Start Call</button>
                ) : (
                  <button className="btn danger" onClick={stopCall}>Hang Up</button>
                )}
              </div>
            </div>

            {/* videos */}
            <div className="row" style={{ gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div className="mono small">You</div>
                <video ref={localVideoRef} autoPlay muted playsInline style={{ width: "100%", background: "#111", borderRadius: 8, aspectRatio: "16/9" }} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="mono small">Peer</div>
                <video ref={remoteVideoRef} autoPlay playsInline style={{ width: "100%", background: "#111", borderRadius: 8, aspectRatio: "16/9" }} />
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
          />
          <button className="btn primary" onClick={sendChat}>Send</button>
        </div>
      </div>
    </div>
  );
}
