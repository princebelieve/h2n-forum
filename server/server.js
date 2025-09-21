// server.js (CommonJS)
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server: IOServer } = require("socket.io");

const PORT = process.env.PORT || 3000;
const rawOrigins = process.env.CLIENT_ORIGIN || ""; // comma-separated
const allowedOrigins = rawOrigins.split(",").map(s => s.trim()).filter(Boolean);

console.log("CLIENT_ORIGIN =", JSON.stringify(process.env.CLIENT_ORIGIN || ""));
console.log("Allowed CORS origins:", allowedOrigins.length ? allowedOrigins : "(none)");

const app = express();
app.use(express.json());
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  credentials: true,
}));

app.get("/health", (_req, res) => res.json({ ok: true, origins: allowedOrigins }));

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (!allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS (io): " + origin));
    },
    credentials: true,
    methods: ["GET", "POST"],
  },
});

// room = { code, name, pin, hostId, locked:false, live:false, members:Set(socketId) }
const rooms = new Map();

function getRoomByCode(code) { return rooms.get(String(code).trim()); }

function leaveAllRooms(socket) {
  for (const r of rooms.values()) {
    if (r.members.has(socket.id)) {
      r.members.delete(socket.id);
      io.to(r.code).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data?.name || "Someone"} left` });
      if (r.hostId === socket.id) {
        io.to(r.code).emit("end-call");
        io.to(r.code).emit("room:live", false);
        r.live = false;
        r.hostId = null;
      }
      if (r.members.size === 0) rooms.delete(r.code);
    }
  }
}

// === GUEST → HOST: I'm ready for an offer ===
socket.on("rtc:ready", () => {
  const room = [...rooms.values()].find(r => r.members.has(socket.id));
  if (!room || !room.hostId) return;
  io.to(room.hostId).emit("rtc:ready", { guestId: socket.id });
});

io.on("connection", (socket) => {
  socket.data = { name: "Guest" };
  socket.emit("chat", { sys: true, ts: Date.now(), text: "Connected to server" });

  socket.on("hello", (name) => { if (typeof name === "string" && name.trim()) socket.data.name = name.trim(); });

  socket.on("chat", (m) => {
    for (const r of rooms.values()) if (r.members.has(socket.id))
      io.to(r.code).emit("chat", { name: socket.data.name, text: m.text, ts: Date.now() });
  });

  socket.on("create-room", ({ name = "Room", pin = "" } = {}, cb = () => {}) => {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const room = { code, name, pin: String(pin || ""), hostId: socket.id, locked: false, live: false, members: new Set([socket.id]) };
    rooms.set(code, room);
    socket.join(code);
    cb({ ok: true, room: { code: room.code, name: room.name, hostId: room.hostId, locked: room.locked, live: room.live } });
    io.to(room.code).emit("chat", { sys: true, ts: Date.now(), text: `Created room: ${room.name} (${room.code})` });
  });

  socket.on("join-room", ({ code, pin = "" } = {}, cb = () => {}) => {
    const room = getRoomByCode(code);
    if (!room) return cb({ ok: false, error: "room not found" });
    if (room.locked) return cb({ ok: false, error: "room locked" });
    if (room.pin && String(pin || "") !== String(room.pin)) return cb({ ok: false, error: "invalid PIN" });
    room.members.add(socket.id);
    socket.join(room.code);
    cb({ ok: true, room: { code: room.code, name: room.name, hostId: room.hostId, locked: room.locked, live: room.live } });
    io.to(room.code).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name || "Someone"} joined` });
  });

  socket.on("leave-room", () => leaveAllRooms(socket));

  socket.on("room:lock", (locked, cb = () => {}) => {
    const room = [...rooms.values()].find(r => r.hostId === socket.id);
    if (!room) return cb({ ok: false });
    room.locked = !!locked;
    io.to(room.code).emit("room:locked", room.locked);
    cb({ ok: true, locked: room.locked });
  });

  socket.on("room:live", (live, cb = () => {}) => {
    const room = [...rooms.values()].find(r => r.hostId === socket.id);
    if (!room) return cb({ ok: false });
    room.live = !!live;
    io.to(room.code).emit("room:live", room.live);
    cb({ ok: true, live: room.live });
  });

  socket.on("end-for-all", (cb = () => {}) => {
    const room = [...rooms.values()].find(r => r.hostId === socket.id);
    if (!room) return cb({ ok: false });
    room.live = false;
    io.to(room.code).emit("end-call");
    io.to(room.code).emit("room:live", false);
    cb({ ok: true });
  });

  // HOST → GUEST: targeted offer
socket.on("rtc:offer", ({ to, offer }) => {
  if (!to) return;
  io.to(to).emit("rtc:offer", { offer, from: socket.id });
});
  // GUEST → HOST: targeted answer
socket.on("rtc:answer", ({ to, answer }) => {
  if (!to) return;
  io.to(to).emit("rtc:answer", { answer, from: socket.id });
});
  // Either direction: targeted ICE candidate
socket.on("rtc:ice", ({ to, candidate }) => {
  if (!to) return;
  io.to(to).emit("rtc:ice", { candidate, from: socket.id });
});

  socket.on("disconnect", () => leaveAllRooms(socket));
});

server.listen(PORT, () => {
  console.log(`H2N Forum server on :${PORT}`);
  console.log("CORS ready for:", allowedOrigins);
});
