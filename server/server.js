require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

app.get('/', (req, res) => {
  res.send('H2N Forum server OK');
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// temporary test endpoint
app.get('/__ping', (req, res) => res.send('pong'));

// CORS: allow your dev client(s)
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      cb(null, false);
    },
  })
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins.length ? allowedOrigins : true },
});

/** In-memory rooms (volatile) */
const rooms = new Map(); // code -> { code, name, pin? }

/** Helpers */
const six = () => Math.floor(100000 + Math.random() * 900000).toString();

/** Per-socket state */
io.on("connection", (socket) => {
  socket.data.name = "Me";
  socket.data.roomCode = null;

  socket.on("hello", (name) => {
    if (typeof name === "string" && name.trim()) socket.data.name = name.trim();
  });

  // --- WebRTC signaling (voice) ---
socket.on("rtc:join", ({ roomId }) => {
  socket.join(roomId);
  socket.to(roomId).emit("rtc:peer-joined", { peerId: socket.id });
});

socket.on("rtc:leave", ({ roomId }) => {
  socket.leave(roomId);
  socket.to(roomId).emit("rtc:peer-left", { peerId: socket.id });
});

socket.on("rtc:offer", ({ roomId, offer }) => {
  socket.to(roomId).emit("rtc:offer", { from: socket.id, offer });
});

socket.on("rtc:answer", ({ roomId, answer }) => {
  socket.to(roomId).emit("rtc:answer", { from: socket.id, answer });
});

socket.on("rtc:ice", ({ roomId, candidate }) => {
  socket.to(roomId).emit("rtc:ice", { from: socket.id, candidate });
});

  /** Create room */
  socket.on("create-room", ({ name, pin } = {}, ack) => {
    const code = six();
    const room = { code, name: name?.trim() || `Room`, pin: pin?.trim() || null };
    rooms.set(code, room);

    // move socket into the new room
    if (socket.data.roomCode) socket.leave(socket.data.roomCode);
    socket.join(code);
    socket.data.roomCode = code;

    ack?.({ ok: true, room: { code, name: room.name, requiresPin: !!room.pin } });

    // let this client see a system message AND broadcast join to room
    const sys = { sys: true, ts: Date.now(), text: `Created room: ${room.name} (${code})` };
    io.to(code).emit("chat", sys);
  });

  /** Join room */
  socket.on("join-room", ({ code, pin } = {}, ack) => {
    const room = rooms.get(String(code || "").trim());
    if (!room) return ack?.({ ok: false, error: "Room not found" });
    if (room.pin && room.pin !== String(pin || "").trim()) {
      return ack?.({ ok: false, error: "Incorrect PIN" });
    }

    if (socket.data.roomCode) socket.leave(socket.data.roomCode);
    socket.join(room.code);
    socket.data.roomCode = room.code;

    ack?.({ ok: true, room: { code: room.code, name: room.name, requiresPin: !!room.pin } });

    io.to(room.code).emit("chat", {
      sys: true,
      ts: Date.now(),
      text: `${socket.data.name} joined`,
    });
  });

  /** Leave room */
  socket.on("leave-room", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.leave(code);
    socket.data.roomCode = null;
    io.to(code).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name} left` });

    // optional: auto-delete empty rooms after a while (simple heuristic)
    setTimeout(async () => {
      const roomSockets = await io.in(code).fetchSockets();
      if (roomSockets.length === 0) rooms.delete(code);
    }, 30_000);
  });

  /** Chat -> broadcast to everyone in the room (including sender) */
  socket.on("chat", (text) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const msg = {
      name: socket.data.name,
      text: String(text || ""),
      ts: Date.now(),
    };
    io.to(code).emit("chat", msg);
  });

  socket.on("disconnect", () => {
    // nothing special; rooms are cleaned in leave/timeout
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`H2N Forum server running on http://localhost:${PORT}`);
  console.log("Allowed CORS origins:", allowedOrigins.join(", ") || "(any)");
});

app.get('/', (req, res) => {
  res.send('H2N Forum server OK');
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});