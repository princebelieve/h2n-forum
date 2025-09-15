import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = (import.meta.env.VITE_API_URL || "").split(",")[0].trim();

const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };

export default function App() {
  // sockets & webrtc
  const socketRef = useRef(null);
  const pcRef = useRef(null);

  // media elements
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // ringtones
  const ringInRef = useRef(null);
  const ringBackRef = useRef(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // app state
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState("Me");

  // rooms + chat
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");
  const [room, setRoom] = useState(null); // {code,name,requiresPin}
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");

  // call state
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [incomingOffer, setIncomingOffer] = useState(null); // when someone calls you

  const addMsg = (m) => setMsgs((p) => [...p, m]);

  // --- audio unlock for mobile (first tap enables sounds) ---
  useEffect(() => {
    const unlock = () => {
      if (audioUnlocked) return;
      [ringInRef.current, ringBackRef.current].forEach((el) => {
        if (el) {
          el.muted = true;
          el.play().catch(() => {});
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        }
      });
      setAudioUnlocked(true);
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("click", unlock);
    };
    window.addEventListener("touchstart", unlock, { once: true });
    window.addEventListener("click", unlock, { once: true });
    return () => {
      window.removeEventListener("touchstart", unlock);
      window.removeEventListener("click", unlock);
    };
  }, [audioUnlocked]);

  // ringtone volumes
  useEffect(() => {
    if (ringInRef.current) ringInRef.current.volume = 0.85;
    if (ringBackRef.current) ringBackRef.current.volume = 0.75;
  }, []);

  // socket setup
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("hello", me);
    });
    s.on("disconnect", () => setConnected(false));

    // chat
    s.on("chat", (m) => addMsg(m));

    // signaling
    s.on("offer", async (offer) => {
      setIncomingOffer(offer);
      // try to play incoming ringtone (may get blocked until user taps)
      if (ringInRef.current) {
        ringInRef.current.currentTime = 0;
        ringInRef.current.play().catch(() => {});
      }
    });

    s.on("answer", async (answer) => {
      if (!pcRef.current) return;
      await pcRef.current.setRemoteDescription(answer);
      if (ringBackRef.current) ringBackRef.current.pause();
    });

    s.on("ice-candidate", (c) => {
      if (pcRef.current) pcRef.current.addIceCandidate(new RTCIceCandidate(c));
    });

    return () => s.disconnect();
  }, []);

  // keep server updated with my name
  useEffect(() => {
    socketRef.current?.emit("hello", me);
  }, [me]);

  // --- room actions ---
  const createRoom = () => {
    socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) return addMsg(sys("Failed to create room"));
      setRoom(res.room);
      setJoinCode(res.room.code);
      addMsg(sys(`Created room: ${res.room.name} (${res.room.code})`));
    });
  };

  const joinRoom = () => {
    socketRef.current?.emit(
      "join-room",
      { code: joinCode.trim(), pin: joinPin.trim() },
      (res) => {
        if (!res?.ok)
          return addMsg(sys(`Join failed: ${res?.error || "unknown error"}`));
        setRoom(res.room);
        addMsg(sys(`Joined room: ${res.room.name} (${res.room.code})`));
      }
    );
  };

  const leaveRoom = () => {
    socketRef.current?.emit("leave-room");
    endCall();
    setRoom(null);
    setIncomingOffer(null);
    addMsg(sys("Left room"));
  };

  // --- chat ---
  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    socketRef.current?.emit("chat", t);
    setText("");
  };

  // --- webrtc helpers ---
  function sys(t) {
    return { sys: true, ts: Date.now(), text: t };
  }

  function createPeer() {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) socketRef.current?.emit("ice-candidate", e.candidate);
    };
    pc.ontrack = (e) => {
      remoteRef.current.srcObject = e.streams[0];
    };

    const stream = localRef.current?.srcObject;
    if (stream) {
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    }
  }

  async function ensureLocalStream() {
    if (localRef.current?.srcObject) return;
    const constraints = voiceOnly
      ? { audio: true, video: false }
      : { audio: true, video: { facingMode: "user" } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localRef.current.srcObject = stream;
  }

  // caller starts
  const startCall = async () => {
    await ensureLocalStream();
    createPeer();
    const offer = await pcRef.current.createOffer();
    await pcRef.current.setLocalDescription(offer);
    socketRef.current?.emit("offer", offer);
    setIsCalling(true);
    // ringback while waiting
    if (ringBackRef.current) {
      ringBackRef.current.currentTime = 0;
      ringBackRef.current.play().catch(() => {});
    }
  };

  // callee answers
  const answerCall = async () => {
    if (!incomingOffer) return;
    if (ringInRef.current) ringInRef.current.pause();

    await ensureLocalStream();
    createPeer();
    await pcRef.current.setRemoteDescription(incomingOffer);
    const answer = await pcRef.current.createAnswer();
    await pcRef.current.setLocalDescription(answer);
    socketRef.current?.emit("answer", answer);
    setIsCalling(true);
    setIncomingOffer(null);
  };

  // hang up
  const endCall = () => {
    if (ringBackRef.current) ringBackRef.current.pause();
    if (ringInRef.current) ringInRef.current.pause();

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    const s = localRef.current?.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    localRef.current && (localRef.current.srcObject = null);
    setIsCalling(false);
    setIncomingOffer(null);
  };

  // button label / action
  const callBtn = !isCalling
    ? incomingOffer
      ? { label: "Answer", action: answerCall, kind: "primary" }
      : { label: "Start Call", action: startCall, kind: "primary" }
    : { label: "End Call", action: endCall, kind: "danger" };

  return (
    <div className="shell">
      <div className="card">
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
            <div className="row grid-2">
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
              <button className="btn primary full" onClick={createRoom}>
                Create Meeting
              </button>
            </div>

            <div className="row title right">Code + optional PIN</div>
            <div className="row grid-2">
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
              <button className="btn full" onClick={joinRoom}>
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
            <div className="row inroom">
              <div>
                In room: <b>{room.name}</b>{" "}
                <span className="mono">({room.code})</span>
              </div>
              <button className="link" onClick={leaveRoom}>
                Leave
              </button>
            </div>

            <div className="row callbar">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={voiceOnly}
                  onChange={(e) => setVoiceOnly(e.target.checked)}
                />
                <span>Voice only</span>
              </label>

              <button
                className={`btn ${callBtn.kind}`}
                onClick={callBtn.action}
              >
                {callBtn.label}
              </button>
            </div>

            <div className="videos">
              <video
                ref={remoteRef}
                className="remote"
                autoPlay
                playsInline
                controls={false}
              />
              <video
                ref={localRef}
                className="local"
                autoPlay
                muted
                playsInline
                controls={false}
              />
            </div>
          </>
        )}

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
                <div className="text">{m.text || m}</div>
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

      {/* RING SOUNDS (preload + loop) */}
      <audio ref={ringInRef} src="/sounds/incoming.mp3" preload="auto" loop />
      <audio
        ref={ringBackRef}
        src="/sounds/ringback.mp3"
        preload="auto"
        loop
      />
    </div>
  );
}