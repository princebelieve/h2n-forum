// === H2N Forum — fresh App.jsx (Section 1/8) ===============================
// Imports, env, theme, and audio helpers

import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";

// If you set VITE_SERVER_URL to "wss://your-server" or "https://your-server"
// we’ll use that. Otherwise, default to same-origin.
const SERVER_URL = (import.meta.env.VITE_SERVER_URL || "").split(",")[0]?.trim() || undefined;

// Optional TURN fetch endpoint that returns either
//   [{ urls: "...", username, credential }, ...]
// or { iceServers: [ ... ] }
const TURN_URL = (import.meta.env.VITE_TURN_URL || "").trim();

// --- theme (navy + gold) ----------------------------------------------------
const theme = {
  bg: "#0b1625",
  panel: "#0f2136",
  card: "#122842",
  chip: "#0e1f36",
  text: "#d6e2f3",
  subtext: "#a9bbd4",
  gold: "#f5c96a",
  btn: "#173754",
  btnHover: "#1d4467",
  danger: "#e45858",
  ok: "#2caa72",
  border: "rgba(255,255,255,0.08)",
};

// Simple utility classes inline
const styles = {
  app: {
    minHeight: "100vh",
    background: theme.bg,
    color: theme.text,
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    padding: "16px",
  },
  shell: {
    maxWidth: 960,
    margin: "0 auto",
    background: theme.panel,
    borderRadius: 16,
    border: `1px solid ${theme.border}`,
    boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
    overflow: "hidden",
  },
  head: {
    padding: "20px 24px",
    background: theme.card,
    borderBottom: `1px solid ${theme.border}`,
  },
  row: { padding: "16px 24px" },
  pill: (ok) => ({
    display: "inline-block",
    padding: "6px 10px",
    borderRadius: 12,
    background: ok ? theme.ok : theme.btn,
    color: "white",
    fontSize: 12,
    marginLeft: 8,
  }),
  chip: {
    display: "inline-block",
    padding: "6px 10px",
    borderRadius: 12,
    background: theme.chip,
    color: theme.text,
    fontSize: 12,
    marginLeft: 8,
    border: `1px solid ${theme.border}`,
  },
  label: { color: theme.subtext, fontSize: 14, marginBottom: 8 },
  input: {
    width: "100%",
    background: "#0b1b2d",
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: 10,
    padding: "12px 14px",
    outline: "none",
  },
  btn: {
    background: theme.gold,
    color: "#0b1625",
    border: "none",
    borderRadius: 12,
    padding: "12px 18px",
    fontWeight: 600,
    cursor: "pointer",
  },
  btnGhost: {
    background: theme.btn,
    color: theme.text,
    border: `1px solid ${theme.border}`,
    borderRadius: 12,
    padding: "12px 18px",
    fontWeight: 600,
    cursor: "pointer",
  },
  btnDanger: {
    background: theme.danger,
    color: "white",
    border: "none",
    borderRadius: 12,
    padding: "12px 18px",
    fontWeight: 600,
    cursor: "pointer",
  },
  grid2: { display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" },
  media: {
    background: "black",
    borderRadius: 12,
    border: `1px solid ${theme.border}`,
    width: "100%",
    aspectRatio: "16/9",
  },
  pip: {
    position: "absolute",
    right: 16,
    bottom: 16,
    width: 140,
    height: 90,
    background: "black",
    border: `2px solid ${theme.border}`,
    borderRadius: 12,
  },
  msg: {
    background: theme.card,
    border: `1px solid ${theme.border}`,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
  },
};

// --- audio helpers (ringback / incoming) ------------------------------------
const ringback = new Audio("/sounds/ringback.mp3");
ringback.loop = true;
const incomingTone = new Audio("/sounds/incoming.mp3");
incomingTone.loop = true;

function safePlay(a) {
  try { a.currentTime = 0; a.play(); } catch { /* ignore autoplay limits */ }
}
function safeStop(a) {
  try { a.pause(); a.currentTime = 0; } catch { /* noop */ }
}

// Build ICE list (TURN→fallback STUN).
async function getIceServers() {
  try {
    if (!TURN_URL) throw new Error("no TURN_URL");
    const res = await fetch(TURN_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`TURN fetch ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data?.iceServers ?? data);
    if (!Array.isArray(list) || list.length === 0) throw new Error("Empty TURN list");
    return list;
  } catch (err) {
    console.warn("TURN fetch failed, fallback to STUN:", err?.message || err);
    return [{ urls: "stun:stun1.l.google.com:19302" }];
  }
}

// === Section 2/8 — component refs & state ===================================

export default function App() {
  // ---- refs -----------------------------------------------------------------
  const socketRef = useRef(null);
  const iceRef = useRef([{ urls: "stun:stun1.l.google.com:19302" }]);
  const pcRef = useRef(null);
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const peerIdRef = useRef(null);       // who we call / who calls us
  const readyTimerRef = useRef(null);   // guest “I’m ready” re-announce timer

  // ---- state ----------------------------------------------------------------
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);
  const [me, setMe] = useState(() => localStorage.getItem("me") || "Me");

  const [room, setRoom] = useState({
    code: null,       // 6-digit room code
    name: null,       // optional display name
    hostId: null,     // socket id of host
    locked: false,    // room locked?
    live: false,      // host pressed Start?
  });

  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");

  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  const [voiceOnly, setVoiceOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  const [msgs, setMsgs] = useState([]);
  const msgsRef = useRef(null);

  // derived
  const isHost = !!room.code && room.hostId === socketId;

  // helper to push chat/system messages (de-duped at 200 items)
  const addMsg = (m) =>
    setMsgs((p) => (p.length > 199 ? [...p.slice(-190), m] : [...p, m]));

  // persist display name
  useEffect(() => {
    localStorage.setItem("me", me);
  }, [me]);

// === Section 3/8 — socket lifecycle & event handlers ========================

useEffect(() => {
  const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
  socketRef.current = s;

  // ---- connection events ----------------------------------------------------
  const onConnect = () => {
    setConnected(true);
    setSocketId(s.id);
    // IMPORTANT: do NOT add a local "Connected to server" message here.
    // The server usually emits one; skipping avoids duplicates.
  };
  const onDisconnect = () => setConnected(false);

  s.on("connect", onConnect);
  s.on("disconnect", onDisconnect);

  // ---- chat feed ------------------------------------------------------------
  const onChat = (m) => setMsgs((p) => (p.length > 199 ? [...p.slice(-190), m] : [...p, m]));
  s.on("chat", onChat);

  // ---- room state -----------------------------------------------------------
  s.on("room:live", (payload) => {
    const live = typeof payload === "boolean" ? payload : payload?.live;
    setRoom((r) => ({ ...r, live }));
  });

  s.on("room:locked", (locked) => setRoom((r) => ({ ...r, locked })));

  // ---- guest readiness -> host reacts --------------------------------------
  s.on("rtc:ready", ({ id }) => {
    // If I'm host and call is live, start a call to that specific guest
    if (!room?.live) return;
    if (room.hostId !== s.id) return; // not host
    peerIdRef.current = id;
    startCallHost(id);
  });

  // ---- signaling: host<->guest ---------------------------------------------
  s.on("rtc:offer", async ({ offer, from }) => {
    // I'm the guest receiving an offer from the host
    if (pcRef.current) return; // already have a peer
    peerIdRef.current = from;

    const pc = await setupPeer();
    const ms = await getLocalStream();
    ms.getTracks().forEach((t) => pc.addTrack(t, ms));

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    s.emit("rtc:answer", { to: from, answer });
    setInCall(true);
  });

  s.on("rtc:answer", async ({ answer }) => {
    // I'm the host who had created an offer; now set guest's answer
    if (!pcRef.current) return;
    try { await pcRef.current.setRemoteDescription(answer); } catch {}
  });

  s.on("rtc:ice", async ({ candidate }) => {
    if (!pcRef.current || !candidate) return;
    try { await pcRef.current.addIceCandidate(candidate); } catch {}
  });

  return () => {
    s.off("connect", onConnect);
    s.off("disconnect", onDisconnect);
    s.off("chat", onChat);
    s.off("room:live");
    s.off("room:locked");
    s.off("rtc:ready");
    s.off("rtc:offer");
    s.off("rtc:answer");
    s.off("rtc:ice");
    // keep socket connection for page lifetime; do not disconnect here
  };
}, [room.live]); // re-bind some handlers when call state toggles

  
// === Section 3/8 — socket lifecycle & event handlers ========================

useEffect(() => {
  const s = io(SERVER_URL, { transports: ["websocket"], reconnection: true });
  socketRef.current = s;

  // ---- connection events ----------------------------------------------------
  const onConnect = () => {
    setConnected(true);
    setSocketId(s.id);
    // IMPORTANT: do NOT add a local "Connected to server" message here.
    // The server usually emits one; skipping avoids duplicates.
  };
  const onDisconnect = () => setConnected(false);

  s.on("connect", onConnect);
  s.on("disconnect", onDisconnect);

  // ---- chat feed ------------------------------------------------------------
  const onChat = (m) => setMsgs((p) => (p.length > 199 ? [...p.slice(-190), m] : [...p, m]));
  s.on("chat", onChat);

  // ---- room state -----------------------------------------------------------
  s.on("room:live", (payload) => {
    const live = typeof payload === "boolean" ? payload : payload?.live;
    setRoom((r) => ({ ...r, live }));
  });

  s.on("room:locked", (locked) => setRoom((r) => ({ ...r, locked })));

  // ---- guest readiness -> host reacts --------------------------------------
  s.on("rtc:ready", ({ id }) => {
    // If I'm host and call is live, start a call to that specific guest
    if (!room?.live) return;
    if (room.hostId !== s.id) return; // not host
    peerIdRef.current = id;
    startCallHost(id);
  });

  // ---- signaling: host<->guest ---------------------------------------------
  s.on("rtc:offer", async ({ offer, from }) => {
    // I'm the guest receiving an offer from the host
    if (pcRef.current) return; // already have a peer
    peerIdRef.current = from;

    const pc = await setupPeer();
    const ms = await getLocalStream();
    ms.getTracks().forEach((t) => pc.addTrack(t, ms));

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    s.emit("rtc:answer", { to: from, answer });
    setInCall(true);
  });

  s.on("rtc:answer", async ({ answer }) => {
    // I'm the host who had created an offer; now set guest's answer
    if (!pcRef.current) return;
    try { await pcRef.current.setRemoteDescription(answer); } catch {}
  });

  s.on("rtc:ice", async ({ candidate }) => {
    if (!pcRef.current || !candidate) return;
    try { await pcRef.current.addIceCandidate(candidate); } catch {}
  });

  return () => {
    s.off("connect", onConnect);
    s.off("disconnect", onDisconnect);
    s.off("chat", onChat);
    s.off("room:live");
    s.off("room:locked");
    s.off("rtc:ready");
    s.off("rtc:offer");
    s.off("rtc:answer");
    s.off("rtc:ice");
    // keep socket connection for page lifetime; do not disconnect here
  };
}, [room.live]); // re-bind some handlers when call state toggles

// === Section 4/8 — WebRTC helpers ==========================================

// Ensure we have TURN/STUN list in iceRef.current
async function ensureIce() {
  try {
    const list = await getIceServers();
    iceRef.current = list && list.length ? list : [{ urls: "stun:stun1.l.google.com:19302" }];
  } catch {
    iceRef.current = [{ urls: "stun:stun1.l.google.com:19302" }];
  }
}

// Create peer connection & wire events
async function setupPeer() {
  if (!iceRef.current || !iceRef.current.length) {
    await ensureIce();
  }

  const pc = new RTCPeerConnection({ iceServers: iceRef.current });
  pcRef.current = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socketRef.current?.emit("rtc:ice", { candidate: e.candidate });
    }
  };

  pc.ontrack = (ev) => {
    const ms = ev.streams?.[0];
    if (remoteRef.current && ms) {
      remoteRef.current.srcObject = ms;
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") {
      // stop any ringing
      safeStop(ringback);
      safeStop(incomingTone);
    }
    if (s === "failed" || s === "disconnected" || s === "closed") {
      // clean up UI/audio; we will mark inCall=false and stop streams
      safeStop(ringback);
      safeStop(incomingTone);
      try { disposeLocal(); } catch {}
      setInCall(false);
    }
  };

  return pc;
}

// Ask for mic/camera; obey voiceOnly or explicit kind
async function getLocalStream(kind) {
  const useAudioOnly = kind ? (kind === "audio") : voiceOnly;
  const constraints = useAudioOnly
    ? { audio: { echoCancellation: true, noiseSuppression: true }, video: false }
    : {
        audio: { echoCancellation: true, noiseSuppression: true },
        video: {
          width: { ideal: 640, max: 640 },
          height: { ideal: 360, max: 360 },
          frameRate: { max: 15 },
          facingMode: "user",
        },
      };

  const ms = await navigator.mediaDevices.getUserMedia(constraints);
  if (localRef.current) localRef.current.srcObject = ms;
  return ms;
}

// Stop all tracks of a MediaStream safely
function stopStream(ms) {
  if (!ms) return;
  try { ms.getTracks().forEach((t) => { try { t.stop(); } catch {} }); } catch {}
}

// Clear local/remote video elements & stop tracks
function disposeLocal() {
  const ls = localRef.current?.srcObject;
  if (ls) {
    stopStream(ls);
    try { localRef.current.srcObject = null; } catch {}
  }
  const rs = remoteRef.current?.srcObject;
  if (rs) {
    stopStream(rs);
    try { remoteRef.current.srcObject = null; } catch {}
  }
}
// === Section 5/8 — Room actions ============================================

// Create a room
function createRoom() {
  socketRef.current?.emit("create-room", { name: roomName, pin }, (res) => {
    if (!res?.ok) {
      return addMsg({ sys: true, ts: Date.now(), text: "Create failed" });
    }
    setRoom(res.room);
    addMsg({ sys: true, ts: Date.now(), text: `Created room: ${res.room.name} (${res.room.code})` });
  });
}

// Join a room
function joinRoom() {
  socketRef.current?.emit("join-room", { code: joinCode.trim(), pin: joinPin.trim() }, (res) => {
    if (!res?.ok) {
      return addMsg({ sys: true, ts: Date.now(), text: `Join failed: ${res?.error || ""}` });
    }
    setRoom(res.room);
    addMsg({ sys: true, ts: Date.now(), text: `Joined room: ${res.room.name} (${res.room.code})` });
  });
}

// Leave a room
function leaveRoom() {
  socketRef.current?.emit("leave-room");
  setRoom(null);
  leaveCall();
  addMsg({ sys: true, ts: Date.now(), text: "Left room" });
}

// Send a chat message
function sendChat(text) {
  const t = String(text || "").trim();
  if (!t) return;
  const msg = { name: me, text: t, ts: Date.now() };
  socketRef.current?.emit("chat", msg);
  addMsg(msg);
}

// === Section 6/8 — Call controls ===========================================

// Host starts a call (optionally to a specific guest id)
async function startCallHost(targetId) {
  if (!room?.code) return;
  if (inCall || starting) return;
  setStarting(true);
  try {
    await ensureIce();

    // Flip room live so guests see "Join call"
    await new Promise((resolve) =>
      socketRef.current?.emit("room:live", true, resolve)
    );

    const pc = await setupPeer();
    const ms = await getLocalStream();
    ms.getTracks().forEach((t) => pc.addTrack(t, ms));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // ringback while we wait for answer
    safePlay(ringback);

    // Broadcast (or target) the offer
    if (targetId) {
      socketRef.current?.emit("rtc:offer", { offer, to: targetId });
      peerIdRef.current = targetId;
    } else {
      socketRef.current?.emit("rtc:offer", { offer });
    }

    setInCall(true);
  } catch (e) {
    console.error("startCallHost error:", e);
    addMsg({ sys: true, ts: Date.now(), text: "Start failed" });
    socketRef.current?.emit("room:live", false, () => {});
  } finally {
    setStarting(false);
  }
}

// Guest signals readiness; host will call this guest
function joinCallGuest() {
  if (!room?.code) return;
  if (inCall) return;

  // Prompt permissions early (so accept prompt doesn't block SDP)
  (async () => {
    try {
      const test = await navigator.mediaDevices.getUserMedia(
        voiceOnly
          ? { audio: { echoCancellation: true, noiseSuppression: true }, video: false }
          : {
              audio: { echoCancellation: true, noiseSuppression: true },
              video: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { max: 15 } },
            }
      );
      test.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore; host can still send an offer which will prompt
    }
  })();

  // Tell host "I'm ready" (and re-announce a couple times)
  const id = socketRef.current?.id;
  socketRef.current?.emit("rtc:ready", { id });
  addMsg({ sys: true, ts: Date.now(), text: "Ready to join…" });

  clearInterval(readyTimerRef.current);
  let count = 0;
  readyTimerRef.current = setInterval(() => {
    if (count++ >= 3 || inCall) {
      clearInterval(readyTimerRef.current);
      return;
    }
    socketRef.current?.emit("rtc:ready", { id });
  }, 2500);
}

// Host ends call for everyone
function endForAll() {
  if (!room?.code) return;
  socketRef.current?.emit("end-for-all", () => {});
  safeStop(ringback);
  safeStop(incomingTone);
  disposeLocal();
  setInCall(false);
}

// Local-only hangup (leave current peer without ending room for all)
function leaveCallLocal() {
  safeStop(ringback);
  safeStop(incomingTone);
  disposeLocal();
  setInCall(false);
  try { pcRef.current?.close(); } catch {}
  pcRef.current = null;
}

// Toggle audio/video tracks
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

// Utility: copy invite link
async function copyInvite() {
  if (!room?.code) return;
  const url = new URL(location.href);
  url.searchParams.set("code", room.code);
  if (room?.pin) url.searchParams.set("pin", room.pin);
  const txt = url.toString();
  try { await navigator.clipboard.writeText(txt); addMsg({ sys: true, ts: Date.now(), text: "Invite link copied" }); }
  catch { addMsg({ sys: true, ts: Date.now(), text: txt }); }
}

