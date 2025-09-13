import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

// Read server URL from Netlify/ENV (no localhost fallback)
const SERVER_URL = import.meta.env.VITE_SERVER_URL.split(",")[0].trim();

export default function App() {
  // -----------------------------
  // Socket / app state
  // -----------------------------
  const sref = useRef(null);               // socket reference
  const [connected, setConnected] = useState(false);

  const [name, setName] = useState("");    // optional display name
  const [roomName, setRoomName] = useState(""); // 6-digit room code
  const [pin, setPin] = useState("");      // optional pin

  const [msgs, setMsgs] = useState([]);    // chat messages
  const [text, setText] = useState("");    // composer text

  // -----------------------------
  // Voice call (WebRTC) state/refs
  // -----------------------------
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const [calling, setCalling] = useState(false);
  const [micReady, setMicReady] = useState(false);

  // -----------------------------
  // Connect socket once
  // -----------------------------
  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ["websocket"] });
    sref.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    const pushMsg = (m) =>
      setMsgs((prev) => [...prev, normalizeMsg(m)]);

    socket.on("chat:msg", pushMsg);
    socket.on("message", pushMsg);
    socket.on("server:msg", pushMsg);

    const sys = (t) =>
      setMsgs((p) => [...p, { system: true, text: t, ts: Date.now() }]);

    socket.on("room:joined", ({ roomId }) => sys(`Joined room ${roomId}`));
    socket.on("joined", ({ roomId }) => sys(`Joined room ${roomId}`));
    socket.on("room:created", ({ roomId }) => sys(`Room ${roomId} created`));

    return () => {
      socket.off("chat:msg", pushMsg);
      socket.off("message", pushMsg);
      socket.off("server:msg", pushMsg);
      socket.off("room:joined");
      socket.off("joined");
      socket.off("room:created");
      socket.disconnect();
    };
  }, []);

  // Normalize message shape for UI
  function normalizeMsg(m) {
    if (typeof m === "string") return { text: m, ts: Date.now() };
    if (m && m.text) return { ...m, ts: m.ts || Date.now() };
    if (m && m.message) return { text: m.message, ts: m.ts || Date.now() };
    return { text: JSON.stringify(m), ts: Date.now() };
  }

  // -----------------------------
  // Room helpers
  // -----------------------------
  function genCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function createRoom() {
    const code = genCode();
    setRoomName(code);

    const socket = sref.current;
    if (!socket) return;

    socket.emit("room:create", { roomId: code, pin: pin || undefined, name: name || undefined });
    socket.emit("join", { roomId: code, pin: pin || undefined, name: name || undefined });
    socket.emit("room:join", { roomId: code, pin: pin || undefined, name: name || undefined });
  }

  function joinRoom() {
    if (!roomName) {
      alert("Enter 6-digit room code");
      return;
    }
    const socket = sref.current;
    if (!socket) return;

    socket.emit("join", { roomId: roomName, pin: pin || undefined, name: name || undefined });
    socket.emit("room:join", { roomId: roomName, pin: pin || undefined, name: name || undefined });
  }

  // -----------------------------
  // Chat send
  // -----------------------------
  function sendMsg() {
    const t = text.trim();
    if (!t) return;
    if (!roomName) {
      alert("Create or join a room first.");
      return;
    }
    const socket = sref.current;
    if (!socket) return;

    const payload = {
      roomId: roomName,
      text: t,
      from: name || "Anon",
      ts: Date.now(),
    };

    socket.emit("chat:send", payload);
    socket.emit("message", payload);

    setMsgs((prev) => [...prev, { ...payload, me: true }]);
    setText("");
  }

  // -----------------------------
  // WebRTC: ensure RTCPeerConnection
  // -----------------------------
  function ensurePeerConnection() {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (e) => {
      if (e.candidate && roomName) {
        sref.current?.emit("rtc:ice", { roomId: roomName, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = e.streams[0];
      }
    };

    pcRef.current = pc;
    return pc;
  }

  // -----------------------------
  // Mic control
  // -----------------------------
  async function startMic() {
    try {
      if (localStreamRef.current) return localStreamRef.current;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      const pc = ensurePeerConnection();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      setMicReady(true);
      return stream;
    } catch (err) {
      console.error("Mic error:", err);
      alert("Could not access microphone. Please allow mic permission.");
    }
  }

  function stopMic() {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    const pc = pcRef.current;
    if (pc) {
      pc.getSenders()
        .filter((s) => s.track && s.track.kind === "audio")
        .forEach((s) => pc.removeTrack(s));
    }
    setMicReady(false);
  }

  // -----------------------------
  // Voice call: start & hang up
  // -----------------------------
  async function startCall() {
    if (!roomName) {
      alert("Create or join a room first.");
      return;
    }
    if (!micReady) await startMic();

    const socket = sref.current;
    const pc = ensurePeerConnection();

    socket?.emit("rtc:join", { roomId: roomName });

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    socket?.emit("rtc:offer", { roomId: roomName, offer });

    setCalling(true);
  }

  function hangUp() {
    const socket = sref.current;
    if (roomName) socket?.emit("rtc:leave", { roomId: roomName });

    try {
      const pc = pcRef.current;
      if (pc) {
        pc.getSenders().forEach((s) => {
          try { s.track && s.track.stop(); } catch {}
        });
        pc.close();
      }
    } catch {}
    pcRef.current = null;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    setMicReady(false);
    setCalling(false);
  }

  // -----------------------------
  // WebRTC signaling listeners
  // -----------------------------
  useEffect(() => {
    const socket = sref.current;
    if (!socket) return;

    const onOffer = async ({ offer }) => {
      try {
        if (!micReady) await startMic();
        const pc = ensurePeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("rtc:answer", { roomId: roomName, answer });
        setCalling(true);
      } catch (e) {
        console.error("onOffer error", e);
      }
    };

    const onAnswer = async ({ answer }) => {
      try {
        const pc = ensurePeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (e) {
        console.error("onAnswer error", e);
      }
    };

    const onIce = async ({ candidate }) => {
      try {
        const pc = ensurePeerConnection();
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error("ICE add error", e);
      }
    };

    socket.on("rtc:offer", onOffer);
    socket.on("rtc:answer", onAnswer);
    socket.on("rtc:ice", onIce);

    return () => {
      socket.off("rtc:offer", onOffer);
      socket.off("rtc:answer", onAnswer);
      socket.off("rtc:ice", onIce);
    };
  }, [roomName, micReady]);

  // -----------------------------
  // UI
  // -----------------------------
  return (
    <div className="app">
      <h1>
        H2N Forum{" "}
        {connected ? (
          <span className="status">Connected to server</span>
        ) : (
          <span className="status" style={{ color: "#fca5a5" }}>
            Disconnected
          </span>
        )}
      </h1>

      <div className="panel">
        {/* Meta + create/join */}
        <div className="row">
          <div className="row_meta">
            <input
              placeholder="Your name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="row_title">Create a meeting</div>
            <button className="btn" onClick={createRoom}>
              Create Meeting
            </button>
            {roomName && <div className="pill">Room: {roomName}</div>}
          </div>

          <div className="row_meta">
            <input
              placeholder="Enter 6-digit code"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              maxLength={6}
            />
            <input
              placeholder="PIN (optional)"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            <div className="row_title_right">Join a meeting</div>
            <button className="btn" onClick={joinRoom}>
              Join
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="msgs">
          {msgs.map((m, i) => (
            <div key={i} className={`msg ${m.me ? "me" : ""}`}>
              {!m.system && <div className="meta">{m.from || "Someone"}</div>}
              <div>{m.text}</div>
            </div>
          ))}
        </div>

        {/* Composer */}
        <div className="send">
          <textarea
            placeholder="Type a message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMsg();
              }
            }}
          />
          <button className="btn" onClick={sendMsg}>
            Send
          </button>
        </div>

        {/* Voice controls */}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={startMic} disabled={micReady}>
            {micReady ? "Mic ready ✔" : "Start Mic"}
          </button>
          <button className="btn" onClick={stopMic} disabled={!micReady}>
            Stop Mic
          </button>
          <button className="btn" onClick={startCall} disabled={!micReady || calling || !roomName}>
            {calling ? "Calling…" : "Start Voice Call"}
          </button>
          <button className="btn" onClick={hangUp} disabled={!calling}>
            Hang Up
          </button>
        </div>

        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />
      </div>
    </div>
  );
}
