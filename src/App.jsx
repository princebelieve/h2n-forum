// src/App.jsx
import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import "./App.css";

// ----- Env -----
const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "").split(",")[0].trim();
const TURN_URL   = (import.meta.env.VITE_TURN_URL   || "").trim();

// ----- Media presets -----
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

// ----- TURN / ICE fetch (fixed) -----
async function getIceServers() {
  try {
    if (!TURN_URL) throw new Error("TURN_URL missing");
    const res = await fetch(TURN_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`TURN fetch failed: ${res.status}`);
    const data = await res.json();

    // Metered returns { iceServers: [...] }. Some providers return the array directly.
    const list = Array.isArray(data) ? data : data.iceServers;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("Empty TURN list");
    }
    return list;
  } catch (err) {
    console.warn("TURN fetch failed, falling back to STUN:", err?.message || err);
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}

export default function App() {
  // Refs
  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const iceRef = useRef([{ urls: "stun:stun.l.google.com:19302" }]);
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const msgsRef = useRef(null);

  // State
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");

  const [room, setRoom] = useState(null); // { code, name, hostId, locked, live, pin? }
  const isHost = room && socketId && room.hostId === socketId;

  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  const [msgs, setMsgs] = useState([]);
  function addMsg(m) {
    setMsgs((p) => {
      const next = [...p, m];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }

  // Form state
  const [roomName, setRoomName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  // ----- Socket wiring -----
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      setSocketId(s.id);
      s.emit("hello", me);
      addMsg({ sys: true, ts: Date.now(), text: "Connected to server" });
    });
    s.on("disconnect", () => setConnected(false));
    s.on("reconnect", () => setSocketId(s.id));

    s.on("chat", (m) => addMsg(m));
    s.on("room:live", (live) => setRoom((r) => (r ? { ...r, live } : r)));
    s.on("room:locked", (locked) => setRoom((r) => (r ? { ...r, locked } : r)));

    // Offer from host → guest
    s.on("rtc:offer", async ({ offer }) => {
      if (pcRef.current) return; // already in a call
      iceRef.current = await getIceServers();
      const pc = await setupPeer();
      const ms = await getLocalStream();
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit("rtc:answer", { answer });
      setInCall(true);
    });

    // Answer from guest → host
    s.on("rtc:answer", async ({ answer }) => {
      if (!pcRef.current) return;
      try {
        await pcRef.current.setRemoteDescription(answer);
      } catch {}
    });

    // ICE candidates both ways
    s.on("rtc:ice", async ({ candidate }) => {
      if (!pcRef.current || !candidate) return;
      try {
        await pcRef.current.addIceCandidate(candidate);
      } catch {}
    });

    return () => s.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist/display name
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // Auto-scroll chat
  useEffect(() => {
    if (msgsRef.current) {
      msgsRef.current.scrollTo({
        top: msgsRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [msgs]);

  // Parse URL params for code/pin
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const c = p.get("code"),
      pin0 = p.get("pin");
    if (c) setJoinCode(c);
    if (pin0) setJoinPin(pin0);
  }, []);

  // ----- WebRTC helpers -----
  async function setupPeer() {
    const pc = new RTCPeerConnection({ iceServers: iceRef.current });
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) socketRef.current?.emit("rtc:ice", { candidate: e.candidate });
    };

    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (remoteRef.current && ms) remoteRef.current.srcObject = ms;
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed") leaveCall();
    };

    return pc;
  }

  async function getLocalStream() {
    const wantsAudioOnly = voiceOnly || videoOff;
    const ms = await navigator.mediaDevices.getUserMedia(
      wantsAudioOnly ? AUDIO_ONLY : LOW_VIDEO
    );
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  }

  function stopStream(ms) {
    if (!ms) return;
    for (const t of ms.getTracks()) {
      try {
        t.stop();
      } catch {}
    }
  }

  // ----- Rooms -----
  function createRoom() {
    socketRef.current.emit(
      "create-room",
      { name: roomName, pin: joinPin.trim() || "" },
      (res) => {
        if (!res?.ok) return addMsg({ sys: true, ts: Date.now(), text: "Create failed" });
        setRoom(res.room);
        addMsg({
          sys: true,
          ts: Date.now(),
          text: `Created room: ${res.room.name} (${res.room.code})`,
        });
      }
    );
  }

  function joinRoom() {
    socketRef.current.emit(
      "join-room",
      { code: joinCode.trim(), pin: joinPin.trim() || "" },
      (res) => {
        if (!res?.ok)
          return addMsg({
            sys: true,
            ts: Date.now(),
            text: `Join failed: ${res?.error || ""}`,
          });
        setRoom(res.room);
        addMsg({
          sys: true,
          ts: Date.now(),
          text: `Joined room: ${res.room.name} (${res.room.code})`,
        });
      }
    );
  }

  function leaveRoom() {
    socketRef.current.emit("leave-room");
    setRoom(null);
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
    leaveCall();
  }

  function toggleLock() {
    if (!isHost) return;
    socketRef.current.emit("room:locked", (res) => {
      if (!res?.ok) return;
      setRoom((r) => (r ? { ...r, locked: res.locked } : r));
    });
  }

  // ----- Call control -----
  async function startCallHost() {
    if (!isHost || inCall || !room) return;
    setStarting(true);
    try {
      await new Promise((resolve) => socketRef.current.emit("room:live", true, resolve));
      iceRef.current = await getIceServers();

      const pc = await setupPeer();
      const ms = await getLocalStream();
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current.emit("rtc:offer", { offer });
      setInCall(true);
    } catch (e) {
      addMsg({ sys: true, ts: Date.now(), text: "Start failed" });
      socketRef.current.emit("room:live", false, () => {});
    } finally {
      setStarting(false);
    }
  }

  function endForAll() {
    if (!isHost || !room) return;
    socketRef.current.emit("end-for-all", () => {});
    leaveCall();
  }

  // Pre-permission button for guests
  async function joinCallGuest() {
    if (inCall || !room?.live) return;
    try {
      const ms = await navigator.mediaDevices.getUserMedia(
        voiceOnly ? AUDIO_ONLY : LOW_VIDEO
      );
      stopStream(ms); // we just want the permission + indicator
      addMsg({
        sys: true,
        ts: Date.now(),
        text: "Ready to join once host connects…",
      });
    } catch {
      addMsg({ sys: true, ts: Date.now(), text: "Mic/Camera permission denied" });
    }
  }

  function leaveCall() {
    setInCall(false);
    const pc = pcRef.current;
    pcRef.current = null;

    try {
      if (pc) {
        try {
          pc.getSenders?.().forEach((s) => s.track && s.track.stop?.());
        } catch {}
        try {
          pc.getTransceivers?.().forEach((t) => t.stop?.());
        } catch {}
        pc.close?.();
      }
    } catch {}

    const l = localRef.current?.srcObject;
    const r = remoteRef.current?.srcObject;
    if (l) {
      stopStream(l);
      localRef.current.srcObject = null;
    }
    if (r) {
      stopStream(r);
      remoteRef.current.srcObject = null;
    }
  }

  function toggleMute() {
    const ms = localRef.current?.srcObject;
    if (!ms) return;
    ms.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
    setMuted((m) => !m);
  }

  function toggleVideo() {
    const ms = localRef.current?.srcObject;
    if (!ms) return;
    ms.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
    setVideoOff((v) => !v);
  }

  async function copyInvite() {
    if (!room) return;
    const url = `${location.origin}?code=${room.code}${
      room.pin ? `&pin=${room.pin}` : ""
    }`;
    try {
      await navigator.clipboard.writeText(url);
      addMsg({ sys: true, ts: Date.now(), text: "Invite link copied" });
    } catch {}
  }

  // ----- UI -----
  return (
    <div className="shell">
      <div className="glass">
        <div className="head">
          <h1>{isHost ? "H2N Forum — Host" : "H2N Forum"}</h1>
          <span className="chip">
            {connected ? "Connected to server" : "Disconnected"}
          </span>
          <span className="chip-label">You:</span>
          <span className="chip-name">{me}</span>
          <span className="chip-edit">
            <input value={me} onChange={(e) => setMe(e.target.value)} />
          </span>
        </div>

        {room ? (
          <div className="row">
            <div className="inroom">
              In room: <b>{room.name || "Room"}</b>{" "}
              <span style={{ opacity: 0.85 }}>{room.code}</span>
            </div>
            <button className="link" onClick={copyInvite}>
              Copy invite
            </button>
            <button className="link" onClick={leaveRoom}>
              Leave
            </button>
          </div>
        ) : (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row">
              <label>Room name</label>
              <input value={roomName} onChange={(e) => setRoomName(e.target.value)} />
            </div>
            <div className="row">
              <label>PIN</label>
              <input
                value={joinPin}
                onChange={(e) => setJoinPin(e.target.value)}
                placeholder="PIN (if required)"
              />
            </div>
            <div className="row">
              <button className="btn primary" onClick={createRoom}>
                Create
              </button>
            </div>

            <div className="row title">Code + optional PIN</div>
            <div className="row">
              <label>6-digit code</label>
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="XXXXXX"
              />
              <input
                value={joinPin}
                onChange={(e) => setJoinPin(e.target.value)}
                placeholder="PIN (if required)"
              />
              <button className="btn" onClick={joinRoom}>
                Join
              </button>
            </div>
            <div className="hint">Rooms auto-delete after being empty for a while.</div>
          </>
        )}

        <div className="row callbar">
          {isHost && !inCall && (
            <button
              className="btn primary"
              disabled={starting}
              onClick={startCallHost}
            >
              {starting ? "Starting…" : "Start call"}
            </button>
          )}
          {!isHost && (
            <button
              className="btn primary"
              disabled={!room?.live || inCall}
              onClick={joinCallGuest}
            >
              Join call
            </button>
          )}
          <button className="btn" disabled={!inCall} onClick={toggleMute}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <button className="btn" disabled={!inCall} onClick={toggleVideo}>
            {videoOff ? "Camera On" : "Camera Off"}
          </button>
          {isHost && (
            <>
              <button className="btn danger" onClick={endForAll}>
                End call for all
              </button>
              <button className="btn" onClick={toggleLock}>
                {room?.locked ? "Unlock room" : "Lock room"}
              </button>
            </>
          )}
          <label className="chk" style={{ marginLeft: 8 }}>
            <input
              type="checkbox"
              checked={voiceOnly}
              onChange={(e) => setVoiceOnly(e.target.checked)}
            />
            <span>Voice only</span>
          </label>
        </div>

        <div className="media single">
          <div className="remotePane">
            <video ref={remoteRef} playsInline autoPlay />
          </div>
          <video ref={localRef} playsInline autoPlay muted className="pip" />
        </div>

        <div className="msgs" ref={msgsRef} style={{ marginTop: 12 }}>
          {msgs.map((m, i) => (
            <div key={i}>
              <div className={`bubble ${m.sys ? "sys" : ""}`}>
                <div className="meta">
                  <span className="who">{m.name}</span>
                  <span className="ts">
                    {new Date(m.ts).toLocaleTimeString()}
                  </span>
                </div>
                <div>{m.text}</div>
              </div>
            </div>
          ))}
        </div>

        <SendBox
          disabled={!room}
          onSend={(text) => {
            const t = String(text || "").trim();
            if (!t) return;
            const msg = { name: me, text: t, ts: Date.now() };
            socketRef.current.emit("chat", msg);
            addMsg(msg);
          }}
        />
      </div>
    </div>
  );
}

function SendBox({ disabled, onSend }) {
  const [text, setText] = useState("");
  return (
    <div className="send">
      <textarea
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const t = text.trim();
            if (t) onSend(t);
            setText("");
          }
        }}
      />
      <button
        className="btn primary"
        disabled={disabled}
        onClick={() => {
          const t = text.trim();
          if (t) onSend(t);
          setText("");
        }}
      >
        Send
      </button>
    </div>
  );
}
