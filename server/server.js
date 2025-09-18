// server.js
// H2N Forum – multi-peer signaling + chat server (Express + Socket.IO)
// ESM module (package.json should have: "type": "module")

import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";

// ---------- Config ----------
const PORT = process.env.PORT || 3001;

// Comma-separated list of allowed browser origins (your frontends)
const allowedList = (
  process.env.CORS_ORIGINS ||
  // Add your domains here; you can override via env in production
  "https://h2nforum.vercel.app,http://localhost:5173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// How long to keep an empty room before deleting (ms)
const ROOM_EMPTY_TTL = 30_000;

// ---------- App / HTTP ----------
const app = express();

// Minimal CORS for REST endpoints (Socket.IO CORS is set separately)
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (!origin || allowedList.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    return next();
  }
  return res.status(403).json({ error: "CORS: origin not allowed" });
});

// Health + simple info
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "H2N Forum Signaling",
    cors: allowedList,
    time: new Date().toISOString(),
  });
});

// Optional: return ICE config if your client wants to fetch it
// (You can add TURN here later via env secrets.)
app.get("/ice", (_req, res) => {
  res.json({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478?transport=udp" },
    ],
  });
});

const server = http.createServer(app);

// ---------- Socket.IO ----------
const io = new SocketIOServer(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || allowedList.includes(origin)) return cb(null, true);
      return cb(new Error("Socket.IO CORS blocked"));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// ---------- In-memory state ----------
/**
 * rooms: Map<roomCode, {
 *   code: string,
 *   name: string,
 *   pin?: string,
 *   createdAt: number
 * }>
 */
const rooms = new Map();

// Helper to list peer IDs currently in a room
async function listPeers(roomCode) {
  const sockets = await io.in(roomCode).fetchSockets();
  return sockets.map((s) => s.id);
}

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  socket.data.name = "Guest";
  socket.data.roomCode = null;

  // Identify/self-name (optional from client)
  socket.on("whoami", ({ name } = {}) => {
    const n = String(name || "").trim();
    socket.data.name = n || socket.data.name || "Guest";
  });

  /* ---- Create room ----
     payload: { name?: string, code?: string, pin?: string }
  */
  socket.on("create-room", async ({ name, code, pin } = {}, ack) => {
    const roomName = String(name || "").trim() || "H2N Room";
    let roomCode = String(code || "").trim().toLowerCase();

    if (!roomCode) {
      // 6-digit short code
      roomCode = String(Math.floor(100000 + Math.random() * 900000));
    }
    if (rooms.has(roomCode)) {
      return ack?.({ ok: false, error: "Room code already exists" });
    }

    const room = {
      code: roomCode,
      name: roomName,
      pin: pin ? String(pin).trim() : undefined,
      createdAt: Date.now(),
    };
    rooms.set(roomCode, room);

    // join creator to room
    if (socket.data.roomCode) socket.leave(socket.data.roomCode);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    ack?.({
      ok: true,
      room: { code: roomCode, name: roomName, requiresPin: !!room.pin },
    });

    io.to(roomCode).emit("chat", {
      sys: true,
      ts: Date.now(),
      text: `Created room: ${roomName} (${roomCode})`,
    });
    io.to(roomCode).emit("room:updated", room);
  });

  /* ---- Join room ----
     payload: { code: string, pin?: string, name?: string }
     ack: { ok, error?, room?, peers? }
  */
  socket.on("join-room", async ({ code, pin, name } = {}, ack) => {
    const key = String(code || "").trim().toLowerCase();
    const room = rooms.get(key);
    if (!room) return ack?.({ ok: false, error: "Room not found" });

    if (room.pin && room.pin !== String(pin || "").trim()) {
      return ack?.({ ok: false, error: "Incorrect PIN" });
    }

    // set display name if provided
    const n = String(name || "").trim();
    if (n) socket.data.name = n;

    // move socket to requested room
    if (socket.data.roomCode) socket.leave(socket.data.roomCode);
    socket.join(room.code);
    socket.data.roomCode = room.code;

    const peers = (await listPeers(room.code)).filter((id) => id !== socket.id);

    ack?.({
      ok: true,
      room: { code: room.code, name: room.name, requiresPin: !!room.pin },
      peers, // existing peer IDs for mesh setup
    });

    io.to(room.code).emit("chat", {
      sys: true,
      ts: Date.now(),
      text: `${socket.data.name} joined`,
    });

    // Notify others that a new peer is available
    socket.to(room.code).emit("rtc:peer-joined", { peerId: socket.id });
  });

  /* ---- Leave room ---- */
  function leaveCurrentRoom() {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.leave(code);
    socket.to(code).emit("rtc:peer-left", { peerId: socket.id });
    socket.data.roomCode = null;

    io.to(code).emit("chat", {
      sys: true,
      ts: Date.now(),
      text: `${socket.data.name} left`,
    });

    // delete room after TTL if empty
    setTimeout(async () => {
      const sockets = await io.in(code).fetchSockets();
      if (sockets.length === 0) {
        rooms.delete(code);
        io.to(code).emit("room:deleted", { code });
      }
    }, ROOM_EMPTY_TTL);
  }
  socket.on("leave-room", leaveCurrentRoom);

  /* ---- Chat (compatible with multiple event names) ---- */
  function handleChat(payload) {
    const code = socket.data.roomCode;
    if (!code) return;
    const msg =
      typeof payload === "string"
        ? { name: socket.data.name, text: payload, ts: Date.now() }
        : {
            name: payload?.from || socket.data.name,
            text: String(payload?.text ?? ""),
            ts: payload?.ts || Date.now(),
          };
    io.to(code).emit("chat", msg);
    io.to(code).emit("message", msg); // legacy alias
  }
  socket.on("chat", handleChat);
  socket.on("chat:send", handleChat);
  socket.on("message", handleChat);

  /* ---- WebRTC signaling (multi-peer mesh)
     Two modes supported:
       1) Targeted (preferred): { to, offer/answer/candidate }
       2) Broadcast to roomId if 'to' missing (legacy)
  */
  function relayEvent(eventName, { roomId, to, ...rest } = {}) {
    const rid = roomId || socket.data.roomCode;
    if (!rid) return;

    if (to) {
      // direct to specific peer
      io.to(to).emit(eventName, { from: socket.id, ...rest });
    } else {
      // broadcast to everyone else in room
      socket.to(rid).emit(eventName, { from: socket.id, ...rest });
    }
  }

  socket.on("rtc:join", async ({ roomId } = {}) => {
    const rid = String(roomId || "").trim();
    if (!rid) return;
    if (socket.data.roomCode !== rid) {
      if (socket.data.roomCode) socket.leave(socket.data.roomCode);
      socket.join(rid);
      socket.data.roomCode = rid;
    }
    const peers = (await listPeers(rid)).filter((id) => id !== socket.id);
    socket.emit("rtc:peers", { peers }); // tell new peer who to connect to
    socket.to(rid).emit("rtc:peer-joined", { peerId: socket.id });
  });

  socket.on("rtc:leave", ({ roomId } = {}) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid) return;
    socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });
    if (socket.data.roomCode === rid) socket.leave(rid);
  });

  socket.on("rtc:offer", (p) => relayEvent("rtc:offer", p));
  socket.on("rtc:answer", (p) => relayEvent("rtc:answer", p));
  socket.on("rtc:ice", (p) => relayEvent("rtc:ice", p));

  socket.on("disconnect", () => {
    const rid = socket.data.roomCode;
    if (rid) socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`H2N Forum server running on http://localhost:${PORT}`);
  console.log(
    "Allowed CORS origins:",
    allowedList.length ? allowedList.join(", ") : "(none)"
  );
});
