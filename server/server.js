// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";

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
 *   code, name, pin?, hostId, hostToken, locked, live
 * }>
 */
const rooms = new Map();
const randCode = () => String(Math.floor(100000 + Math.random() * 900000));
const randToken = () => crypto.randomBytes(16).toString("hex");

// ---------- socket ----------
io.on("connection", (socket) => {
  socket.data.name = "Guest";
  socket.data.roomCode = null;

  socket.on("hello", (name) => (socket.data.name = String(name || "Guest").slice(0, 40)));

  // ----- rooms -----
  socket.on("create-room", ({ name, pin }, cb) => {
    const code = randCode();
    const token = randToken();
    const room = {
      code,
      name: String(name || "Room").slice(0, 60),
      pin: pin ? String(pin).trim() : undefined,
      hostId: socket.id,
      hostToken: token,
      locked: false,
      live: false,
    };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    // Return token ONLY to creator
    cb?.({ ok: true, room, hostToken: token });
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

    const room = rooms.get(rid);
    if (room && room.hostId === sock.id) {
      io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: "Host ended the call" });
      io.to(rid).emit("end-call");
      room.live = false;
      setTimeout(async () => {
        const left = await io.in(rid).fetchSockets();
        if (left.length === 0) rooms.delete(rid);
      }, 30000);
    }
  }

  // ----- host (re)claim with token -----
  socket.on("claim-host", ({ code, token }, cb) => {
    const room = rooms.get(String(code || "").trim());
    if (!room) return cb?.({ ok: false, error: "room not found" });
    if (room.hostToken !== String(token || "")) return cb?.({ ok: false, error: "bad token" });
    room.hostId = socket.id; // transfer host to this socket
    socket.data.roomCode = room.code;
    socket.join(room.code);
    cb?.({ ok: true, room });
  });

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
  socket.on("rtc:offer", ({ offer }, cb) => {
    const rid = socket.data.roomCode;
    const room = rooms.get(rid);
    if (!rid || !room || room.hostId !== socket.id) return cb?.({ ok: false });
    io.to(rid).except(socket.id).emit("rtc:offer", { offer });
    cb?.({ ok: true });
  });

  socket.on("rtc:answer", ({ answer }) => {
    const rid = socket.data.roomCode;
    const room = rooms.get(rid);
    if (!rid || !room) return;
    io.to(room.hostId).emit("rtc:answer", { answer, from: socket.id });
  });

  socket.on("rtc:ice", ({ candidate }) => {
    const rid = socket.data.roomCode;
    const room = rooms.get(rid);
    if (!rid || !room || !candidate) return;
    if (socket.id === room.hostId) {
      socket.to(rid).emit("rtc:ice", { candidate, from: socket.id });
    } else {
      io.to(room.hostId).emit("rtc:ice", { candidate, from: socket.id });
    }
  });

  socket.on("rtc:need-offer", () => {
    const rid = socket.data.roomCode;
    const room = rooms.get(rid);
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

server.listen(PORT, () => {
  console.log(`H2N Forum server on :${PORT}`);
  console.log(`Allowed CORS origins: ${allowed.join(", ") || "(none)"}`);
});
