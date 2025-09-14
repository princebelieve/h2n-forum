// server/server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

/* ---------------------------
   Health / basic endpoints
---------------------------- */
app.get("/", (_req, res) => {
  res.send("H2N Forum server OK");
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// temporary test endpoint
app.get("/__ping", (_req, res) => res.send("pong"));

/* ---------------------------
   CORS (Netlify + Render friendly)
---------------------------- */
const allowedList = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Allow same-origin/no-origin (curl), explicit list, and Netlify/Render previews */
function allowOrigin(origin) {
  if (!origin) return true; // same-origin, curl, server-to-server
  try {
    const { hostname } = new URL(origin);
    if (hostname.endsWith(".netlify.app")) return true; // Netlify previews
    if (hostname.endsWith(".onrender.com")) return true; // Render domain
    return allowedList.includes(origin);
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, cb) => cb(null, allowOrigin(origin)),
    credentials: true,
  })
);

/* ---------------------------
   HTTP server + Socket.IO
---------------------------- */
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, allowOrigin(origin)),
    methods: ["GET", "POST"],
    credentials: true,
  },
});

/* ---------------------------
   In-memory rooms (volatile)
---------------------------- */
const rooms = new Map(); // code -> { code, name, pin? }

/* Helpers */
const six = () => Math.floor(100000 + Math.random() * 900000).toString();

/* ---------------------------
   Socket.IO: chat + signaling
---------------------------- */
io.on("connection", (socket) => {
  socket.data.name = "Me";
  socket.data.roomCode = null;

  // Identify user
  socket.on("hello", (name) => {
    if (typeof name === "string" && name.trim()) socket.data.name = name.trim();
  });

  /* ---- Create room ---- */
  socket.on("create-room", ({ name, pin } = {}, ack) => {
    const code = six();
    const room = {
      code,
      name: (name || "").trim() || "Room",
      pin: (pin || "").trim() || null,
    };
    rooms.set(code, room);

    if (socket.data.roomCode) socket.leave(socket.data.roomCode);
    socket.join(code);
    socket.data.roomCode = code;

    ack?.({ ok: true, room: { code, name: room.name, requiresPin: !!room.pin } });

    io.to(code).emit("chat", {
      sys: true,
      ts: Date.now(),
      text: `Created room: ${room.name} (${code})`,
    });
  });

  /* ---- Join room ---- */
  socket.on("join-room", ({ code, pin } = {}, ack) => {
    const key = String(code || "").trim();
    const room = rooms.get(key);
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

  /* ---- Leave room ---- */
  function leaveCurrentRoom() {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.leave(code);
    socket.data.roomCode = null;
    io.to(code).emit("chat", {
      sys: true,
      ts: Date.now(),
      text: `${socket.data.name} left`,
    });
    // Delete empty rooms after 30s
    setTimeout(async () => {
      const sockets = await io.in(code).fetchSockets();
      if (sockets.length === 0) rooms.delete(code);
    }, 30_000);
  }
  socket.on("leave-room", leaveCurrentRoom);

  /* ---- Chat (accept multiple event names defensively) ---- */
  const handleChat = (payload) => {
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
    // Also echo legacy channel some UIs may still listen to:
    io.to(code).emit("message", msg);
  };
  socket.on("chat", handleChat);
  socket.on("chat:send", handleChat);
  socket.on("message", handleChat);

  /* ---- WebRTC signaling ---- */
  socket.on("rtc:join", ({ roomId } = {}) => {
    const rid = String(roomId || "").trim();
    if (!rid) return;
    if (socket.data.roomCode !== rid) {
      if (socket.data.roomCode) socket.leave(socket.data.roomCode);
      socket.join(rid);
      socket.data.roomCode = rid;
    }
    socket.to(rid).emit("rtc:peer-joined", { peerId: socket.id });
  });

  socket.on("rtc:leave", ({ roomId } = {}) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid) return;
    socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });
    if (socket.data.roomCode === rid) socket.leave(rid);
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
    if (rid) socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });
  });
});

/* ---------------------------
   Start
---------------------------- */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`H2N Forum server running on http://localhost:${PORT}`);
  console.log(
    "Allowed CORS origins:",
    allowedList.length ? allowedList.join(", ") : "(Netlify/Render + any if same-origin)"
  );
});
