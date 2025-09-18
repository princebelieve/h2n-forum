// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";

// ---------- config ----------
const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || ""; // e.g. https://h2nforum.vercel.app
const allowed = (CLIENT_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- http + ws ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket"],
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ---------- in-memory room store ----------
/**
 * rooms: Map<code, {
 *   code: string,
 *   name: string,
 *   pin?: string,
 *   hostId: string,
 *   locked: boolean,
 *   live: boolean,           // whether a call is active
 * }>
 */
const rooms = new Map();
const randCode = () => String(Math.floor(100000 + Math.random() * 900000));

// ---------- socket ----------
io.on("connection", (socket) => {
  socket.data.name = "Guest";
  socket.data.roomCode = null;

  socket.on("hello", (name) => {
    socket.data.name = String(name || "Guest").slice(0, 40);
  });

  // ----- rooms -----
  socket.on("create-room", ({ name, pin }, cb) => {
    const code = randCode();
    const room = {
      code,
      name: String(name || "Room").slice(0, 60),
      pin: pin ? String(pin).trim() : undefined,
      hostId: socket.id,
      locked: false,
      live: false,
    };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    cb?.({ ok: true, room });
    io.to(code).emit("chat", { sys: true, ts: Date.now(), text: `Created room: ${room.name} (${room.code})` });
  });

  socket.on("join-room", ({ code, pin }, cb) => {
    const rid = String(code || "").trim();
    const room = rooms.get(rid);
    if (!room) return cb?.({ ok: false, error: "room not found" });
    if (room.locked) return cb?.({ ok: false, error: "room is locked" });
    if (room.pin && room.pin !== String(pin || "").trim()) return cb?.({ ok: false, error: "wrong pin" });

    socket.join(rid);
    socket.data.roomCode = rid;
    cb?.({ ok: true, room });
    io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name} joined` });
  });

  socket.on("leave-room", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));

  function leaveRoom(sock) {
    const rid = sock.data.roomCode;
    if (!rid) return;
    sock.leave(rid);
    sock.data.roomCode = null;

    // if host leaves, announce and (optionally) end call
    const room = rooms.get(rid);
    if (room && room.hostId === sock.id) {
      io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: "Host ended the call" });
      io.to(rid).emit("end-call");
      room.live = false;
      // if room empties out, delete after a bit
      setTimeout(async () => {
        const left = await io.in(rid).fetchSockets();
        if (left.length === 0) rooms.delete(rid);
      }, 30000);
    }
  }

  // ----- text chat -----
  socket.on("chat", (text) => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    const msg =
      typeof text === "string"
        ? { name: socket.data.name, text: text, ts: Date.now() }
        : { name: socket.data.name, text: String(text?.text || ""), ts: text?.ts || Date.now() };
    io.to(rid).emit("chat", msg);
  });

  // ----- host controls -----
  socket.on("room:lock", (locked, cb) => {
    const rid = socket.data.roomCode;
    const room = rooms.get(rid);
    if (!room || room.hostId !== socket.id) return cb?.({ ok: false });
    room.locked = !!locked;
    io.to(rid).emit("room:locked", room.locked);
    cb?.({ ok: true, locked: room.locked });
  });

  socket.on("room:live", (live, cb) => {
    const rid = socket.data.roomCode;
    const room = rooms.get(rid);
    if (!room || room.hostId !== socket.id) return cb?.({ ok: false });
    room.live = !!live;
    io.to(rid).emit("room:live", room.live);
    cb?.({ ok: true, live: room.live });
  });

  socket.on("end-for-all", (cb) => {
    const rid = socket.data.roomCode;
    const room = rooms.get(rid);
    if (!room || room.hostId !== socket.id) return cb?.({ ok: false });
    room.live = false;
    io.to(rid).emit("end-call");
    io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: "Host ended the call" });
    cb?.({ ok: true });
  });

  // ----- WebRTC signalling -----
  // broadcast (host -> all, initial ring)
  socket.on("rtc:offer", ({ offer }, cb) => {
    const rid = socket.data.roomCode;
    if (!rid) return cb?.({ ok: false });
    const room = rooms.get(rid);
    if (!room || room.hostId !== socket.id) return cb?.({ ok: false });

    io.to(rid).except(socket.id).emit("rtc:offer", { offer });
    cb?.({ ok: true });
  });

  socket.on("rtc:answer", ({ answer }) => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    // answers from guests go only to host
    const room = rooms.get(rid);
    if (!room) return;
    io.to(room.hostId).emit("rtc:answer", { answer, from: socket.id });
  });

  socket.on("rtc:ice", ({ candidate }) => {
    const rid = socket.data.roomCode;
    if (!rid || !candidate) return;
    const room = rooms.get(rid);
    if (!room) return;

    // If host -> broadcast to others; if guest -> to host
    if (socket.id === room.hostId) {
      socket.to(rid).emit("rtc:ice", { candidate, from: socket.id });
    } else {
      io.to(room.hostId).emit("rtc:ice", { candidate, from: socket.id });
    }
  });

  // ---- targeted (needed when a guest joins late) ----
  socket.on("rtc:need-offer", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    io.to(room.hostId).emit("rtc:need-offer", { peerId: socket.id });
  });

  socket.on("rtc:offer-to", ({ offer, targetId }) => {
    if (!targetId) return;
    io.to(targetId).emit("rtc:offer-to", { from: socket.id, offer });
  });

  socket.on("rtc:answer-to", ({ answer, targetId }) => {
    if (!targetId) return;
    io.to(targetId).emit("rtc:answer-to", { from: socket.id, answer });
  });

  socket.on("rtc:ice-to", ({ candidate, targetId }) => {
    if (!targetId || !candidate) return;
    io.to(targetId).emit("rtc:ice-to", { from: socket.id, candidate });
  });
});

// ---------- start ----------
server.listen(PORT, () => {
  console.log(`H2N Forum server on :${PORT}`);
  console.log(`Allowed CORS origins: ${allowed.join(", ") || "(none)"}`);
});
