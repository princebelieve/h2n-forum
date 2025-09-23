// src/App.jsx — Section 1: imports + refs + state
import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import "./App.css";

// ---- env / endpoints --------------------------------------------------------
const SERVER_URL =
  (import.meta.env?.VITE_SERVER_URL || "").split(",")[0]?.trim() ||
  window.location.origin;

const TURN_URL = (import.meta.env?.VITE_TURN_URL || "").trim(); // optional

// ---- component --------------------------------------------------------------
export default function App() {
  // ---- refs -----------------------------------------------------------------
  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const localRef = useRef(null);
  const remoteRef = useRef(null);

  // ICE list starts with public STUN; we may extend with TURN later
  const iceRef = useRef([{ urls: "stun:stun1.l.google.com:19302" }]);

  // who we are calling / who calls us
  const peerIdRef = useRef(null);

  // guest “ready” re-announce timer (prevents being stuck)
  const readyTimerRef = useRef(null);

  // audio elements (ringing / ringback)
  const incomingAudioRef = useRef(null);
  const ringbackAudioRef = useRef(null);

  // ---- state ----------------------------------------------------------------
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");

  const [room, setRoom] = useState({
    code: null,   // 6-digit code
    name: null,   // optional room name
    hostId: null, // socket id of current host
    locked: false,
    live: false,
  });

  // inputs
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  // flags
  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  // chat
  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);

  // derived
  const isHost = !!room.code && room.hostId === socketId;

  // small helper to push a message and keep last ~200
  const addMsg = (m) =>
    setMsgs((p) => (p.length > 199 ? [...p.slice(-190), m] : [...p, m]));

  // (handlers, effects, UI come in later sections)

// =========================
  // Section 2 — Helpers
  // =========================

  // -- call quality constraints --
  const AUDIO_ONLY = { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
  const LOW_VIDEO = {
    audio: { echoCancellation: true, noiseSuppression: true },
    video: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { max: 15 }, facingMode: "user" },
  };

  // -- tiny message helper --
  const sys = (text) => addMsg({ sys: true, ts: Date.now(), text });

  // -- sounds: preload + unlock after first tap/click --
  useEffect(() => {
    incomingAudioRef.current = new Audio("/sounds/incoming.mp3"); // callee ringtone
    incomingAudioRef.current.loop = true;
    ringbackAudioRef.current = new Audio("/sounds/ringback.mp3"); // caller tone
    ringbackAudioRef.current.loop = true;

    const unlock = () => {
      // best-effort unlock; ignore failures
      incomingAudioRef.current?.play().catch(()=>{});
      incomingAudioRef.current?.pause();
      incomingAudioRef.current && (incomingAudioRef.current.currentTime = 0);
      ringbackAudioRef.current?.play().catch(()=>{});
      ringbackAudioRef.current?.pause();
      ringbackAudioRef.current && (ringbackAudioRef.current.currentTime = 0);
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
    };
    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock,   { capture: true });

    return () => {
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock,   { capture: true });
    };
  }, []);

  const playIncoming  = () => { try { incomingAudioRef.current?.play(); } catch {} };
  const stopIncoming  = () => { try { incomingAudioRef.current?.pause(); incomingAudioRef.current.currentTime = 0; } catch {} };
  const playRingback  = () => { try { ringbackAudioRef.current?.play(); } catch {} };
  const stopRingback  = () => { try { ringbackAudioRef.current?.pause(); ringbackAudioRef.current.currentTime = 0; } catch {} };

  // -- TURN fetch (optional) + ICE merge --
  async function ensureIceServers() {
    if (!TURN_URL) return; // keep STUN-only if no TURN configured
    try {
      const res = await fetch(TURN_URL);
      if (!res.ok) throw new Error(`TURN ${res.status}`);
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) {
        // place TURN first, keep STUN as fallback
        iceRef.current = [...arr, { urls: "stun:stun1.l.google.com:19302" }];
      }
    } catch (e) {
      console.warn("TURN fetch failed, staying on STUN:", e?.message || e);
    }
  }

  // -- media helpers --
  async function getLocalStream(kind = "video") {
    const wantAudioOnly = kind === "audio";
    const ms = await navigator.mediaDevices.getUserMedia(wantAudioOnly || voiceOnly ? AUDIO_ONLY : LOW_VIDEO);
    if (localRef.current) localRef.current.srcObject = ms;
    return ms;
  }
  function stopStream(ms) {
    if (!ms) return;
    ms.getTracks?.().forEach(t => { try { t.stop(); } catch {} });
  }

  // -- RTCPeerConnection setup (shared by host/guest) --
  async function setupPeer() {
    await ensureIceServers();
    const pc = new RTCPeerConnection({ iceServers: iceRef.current });

    pc.onicecandidate = (e) => {
      if (!e.candidate || !peerIdRef.current) return;
      socketRef.current?.emit("rtc:ice", { to: peerIdRef.current, candidate: e.candidate });
    };

    pc.ontrack = (ev) => {
      const ms = ev.streams?.[0];
      if (remoteRef.current && ms) remoteRef.current.srcObject = ms;
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed") {
        leaveCall(); // will be defined later
      }
    };

    pcRef.current = pc;
    return pc;
  }
// =========================
  // Section 3 — Socket & RTC handlers
  // =========================
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
    socketRef.current = s;

    // --- connection ---
    const onConnect = () => {
      setConnected(true);
      setSocketId(s.id);
      s.emit("hello", me);
      sys("Connected to server");
    };
    const onDisconnect = () => setConnected(false);
    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);

    // --- chat ---
    s.on("chat", (m) => addMsg(m));

    // --- room live/lock broadcasts ---
    s.on("room:live", (payload) => {
      const live = typeof payload === "boolean" ? payload : payload?.live;
      setRoom((r) => ({ ...r, live }));
      if (!live) { stopIncoming(); stopRingback(); }
    });
    s.on("room:locked", (locked) => setRoom((r) => ({ ...r, locked })));

    // --- guest announces readiness (host hears ringtone) ---
    s.on("rtc:ready", ({ id }) => {
      // only host cares; remember the latest ready guest
      if (!id) return;
      if (!room?.code) return;
      // we can't use isHost from state here reliably inside handler,
      // but comparing with room.hostId is fine:
      if (room.hostId && room.hostId === s.id) {
        peerIdRef.current = id;
        playIncoming();
        sys("Guest is ready");
      }
    });

    // --- host receives guest's ICE / answer; both sides receive ICE ---
    s.on("rtc:answer", async ({ answer }) => {
      try { await pcRef.current?.setRemoteDescription(answer); } catch {}
    });

    s.on("rtc:ice", async ({ candidate }) => {
      if (!candidate) return;
      try { await pcRef.current?.addIceCandidate(candidate); } catch {}
    });

    // --- guest receives host offer -> stop ringback, answer immediately ---
    s.on("rtc:offer", async ({ offer, from }) => {
      stopRingback();
      if (from) peerIdRef.current = from;

      const pc = await setupPeer();
      const ms = await getLocalStream(voiceOnly ? "audio" : "video");
      ms.getTracks().forEach((t) => pc.addTrack(t, ms));

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.emit("rtc:answer", { to: from, answer });
      setInCall(true);
    });

    // --- server tells everyone to end ---
    s.on("end-call", () => leaveCall());

    return () => {
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
      s.off("chat");
      s.off("room:live");
      s.off("room:locked");
      s.off("rtc:ready");
      s.off("rtc:answer");
      s.off("rtc:ice");
      s.off("rtc:offer");
      s.off("end-call");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, room?.code, room?.hostId]);

  // persist name + re-hello
  useEffect(() => {
    localStorage.setItem("me", me);
    socketRef.current?.emit("hello", me);
  }, [me]);

  // scroll chat to bottom
  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  // prefill code/pin from URL once
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const c = q.get("code");
    const p = q.get("pin");
    if (c) setJoinCode(c);
    if (p) setJoinPin(p);
  }, []);
