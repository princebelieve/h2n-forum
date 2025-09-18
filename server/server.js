// server/server.js
// H2N Forum — Express + Socket.IO signaling server
// Features:
// - CORS allow-list via ORIGINS env (no code changes when you add domains)
// - Rooms (create/join/leave), chat
// - Multi-peer (mesh) WebRTC signaling for group voice/video
// - Health endpoint

import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

/* =========================
   Config (env-driven)
   ========================= */
const PORT = process.env.PORT || 3001;

// Comma-separated list of allowed origins. Example:
// ORIGINS="https://h2nforum.vercel.app,https://your-domain.com"
const ORIGINS = (process.env.ORIGINS || "https://h2nforum.vercel.app,http://localhost:5173")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Helper used by Express + Socket.IO
function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin/curl
  try {
    const o = new URL(origin).origin;
    return ORIGINS.includes(o);
  } catch {
    return false;
  }
}

/* =========================
   Express + HTTP
   ========================= */
const app = express();

app.use(cors({
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: true
}));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "H2N Forum Signaling",
    allowed: ORIGINS,
    ts: Date.now()
  });
});

const server = http.createServer(app);

/* =========================
   Socket.IO
   ========================= */
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true
  },
  transports: ["websocket", "polling"]
});

// In-memory rooms + peers
const rooms = new Map();            // code -> { code, name, pin, createdAt }
const roomPeers = new Map();        // code -> Set(socketId)
const ROOM_EMPTY_TTL = 30_000;

function getPeers(code) {
  if (!roomPeers.has(code)) roomPeers.set(code, new Set());
  return roomPeers.get(code);
}
function cleanupIfEmpty(code) {
  const peers = roomPeers.get(code);
  if (!peers || peers.size === 0) {
    roomPeers.delete(code);
    rooms.delete(code);
  }
}

io.on("connection", (socket) => {
  socket.data.name = `User-${socket.id.slice(0,4)}`;
  socket.data.roomCode = null;

  /* --- Identity (optional) --- */
  socket.on("set-name", (name = "", ack) => {
    const n = String(name || "").trim().slice(0, 40);
    if (n) socket.data.name = n;
    ack?.({ ok: true, name: socket.data.name });
  });

  /* --- Create room --- */
  socket.on("create-room", ({ name = "Room", code, pin } = {}, ack) => {
    const roomName = String(name || "Room").slice(0, 60);
    const roomCode = String(code || Math.floor(100000 + Math.random()*900000)).trim();
    if (rooms.has(roomCode)) return ack?.({ ok: false, error: "Code already in use" });

    const room = { code: roomCode, name: roomName, pin: pin ? String(pin) : null, createdAt: Date.now() };
    rooms.set(roomCode, room);

    // join creator
    if (socket.data.roomCode) {
      getPeers(socket.data.roomCode).delete(socket.id);
      socket.leave(socket.data.roomCode);
    }
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    getPeers(roomCode).add(socket.id);

    ack?.({ ok: true, room: { code: roomCode, name: roomName, requiresPin: !!room.pin } });

    io.to(roomCode).emit("chat", { sys: true, ts: Date.now(), text: `Created room: ${roomName} (${roomCode})` });
    io.to(roomCode).emit("rtc:peers", { roomId: roomCode, peers: [...getPeers(roomCode)] });
  });

  /* --- Join room --- */
  socket.on("join-room", ({ code, pin } = {}, ack) => {
    const key = String(code || "").trim();
    const room = rooms.get(key);
    if (!room) return ack?.({ ok: false, error: "Room not found" });
    if (room.pin && room.pin !== String(pin || "").trim()) {
      return ack?.({ ok: false, error: "Incorrect PIN" });
    }

    // move socket to room
    if (socket.data.roomCode) {
      getPeers(socket.data.roomCode).delete(socket.id);
      socket.leave(socket.data.roomCode);
      cleanupIfEmpty(socket.data.roomCode);
    }
    socket.join(key);
    socket.data.roomCode = key;
    getPeers(key).add(socket.id);

    ack?.({ ok: true, room: { code: key, name: room.name, requiresPin: !!room.pin } });

    io.to(key).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name} joined` });
    io.to(key).emit("rtc:peers", { roomId: key, peers: [...getPeers(key)] });
  });

  /* --- Leave room --- */
  function leaveCurrentRoom() {
    const code = socket.data.roomCode;
    if (!code) return;
    getPeers(code).delete(socket.id);
    socket.leave(code);
    socket.data.roomCode = null;

    io.to(code).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name} left` });
    io.to(code).emit("rtc:peer-left", { peerId: socket.id });
    io.to(code).emit("rtc:peers", { roomId: code, peers: [...getPeers(code)] });

    setTimeout(() => cleanupIfEmpty(code), 15_000);
  }
  socket.on("leave-room", leaveCurrentRoom);

  /* --- Chat --- */
  const handleChat = (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const msg = typeof payload === "string"
      ? { name: socket.data.name, text: payload, ts: Date.now() }
      : { name: payload?.from || socket.data.name, text: String(payload?.text ?? ""), ts: payload?.ts || Date.now() };
    io.to(code).emit("chat", msg);
    io.to(code).emit("message", msg); // legacy alias
  };
  socket.on("chat", handleChat);
  socket.on("chat:send", handleChat);
  socket.on("message", handleChat);

  /* --- WebRTC signaling (mesh) --- */
  socket.on("rtc:join", ({ roomId } = {}) => {
    const rid = String(roomId || "").trim();
    if (!rid) return;
    if (socket.data.roomCode !== rid) {
      if (socket.data.roomCode) {
        getPeers(socket.data.roomCode).delete(socket.id);
        socket.leave(socket.data.roomCode);
      }
      socket.join(rid);
      socket.data.roomCode = rid;
      getPeers(rid).add(socket.id);
    }
    socket.to(rid).emit("rtc:peer-joined", { peerId: socket.id });
    io.to(rid).emit("rtc:peers", { roomId: rid, peers: [...getPeers(rid)] });
  });

  socket.on("rtc:leave", ({ roomId } = {}) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid) return;
    getPeers(rid).delete(socket.id);
    socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });
    socket.leave(rid);
    if (socket.data.roomCode === rid) socket.data.roomCode = null;
    io.to(rid).emit("rtc:peers", { roomId: rid, peers: [...getPeers(rid)] });
    setTimeout(() => cleanupIfEmpty(rid), 15_000);
  });

  socket.on("rtc:offer", ({ roomId, offer }) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid || !offer) return;
    socket.to(rid).emit("rtc:offer", { from: socket.id, offer });
  });

  socket.on("rtc:answer", ({ roomId, answer }) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid || !answer) return;
    socket.to(rid).emit("rtc:answer", { from: socket.id, answer });
  });

  socket.on("rtc:ice", ({ roomId, candidate }) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid || !candidate) return;
    socket.to(rid).emit("rtc:ice", { from: socket.id, candidate });
  });

  socket.on("disconnect", () => {
    const rid = socket.data.roomCode;
    if (rid) {
      getPeers(rid).delete(socket.id);
      socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });
      io.to(rid).emit("rtc:peers", { roomId: rid, peers: [...getPeers(rid)] });
      setTimeout(() => cleanupIfEmpty(rid), 15_000);
    }
  });
});

/* =========================
   Start
   ========================= */
server.listen(PORT, () => {
  console.log(`H2N Forum server listening on http://localhost:${PORT}`);
  console.log("Allowed origins:", ORIGINS.join(", "));
});
