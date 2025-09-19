// server.js
// Minimal Socket.IO signaling server with rooms, host role, lock, and "live" (start call)
// Works with your current App.jsx

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const PORT = process.env.PORT || 3001;
const ALLOW = (process.env.CORS_ALLOW || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.use(cors({
  origin: (origin, cb) => cb(null, true), // keep simple; front-end does its own domain
  credentials: true
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

// Rooms map:
// code => { code, name, pin?, hostId, locked:false, live:false, lastActive: Date.now(), members:Set<socketId> }
const rooms = new Map();

function randCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function now() { return Date.now(); }

function getRoomOf(socket) {
  const rcode = socket.data.roomCode;
  return rcode ? rooms.get(rcode) : null;
}

function sys(roomCode, text) {
  io.to(roomCode).emit("chat", { sys: true, ts: now(), text });
}

io.on("connection", (socket) => {
  socket.data.name = "Guest";
  socket.emit("chat", { sys:true, ts: now(), text: "Connected to server" });

  socket.on("hello", (name) => {
    if (typeof name === "string" && name.trim()) socket.data.name = name.trim();
  });

  // Create room (becomes host)
  socket.on("create-room", ({ name, pin }, cb) => {
    try {
      const code = randCode();
      const room = {
        code,
        name: (name && String(name).trim()) || "Room",
        pin: (pin && String(pin).trim()) || null,
        hostId: socket.id,
        locked: false,
        live: false,
        lastActive: now(),
        members: new Set()
      };
      rooms.set(code, room);

      // join the socket into that room
      socket.join(code);
      socket.data.roomCode = code;
      room.members.add(socket.id);

      cb?.({ ok: true, room: { code, name: room.name, hostId: room.hostId, locked: room.locked, live: room.live } });
      sys(code, `Created room: ${room.name} (${code})`);
    } catch (e) {
      cb?.({ ok: false, error: "create-failed" });
    }
  });

  // Join room
  socket.on("join-room", ({ code, pin }, cb) => {
    const r = rooms.get(String(code || "").trim());
    if (!r) return cb?.({ ok:false, error:"room-not-found" });
    if (r.locked) return cb?.({ ok:false, error:"locked" });
    if (r.pin && String(pin || "").trim() !== r.pin) return cb?.({ ok:false, error:"bad-pin" });

    socket.join(r.code);
    socket.data.roomCode = r.code;
    r.members.add(socket.id);
    r.lastActive = now();

    cb?.({ ok:true, room: { code:r.code, name:r.name, hostId:r.hostId, locked:r.locked, live:r.live }});
    sys(r.code, `${socket.data.name} joined`);
  });

  // Leave room
  socket.on("leave-room", () => {
    const r = getRoomOf(socket);
    if (!r) return;
    socket.leave(r.code);
    r.members.delete(socket.id);
    socket.data.roomCode = null;
    sys(r.code, `${socket.data.name} left room`);
    cleanup(r.code);
  });

  // Host toggles live (start/stop call gate)
  socket.on("room:live", (live, cb) => {
    const r = getRoomOf(socket);
    if (!r) return cb?.({ ok:false });
    if (r.hostId !== socket.id) return cb?.({ ok:false });
    r.live = !!live;
    r.lastActive = now();
    io.to(r.code).emit("room:live", r.live);
    cb?.({ ok:true, live:r.live });
  });

  // Host lock/unlock room
  socket.on("room:lock", (lock, cb) => {
    const r = getRoomOf(socket);
    if (!r) return cb?.({ ok:false });
    if (r.hostId !== socket.id) return cb?.({ ok:false });
    r.locked = !!lock;
    r.lastActive = now();
    io.to(r.code).emit("room:locked", r.locked);
    cb?.({ ok:true, locked:r.locked });
  });

  // End call for all (host only)
  socket.on("end-for-all", (cb) => {
    const r = getRoomOf(socket);
    if (!r) return cb?.({ ok:false });
    if (r.hostId !== socket.id) return cb?.({ ok:false });
    io.to(r.code).emit("end-call");
    r.live = false;
    io.to(r.code).emit("room:live", false);
    sys(r.code, "Host ended the call");
    cb?.({ ok:true });
  });

  // Chat (optional)
  socket.on("chat", (payload) => {
    const r = getRoomOf(socket);
    if (!r) return;
    const msg = typeof payload === "string"
      ? { name: socket.data.name, text: payload, ts: now() }
      : { name: socket.data.name, ...(payload || {}), ts: now() };
    io.to(r.code).emit("chat", msg);
  });

  // --- WebRTC signaling passthrough ---
  socket.on("rtc:offer", ({ offer }) => {
    const r = getRoomOf(socket);
    if (!r) return;
    // host sends offer to everyone else
    socket.to(r.code).emit("rtc:offer", { offer, from: socket.id });
  });

  socket.on("rtc:answer", ({ answer }) => {
    const r = getRoomOf(socket);
    if (!r) return;
    // guest answers — send to everyone (host listens and sets remote desc)
    socket.to(r.code).emit("rtc:answer", { answer, from: socket.id });
  });

  socket.on("rtc:ice", ({ candidate }) => {
    const r = getRoomOf(socket);
    if (!r) return;
    socket.to(r.code).emit("rtc:ice", { candidate, from: socket.id });
  });

  // Disconnect
  socket.on("disconnect", () => {
    const r = getRoomOf(socket);
    if (!r) return;
    r.members.delete(socket.id);
    if (r.hostId === socket.id) {
      // if host vanishes, end call and unlock live
      io.to(r.code).emit("end-call");
      r.live = false;
      io.to(r.code).emit("room:live", false);
      sys(r.code, "Host disconnected");
      // pick a new host if members remain
      const [newHost] = r.members;
      r.hostId = newHost || null;
    } else {
      sys(r.code, `${socket.data.name} left`);
    }
    cleanup(r.code);
  });
});

function cleanup(code) {
  const r = rooms.get(code);
  if (!r) return;
  if (r.members.size === 0) {
    // auto-delete after idle; simple immediate cleanup for now
    rooms.delete(code);
  }
}

app.get("/", (_req, res) => res.send("H2N Forum signaling is running"));
server.listen(PORT, () => {
  console.log(`H2N Forum server on :${PORT}`);
  console.log("Allowed CORS origins:", ALLOW.length ? ALLOW.join(", ") : "(none)");
});
