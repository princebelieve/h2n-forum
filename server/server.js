// server.js
// Minimal Socket.IO signalling server with host controls

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

// ---- env ----
const PORT = Number(process.env.PORT || 3001);
const ORIGINS = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ---- app/io ----
const app = express();
app.use(cors({ origin: ORIGINS.length ? ORIGINS : true, credentials: true }));
app.get("/", (_, res) => res.status(200).send("OK"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS.length ? ORIGINS : true, methods: ["GET", "POST"] },
  transports: ["websocket"],
  pingInterval: 20000,
  pingTimeout: 20000,
});

// ---- in-memory rooms ----
// room = { code, name, pin, locked, hostId, live }
const rooms = new Map();
const makeCode = () => String(Math.floor(100000 + Math.random() * 900000));

io.on("connection", (socket) => {
  socket.data = socket.data || {};
  socket.emit("connected", { id: socket.id });

  socket.on("hello", (name) => { socket.data.name = String(name || ""); });

  // ---- create room (host) ----
  socket.on("create-room", ({ name = "Room", pin = "" } = {}, ack) => {
    const code = makeCode();
    const room = {
      code,
      name: String(name || "Room").slice(0, 60),
      pin: String(pin || "").trim(),
      locked: false,
      hostId: socket.id,
      live: false,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    ack?.({ ok: true, room });
    io.to(code).emit("chat", { sys: true, ts: Date.now(), text: `Created room: ${room.name} (${room.code})` });
  });

  // ---- join room (guest) ----
  socket.on("join-room", ({ code, pin = "" } = {}, ack) => {
    const rid = String(code || "").trim();
    const room = rooms.get(rid);
    if (!room) return ack?.({ ok: false, error: "room not found" });
    if (room.locked) return ack?.({ ok: false, error: "room locked" });
    if (room.pin && room.pin !== String(pin || "").trim()) return ack?.({ ok: false, error: "invalid pin" });

    socket.join(rid);
    socket.data.roomCode = rid;
    ack?.({ ok: true, room });
    socket.to(rid).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name || "Someone"} joined` });
  });

  // ---- leave room ----
  socket.on("leave-room", () => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    socket.leave(rid);
    socket.data.roomCode = null;

    const room = rooms.get(rid);
    if (room && room.hostId === socket.id) {
      // host left -> end call, unlock, keep room for a bit
      room.live = false;
      io.to(rid).emit("room:live", false);
      io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: "Host left the room" });
    } else {
      io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name || "Someone"} left` });
    }

    // auto-delete if empty
    setTimeout(async () => {
      const sockets = await io.in(rid).fetchSockets();
      if (sockets.length === 0) rooms.delete(rid);
    }, 30000);
  });

  // ---- host controls ----
  socket.on("room:lock", (locked, ack) => {
    const rid = socket.data.roomCode;
    const room = rid && rooms.get(rid);
    if (!room) return ack?.({ ok: false });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: "not host" });
    room.locked = !!locked;
    io.to(rid).emit("room:locked", room.locked);
    ack?.({ ok: true, locked: room.locked });
  });

  socket.on("room:live", (live, ack) => {
    const rid = socket.data.roomCode;
    const room = rid && rooms.get(rid);
    if (!room) return ack?.({ ok: false });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: "not host" });
    room.live = !!live;
    io.to(rid).emit("room:live", room.live);
    ack?.({ ok: true, live: room.live });
  });

  socket.on("end-for-all", (ack) => {
    const rid = socket.data.roomCode;
    const room = rid && rooms.get(rid);
    if (!room) return ack?.({ ok: false });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: "not host" });
    room.live = false;
    io.to(rid).emit("room:live", false);
    io.to(rid).emit("end-call");
    io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: "Host ended the call" });
    ack?.({ ok: true });
  });

  // ---- chat ----
  socket.on("chat", (text) => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    const msg = { name: socket.data.name || "Anon", ts: Date.now(), text: String(text || "") };
    io.to(rid).emit("chat", msg);
  });

  // ---- WebRTC signalling (room-wide broadcast = simple mesh) ----
  socket.on("rtc:offer", ({ offer } = {}) => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    socket.to(rid).emit("rtc:offer", { from: socket.id, offer });
  });
  socket.on("rtc:answer", ({ answer } = {}) => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    socket.to(rid).emit("rtc:answer", { from: socket.id, answer });
  });
  socket.on("rtc:ice", ({ candidate } = {}) => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    socket.to(rid).emit("rtc:ice", { from: socket.id, candidate });
  });

  // ---- disconnect ----
  socket.on("disconnect", () => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    const room = rooms.get(rid);
    if (room && room.hostId === socket.id) {
      room.live = false;
      io.to(rid).emit("room:live", false);
      io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: "Host disconnected" });
    }
  });
});

server.listen(PORT, () => {
  console.log(`H2N signalling on :${PORT}`);
  console.log("Allowed origins:", ORIGINS.join(", ") || "(any)");
});
