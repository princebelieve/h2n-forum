// server.js — H2N Forum signaling server

import express from "express";
import cors from "cors";
import http from "http";
import { Server as IOServer } from "socket.io";

// -------- Env & boot logs --------
const PORT = process.env.PORT || 3001;

// Comma-separated list of allowed origins
const rawOrigins = process.env.CLIENT_ORIGIN || "";
console.log("Render env CLIENT_ORIGIN =", JSON.stringify(process.env.CLIENT_ORIGIN));

const allowedOrigins = rawOrigins
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

console.log(
  "Allowed CORS origins parsed:", 
  allowedOrigins.length ? allowedOrigins : "(none)"
);

// -------- Express + CORS --------
const app = express();

// CORS for HTTP routes
const corsMiddleware = cors({
  origin: (origin, cb) => {
    // Allow same-origin/no-origin (mobile apps, curl, health checks)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS (HTTP): " + origin));
  },
  credentials: true,
  methods: ["GET", "POST"],
});
app.use(corsMiddleware);
app.use(express.json());

// health
app.get("/health", (_req, res) => {
  res.json({ ok: true, up: true, origins: allowedOrigins });
});

// -------- HTTP server + Socket.IO --------
const server = http.createServer(app);

// CORS for WebSocket (Socket.IO)
const io = new IOServer(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS (io): " + origin));
    },
    credentials: true,
    methods: ["GET", "POST"],
  },
});

// -------- In-memory rooms --------
// room = { code, name, hostId, locked:false, live:false, members:Set<socketId> }
const rooms = new Map();

function getRoomByCode(code) {
  return rooms.get(code);
}

function leaveAllRooms(socket) {
  for (const r of rooms.values()) {
    if (r.members.has(socket.id)) {
      r.members.delete(socket.id);

      io.to([...r.members]).emit("chat", {
        sys: true,
        ts: Date.now(),
        text: `${socket.data.name || "Someone"} left`,
      });

      // if host left: end call for all and unlock/live false
      if (r.hostId === socket.id) {
        io.to([...r.members]).emit("end-call");
        r.live = false;
        io.to([...r.members]).emit("room:live", false);
        r.hostId = null; // room remains; can be reclaimed by next joiner if you prefer
      }

      if (r.members.size === 0) rooms.delete(r.code);
    }
  }
}

// -------- Socket handlers --------
io.on("connection", (socket) => {
  socket.data.name = "Guest";
  socket.emit("chat", { sys: true, ts: Date.now(), text: "Connected to server" });

  socket.on("hello", (name = "") => {
    if (typeof name === "string" && name.trim()) socket.data.name = name.trim();
  });

  socket.on("chat:send", (msg = "") => {
    const text = String(msg || "").slice(0, 500);
    io.emit("chat", { sys: false, ts: Date.now(), text, who: socket.data.name });
  });

  // ---- rooms
  socket.on("create-room", ({ name = "Room", pin = "" } = {}, cb = () => {}) => {
    try {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const room = {
        code,
        name,
        pin: String(pin || ""),
        hostId: socket.id,
        locked: false,
        live: false,
        members: new Set(),
      };
      rooms.set(code, room);
      socket.join(code);
      room.members.add(socket.id);

      cb({ ok: true, room: { code, name, hostId: room.hostId, locked: room.locked, live: room.live } });
      socket.emit("chat", { sys: true, ts: Date.now(), text: `Created room: ${name} (${code})` });
    } catch (e) {
      cb({ ok: false, error: e?.message || "create-room failed" });
    }
  });

  socket.on("join-room", ({ code = "", pin = "" } = {}, cb = () => {}) => {
    try {
      const room = getRoomByCode(String(code).trim());
      if (!room) return cb({ ok: false, error: "room not found" });
      if (room.locked) return cb({ ok: false, error: "room locked" });
      if (room.pin && String(pin) !== room.pin) return cb({ ok: false, error: "invalid PIN" });

      socket.join(room.code);
      room.members.add(socket.id);
      cb({ ok: true, room: { code: room.code, name: room.name, hostId: room.hostId, locked: room.locked, live: room.live } });
      io.to(room.code).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name} joined` });
    } catch (e) {
      cb({ ok: false, error: e?.message || "join-room failed" });
    }
  });

  socket.on("leave-room", () => {
    leaveAllRooms(socket);
  });

  // ---- host controls
  socket.on("room:lock", (locked, cb = () => {}) => {
    try {
      const room = [...rooms.values()].find(r => r.hostId === socket.id);
      if (!room) return cb({ ok: false });
      room.locked = !!locked;
      io.to(room.code).emit("room:locked", room.locked);
      cb({ ok: true, locked: room.locked });
    } catch {
      cb({ ok: false });
    }
  });

  socket.on("room:live", (live, cb = () => {}) => {
    try {
      const room = [...rooms.values()].find(r => r.hostId === socket.id);
      if (!room) return cb({ ok: false });
      room.live = !!live;
      io.to(room.code).emit("room:live", room.live);
      cb({ ok: true, live: room.live });
    } catch {
      cb({ ok: false });
    }
  });

  socket.on("end-for-all", (cb = () => {}) => {
    try {
      const room = [...rooms.values()].find(r => r.hostId === socket.id);
      if (room) {
        io.to(room.code).emit("end-call");
        room.live = false;
        io.to(room.code).emit("room:live", false);
      }
      cb({ ok: true });
    } catch {
      cb({ ok: false });
    }
  });

  // ---- WebRTC signaling passthrough
  socket.on("rtc:offer", ({ offer } = {}) => {
    for (const r of rooms.values()) {
      if (r.members.has(socket.id)) {
        socket.to(r.code).emit("rtc:offer", { offer, from: socket.id, name: socket.data.name });
      }
    }
  });

  socket.on("rtc:answer", ({ answer } = {}) => {
    for (const r of rooms.values()) {
      if (r.members.has(socket.id)) {
        socket.to(r.code).emit("rtc:answer", { answer, from: socket.id });
      }
    }
  });

  socket.on("rtc:ice", ({ candidate } = {}) => {
    for (const r of rooms.values()) {
      if (r.members.has(socket.id)) {
        socket.to(r.code).emit("rtc:ice", { candidate, from: socket.id });
      }
    }
  });

  socket.on("disconnect", () => {
    leaveAllRooms(socket);
  });
});

// -------- Start --------
server.listen(PORT, () => {
  console.log(`H2N Forum server on :${PORT}`);
  console.log("CORS ready for:", allowedOrigins);
});
