// server.js — host-controlled 1:1 WebRTC signaling with late-join support

import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

// --- env ---
const PORT = Number(process.env.PORT || 3001);
const ORIGINS = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// --- app/io ---
const app = express();
app.use(cors({ origin: ORIGINS.length ? ORIGINS : true, credentials: true }));
app.get("/", (_req, res) => res.status(200).send("OK"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS.length ? ORIGINS : true, methods: ["GET", "POST"] },
  transports: ["websocket"],
  pingInterval: 20000,
  pingTimeout: 20000,
});

// --- rooms (in-memory) ---
// room = { code, name, pin, locked, hostId, live }
const rooms = new Map();
const code6 = () => String(Math.floor(100000 + Math.random() * 900000));

io.on("connection", (socket) => {
  socket.data = socket.data || {};
  socket.emit("connected", { id: socket.id });

  socket.on("hello", (name) => (socket.data.name = String(name || "Me")));

  // --- create room (host) ---
  socket.on("create-room", ({ name = "Room", pin = "" } = {}, ack) => {
    const code = code6();
    const room = {
      code,
      name: String(name || "Room").slice(0, 60),
      pin: String(pin || "").trim(),
      locked: false,
      hostId: socket.id,
      live: false,
    };
    rooms.set(code, room);

    if (socket.data.roomCode) socket.leave(socket.data.roomCode);
    socket.join(code);
    socket.data.roomCode = code;

    ack?.({ ok: true, room });
    io.to(code).emit("chat", { sys: true, ts: Date.now(), text: `Created room: ${room.name} (${room.code})` });
  });

  // --- join room (guest) ---
  socket.on("join-room", ({ code, pin = "" } = {}, ack) => {
    const rid = String(code || "").trim();
    const room = rooms.get(rid);
    if (!room) return ack?.({ ok: false, error: "room not found" });
    if (room.locked) return ack?.({ ok: false, error: "room locked" });
    if (room.pin && room.pin !== String(pin || "").trim()) return ack?.({ ok: false, error: "invalid pin" });

    if (socket.data.roomCode) socket.leave(socket.data.roomCode);
    socket.join(rid);
    socket.data.roomCode = rid;

    ack?.({ ok: true, room });
    socket.to(rid).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name || "Someone"} joined` });
  });

  // --- leave room ---
  socket.on("leave-room", () => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    const room = rooms.get(rid);

    socket.leave(rid);
    socket.data.roomCode = null;

    if (room && room.hostId === socket.id) {
      room.live = false;
      io.to(rid).emit("room:live", false);
      io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: "Host left the room" });
    } else {
      io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name || "Someone"} left` });
    }

    setTimeout(async () => {
      const sockets = await io.in(rid).fetchSockets();
      if (sockets.length === 0) rooms.delete(rid);
    }, 30000);
  });

  // --- host controls ---
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

  // --- chat ---
  socket.on("chat", (text) => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    const msg = { name: socket.data.name || "Anon", ts: Date.now(), text: String(text || "") };
    io.to(rid).emit("chat", msg);
  });

  // --- signaling (targeted; late-join friendly) ---
  // Guest asks the HOST to generate an offer specifically for them
  socket.on("rtc:need-offer", ({ roomId } = {}) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid) return;
    const r = rooms.get(rid);
    if (!r?.hostId) return;
    io.to(r.hostId).emit("rtc:make-offer", { to: socket.id });
  });

  // Host sends offer to one peer
  socket.on("rtc:offer-to", ({ to, offer } = {}) => {
    if (!to || !offer) return;
    io.to(to).emit("rtc:offer", { from: socket.id, offer });
  });

  // Peer answers back to specific sender
  socket.on("rtc:answer-to", ({ to, answer } = {}) => {
    if (!to || !answer) return;
    io.to(to).emit("rtc:answer", { from: socket.id, answer });
  });

  // ICE (targeted if "to" provided; else broadcast to room)
  socket.on("rtc:ice", ({ candidate, to, roomId } = {}) => {
    if (!candidate) return;
    if (to) {
      io.to(to).emit("rtc:ice", { from: socket.id, candidate });
    } else {
      const rid = roomId || socket.data.roomCode;
      if (rid) socket.to(rid).emit("rtc:ice", { from: socket.id, candidate });
    }
  });

  // --- disconnect ---
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
