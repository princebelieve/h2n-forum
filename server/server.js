// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

/* ---------------------------
   CORS Setup
---------------------------- */
const rawOrigins = process.env.CLIENT_ORIGIN || "";
const ALLOWED = rawOrigins
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function originOk(reqOrigin) {
  if (!reqOrigin) return true; // same-origin
  return ALLOWED.some(o => reqOrigin === o || reqOrigin.startsWith(o));
}

app.use(
  cors({
    origin: (origin, cb) => (originOk(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS"))),
    credentials: true,
  })
);

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => (originOk(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS"))),
    credentials: true,
  },
});

/* ---------------------------
   State
---------------------------- */
const rooms = new Map();

/* ---------------------------
   Socket Logic
---------------------------- */
io.on("connection", (socket) => {
  socket.data.name = "Guest";

  socket.on("set-name", (name) => {
    socket.data.name = String(name || "").trim() || "Guest";
  });

  /* ---- Create room ---- */
  socket.on("create-room", ({ code, name, pin } = {}, ack) => {
    if (!code) return ack?.({ ok: false, error: "Missing room code" });

    const room = { code, name: name || "Room", pin: pin ? String(pin) : null };
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
    // delete empty rooms after 30s
    setTimeout(async () => {
      const sockets = await io.in(code).fetchSockets();
      if (sockets.length === 0) rooms.delete(code);
    }, 30_000);
  }
  socket.on("leave-room", leaveCurrentRoom);

  /* ---- Chat ---- */
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
  };
  socket.on("chat", handleChat);
  socket.on("chat:send", handleChat);
  socket.on("message", handleChat);

  /* ---- WebRTC Signaling (supports group calls) ---- */
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
    if (rid && offer) {
      socket.to(rid).emit("rtc:offer", { from: socket.id, offer });
    }
  });

  socket.on("rtc:answer", ({ roomId, answer }) => {
    const rid = roomId || socket.data.roomCode;
    if (rid && answer) {
      socket.to(rid).emit("rtc:answer", { from: socket.id, answer });
    }
  });

  socket.on("rtc:ice", ({ roomId, candidate }) => {
    const rid = roomId || socket.data.roomCode;
    if (rid && candidate) {
      socket.to(rid).emit("rtc:ice", { from: socket.id, candidate });
    }
  });

  socket.on("disconnect", () => {
    const rid = socket.data.roomCode;
    if (rid) socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });
  });
});

/* ---------------------------
   Start Server
---------------------------- */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`H2N Forum server running on port ${PORT}`);
  console.log("Allowed CORS origins:", ALLOWED.length ? ALLOWED : "(none)");
});
