// server/server.js
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

/* ---------- CORS ---------- */
const raw = process.env.CLIENT_ORIGIN || "";
const allowedList = raw
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true); // curl/health checks
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
  transports: ["websocket", "polling"], // polling as fallback
});

/* ---------- Data ---------- */
const rooms = new Map(); // code -> { code, name, pin }
const code = () => Math.floor(100000 + Math.random() * 900000).toString();

/* ---------- HTTP ---------- */
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    rooms: rooms.size,
    origins: allowedList,
  })
);

/* ---------- Socket helpers ---------- */
function safeAck(ack, payload) {
  try {
    if (typeof ack === "function") ack(payload);
  } catch {}
}

/* ---------- Socket handlers ---------- */
io.on("connection", socket => {
  socket.data.name = "Guest";
  socket.data.roomCode = null;

  socket.on("hello", name => {
    socket.data.name = (name || "").toString().trim() || "Guest";
  });

  // create
  const onCreate = ({ name, pin } = {}, ack) => {
    try {
      const room = {
        code: code(),
        name: (name || "Room").toString().slice(0, 50),
        pin: (pin || "").toString().trim() || null,
      };
      rooms.set(room.code, room);

      if (socket.data.roomCode) socket.leave(socket.data.roomCode);
      socket.join(room.code);
      socket.data.roomCode = room.code;

      safeAck(ack, {
        ok: true,
        room: { code: room.code, name: room.name, requiresPin: !!room.pin },
      });

      io.to(room.code).emit("chat", {
        sys: true,
        ts: Date.now(),
        text: `Created room: ${room.name} (${room.code})`,
      });
    } catch (e) {
      safeAck(ack, { ok: false, error: e?.message || "create failed" });
    }
  };
  socket.on("create-room", onCreate);
  socket.on("room:create", onCreate); // alias (just in case)

  // join
  const onJoin = ({ code: c, pin } = {}, ack) => {
    try {
      const key = String(c || "").trim();
      const room = rooms.get(key);
      if (!room) return safeAck(ack, { ok: false, error: "Room not found" });
      if (room.pin && room.pin !== String(pin || "").trim()) {
        return safeAck(ack, { ok: false, error: "Incorrect PIN" });
      }

      if (socket.data.roomCode) socket.leave(socket.data.roomCode);
      socket.join(room.code);
      socket.data.roomCode = room.code;

      safeAck(ack, {
        ok: true,
        room: { code: room.code, name: room.name, requiresPin: !!room.pin },
      });

      io.to(room.code).emit("chat", {
        sys: true,
        ts: Date.now(),
        text: `${socket.data.name} joined`,
      });
    } catch (e) {
      safeAck(ack, { ok: false, error: e?.message || "join failed" });
    }
  };
  socket.on("join-room", onJoin);
  socket.on("room:join", onJoin); // alias

  // leave
  function leaveRoom() {
    const rid = socket.data.roomCode;
    if (!rid) return;
    socket.leave(rid);
    socket.data.roomCode = null;
    io.to(rid).emit("chat", { sys: true, ts: Date.now(), text: `${socket.data.name} left` });
    setTimeout(async () => {
      const sockets = await io.in(rid).fetchSockets();
      if (sockets.length === 0) rooms.delete(rid);
    }, 30_000);
  }
  socket.on("leave-room", leaveRoom);

  // chat
  const onChat = payload => {
    const rid = socket.data.roomCode;
    if (!rid) return;
    const msg =
      typeof payload === "string"
        ? { name: socket.data.name, text: payload, ts: Date.now() }
        : {
            name: payload?.from || socket.data.name,
            text: String(payload?.text ?? ""),
            ts: payload?.ts || Date.now(),
          };
    io.to(rid).emit("chat", msg);
    io.to(rid).emit("message", msg); // legacy
  };
  socket.on("chat", onChat);
  socket.on("chat:send", onChat);
  socket.on("message", onChat);

  // WebRTC signalling (mesh-capable via room broadcast)
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

/* ---------- Start ---------- */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`H2N Forum server running on http://localhost:${PORT}`);
  console.log("Allowed CORS origins:", allowedList.join(", ") || "(none)");
});
