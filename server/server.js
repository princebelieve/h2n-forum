import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

/* ---------- CORS ---------- */
const raw = process.env.CLIENT_ORIGIN || "";
const allowedList = raw.split(",").map(s => s.trim()).filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const ok = allowedList.some(a => origin === a);
      cb(ok ? null : new Error("Not allowed by CORS"), ok);
    },
    credentials: true,
  })
);

/* ---------- Socket.IO ---------- */
const io = new Server(server, {
  cors: {
    origin: allowedList.length ? allowedList : true,
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

/* ---------- Data ---------- */
const rooms = new Map(); // code -> { code, name, pin, ownerId, locked }
const code = () => Math.floor(100000 + Math.random() * 900000).toString();

app.get("/health", (req, res) =>
  res.json({ ok: true, rooms: rooms.size, origins: allowedList })
);

function safeAck(ack, payload) {
  try { if (typeof ack === "function") ack(payload); } catch {}
}

function requireHost(socket, room) {
  return room && room.ownerId === socket.id;
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  socket.data.name = "Guest";
  socket.data.roomCode = null;

  socket.emit("welcome", { id: socket.id });

  socket.on("hello", (name) => {
    socket.data.name = (name || "").toString().trim() || "Guest";
  });

  /* --- Create --- */
  const onCreate = ({ name, pin } = {}, ack) => {
    try {
      const r = {
        code: code(),
        name: (name || "Room").toString().slice(0, 50),
        pin: (pin || "").toString().trim() || null,
        ownerId: socket.id,
        locked: false,
      };
      rooms.set(r.code, r);

      if (socket.data.roomCode) socket.leave(socket.data.roomCode);
      socket.join(r.code);
      socket.data.roomCode = r.code;

      safeAck(ack, {
        ok: true,
        room: { code: r.code, name: r.name, requiresPin: !!r.pin, ownerId: r.ownerId, locked: r.locked },
      });

      io.to(r.code).emit("chat", { sys: true, ts: Date.now(), text: `Created room: ${r.name} (${r.code})` });
    } catch (e) {
      safeAck(ack, { ok: false, error: e?.message || "create failed" });
    }
  };
  socket.on("create-room", onCreate);
  socket.on("room:create", onCreate);

  /* --- Join --- */
  const onJoin = ({ code: c, pin } = {}, ack) => {
    try {
      const key = String(c || "").trim();
      const r = rooms.get(key);
      if (!r) return safeAck(ack, { ok: false, error: "Room not found" });
      if (r.locked && socket.id !== r.ownerId) {
        return safeAck(ack, { ok: false, error: "Room is locked by host" });
      }
      if (r.pin && r.pin !== String(pin || "").trim()) {
        return safeAck(ack, { ok: false, error: "Incorrect PIN" });
      }

      if (socket.data.roomCode) socket.leave(socket.data.roomCode);
      socket.join(r.code);
      socket.data.roomCode = r.code;

      safeAck(ack, {
        ok: true,
        room: { code: r.code, name: r.name, requiresPin: !!r.pin, ownerId: r.ownerId, locked: r.locked },
      });

      io.to(r.code).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name} joined` });
      socket.to(r.code).emit("rtc:peer-joined", { peerId: socket.id });
    } catch (e) {
      safeAck(ack, { ok: false, error: e?.message || "join failed" });
    }
  };
  socket.on("join-room", onJoin);
  socket.on("room:join", onJoin);

  /* --- Leave --- */
  function leaveRoom() {
    const rid = socket.data.roomCode;
    if (!rid) return;
    socket.leave(rid);
    socket.data.roomCode = null;
    io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name} left` });
    socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });

    // delete empty rooms after 30s
    setTimeout(async () => {
      const sockets = await io.in(rid).fetchSockets();
      if (sockets.length === 0) rooms.delete(rid);
    }, 30_000);
  }
  socket.on("leave-room", leaveRoom);

  /* --- Chat --- */
  const onChat = (payload) => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    const msg = typeof payload === "string"
      ? { name: socket.data.name, text: payload, ts: Date.now() }
      : { name: payload?.from || socket.data.name, text: String(payload?.text ?? ""), ts: payload?.ts || Date.now() };
    io.to(rid).emit("chat", msg);
    io.to(rid).emit("message", msg); // legacy
  };
  socket.on("chat", onChat);
  socket.on("chat:send", onChat);
  socket.on("message", onChat);

  /* --- Host controls --- */
  socket.on("host:lock", (on, ack) => {
    const rid = socket.data.roomCode;
    const r = rooms.get(rid);
    if (!r) return safeAck(ack, { ok: false, error: "No room" });
    if (!requireHost(socket, r)) return safeAck(ack, { ok: false, error: "Only host" });
    r.locked = !!on;
    io.to(rid).emit("room:locked", { locked: r.locked, ownerId: r.ownerId });
    safeAck(ack, { ok: true });
  });

  socket.on("host:kick", ({ peerId }, ack) => {
    const rid = socket.data.roomCode;
    const r = rooms.get(rid);
    if (!r) return safeAck(ack, { ok: false, error: "No room" });
    if (!requireHost(socket, r)) return safeAck(ack, { ok: false, error: "Only host" });
    if (!peerId) return safeAck(ack, { ok: false, error: "No peer" });
    io.to(peerId).emit("moderation:kicked", { reason: "Removed by host" });
    io.sockets.sockets.get(peerId)?.leave(rid);
    safeAck(ack, { ok: true });
  });

  socket.on("host:mute-all", (ack) => {
    const rid = socket.data.roomCode;
    const r = rooms.get(rid);
    if (!r) return safeAck(ack, { ok: false, error: "No room" });
    if (!requireHost(socket, r)) return safeAck(ack, { ok: false, error: "Only host" });
    socket.to(rid).emit("moderation:mute"); // host not muted
    safeAck(ack, { ok: true });
  });

  socket.on("host:endcall", (ack) => {
    const rid = socket.data.roomCode;
    const r = rooms.get(rid);
    if (!r) return safeAck(ack, { ok: false, error: "No room" });
    if (!requireHost(socket, r)) return safeAck(ack, { ok: false, error: "Only host" });
    io.to(rid).emit("moderation:endcall");
    safeAck(ack, { ok: true });
  });

  /* --- WebRTC signaling (mesh) --- */
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

  socket.on("rtc:offer", ({ roomId, to, offer, kind }) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid || !offer) return;
    if (to) {
      socket.to(to).emit("rtc:offer", { from: socket.id, offer, kind });
    } else {
      socket.to(rid).emit("rtc:offer", { from: socket.id, offer, kind });
    }
  });

  socket.on("rtc:answer", ({ roomId, to, answer }) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid || !answer) return;
    if (to) {
      socket.to(to).emit("rtc:answer", { from: socket.id, answer });
    } else {
      socket.to(rid).emit("rtc:answer", { from: socket.id, answer });
    }
  });

  socket.on("rtc:ice", ({ roomId, to, candidate }) => {
    const rid = roomId || socket.data.roomCode;
    if (!rid || !candidate) return;
    if (to) {
      socket.to(to).emit("rtc:ice", { from: socket.id, candidate });
    } else {
      socket.to(rid).emit("rtc:ice", { from: socket.id, candidate });
    }
  });

  socket.on("disconnect", () => {
    const rid = socket.data.roomCode;
    if (rid) socket.to(rid).emit("rtc:peer-left", { peerId: socket.id });
  });
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`H2N Forum server running on http://localhost:${PORT}`);
  console.log("Allowed CORS origins:", allowedList.join(", ") || "(none)");
});
