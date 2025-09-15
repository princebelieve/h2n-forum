import React, { useState, useRef, useEffect } from "react";
import io from "socket.io-client";

const ICE = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

export default function App() {
  // socket + peer
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // media elements
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // sounds
  const ringInRef = useRef(null);
  const ringBackRef = useRef(null);

  // connection / identity
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState("Me");
  const [room, setRoom] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  // setup audio volume
  useEffect(() => {
    if (ringInRef.current) ringInRef.current.volume = 0.85;
    if (ringBackRef.current) ringBackRef.current.volume = 0.75;
  }, []);

  // connect socket
  useEffect(() => {
    socketRef.current = io("/", { transports: ["websocket"] });

    socketRef.current.on("connect", () => {
      setConnected(true);
    });

    socketRef.current.on("message", (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    socketRef.current.on("offer", async (offer) => {
      if (!pcRef.current) createPeerConnection();

      await pcRef.current.setRemoteDescription(offer);
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);

      socketRef.current.emit("answer", answer);

      // play incoming ringtone
      if (ringInRef.current) {
        ringInRef.current.currentTime = 0;
        ringInRef.current.play().catch(() => {});
      }
    });

    socketRef.current.on("answer", async (answer) => {
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(answer);

        // stop ringback
        if (ringBackRef.current) ringBackRef.current.pause();
      }
    });

    socketRef.current.on("ice-candidate", (candidate) => {
      if (pcRef.current) {
        pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    return () => {
      socketRef.current.disconnect();
    };
  }, []);

  function createPeerConnection() {
    pcRef.current = new RTCPeerConnection(ICE);

    pcRef.current.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit("ice-candidate", e.candidate);
      }
    };

    pcRef.current.ontrack = (e) => {
      remoteRef.current.srcObject = e.streams[0];
    };

    if (localRef.current && localRef.current.srcObject) {
      localRef.current.srcObject.getTracks().forEach((track) => {
        pcRef.current.addTrack(track, localRef.current.srcObject);
      });
    }
  }

  async function startCall() {
    const constraints = voiceOnly
      ? { audio: true, video: false }
      : { audio: true, video: true };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localRef.current.srcObject = stream;

    createPeerConnection();

    stream.getTracks().forEach((track) => {
      pcRef.current.addTrack(track, stream);
    });

    const offer = await pcRef.current.createOffer();
    await pcRef.current.setLocalDescription(offer);

    socketRef.current.emit("offer", offer);

    setIsCalling(true);

    // play ringback
    if (ringBackRef.current) {
      ringBackRef.current.currentTime = 0;
      ringBackRef.current.play().catch(() => {});
    }
  }

  function endCall() {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localRef.current?.srcObject) {
      localRef.current.srcObject.getTracks().forEach((t) => t.stop());
    }
    setIsCalling(false);

    if (ringInRef.current) ringInRef.current.pause();
    if (ringBackRef.current) ringBackRef.current.pause();
  }

  function sendMessage() {
    if (input.trim()) {
      const msg = `${me}: ${input}`;
      socketRef.current.emit("message", msg);
      setMessages((prev) => [...prev, msg]);
      setInput("");
    }
  }

  return (
    <div className="app">
      <h2>H2N Forum</h2>
      <p className="status">{connected ? "Connected to server" : "Disconnected"}</p>

      {!inRoom && (
        <div className="join-box">
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="Room code"
          />
          <button
            onClick={() => {
              socketRef.current.emit("join", room);
              setInRoom(true);
            }}
          >
            Join Room
          </button>
        </div>
      )}

      {inRoom && (
        <div className="call-box">
          <p>In room: {room}</p>
          <label>
            <input
              type="checkbox"
              checked={voiceOnly}
              onChange={(e) => setVoiceOnly(e.target.checked)}
            />
            Voice only
          </label>
          {!isCalling ? (
            <button onClick={startCall}>Start Call</button>
          ) : (
            <button onClick={endCall} className="end">
              End Call
            </button>
          )}
          <video ref={localRef} autoPlay muted playsInline />
          <video ref={remoteRef} autoPlay playsInline />
        </div>
      )}

      <div className="chat">
        <div className="messages">
          {messages.map((m, i) => (
            <div key={i}>{m}</div>
          ))}
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
        />
        <button onClick={sendMessage}>Send</button>
      </div>

      {/* Sounds */}
      <audio ref={ringInRef} src="/sounds/incoming.mp3" preload="auto" loop />
      <audio ref={ringBackRef} src="/sounds/ringback.mp3" preload="auto" loop />
    </div>
  );
}
