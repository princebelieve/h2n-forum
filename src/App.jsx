import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = import.meta.env.VITE_SERVER_URL.split(",")[0].trim();

export default function App() {
  const sref = useRef(null);

  // connection
  const [connected, setConnected] = useState(false);

  // identity
  const [me, setMe] = useState("Me");

  // create
  const [roomName, setRoomName] = useState("");
  const [pin, setPin] = useState("");

  // join
  const [joinCode, setJoinCode] = useState("");
  const [joinPin, setJoinPin] = useState("");

  // room & chat
  const [room, setRoom] = useState(null); // {code,name,requiresPin}
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState([]);

  const addMsg = (m) => setMsgs((p) => [...p, m]);

  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    sref.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("hello", me);
      addMsg({ sys: true, ts: Date.now(), text: "Socket connected" });
    });
    s.on("disconnect", () => {
      setConnected(false);
      addMsg({ sys: true, ts: Date.now(), text: "Socket disconnected" });
    });
    s.on("chat", (m) => addMsg(m));

    return () => s.disconnect();
  }, []);

  useEffect(() => {
    sref.current?.emit("hello", me);
  }, [me]);

  const createRoom = () => {
    sref.current?.emit("create-room", { name: roomName, pin }, (res) => {
      if (!res?.ok) {
        addMsg({ sys: true, ts: Date.now(), text: "Failed to create room" });
        return;
      }
      setRoom(res.room);
      setJoinCode(res.room.code);
      addMsg({
        sys: true,
        ts: Date.now(),
        text: `Created room: ${res.room.name} (${res.room.code})`,
      });
    });
  };

  const joinRoom = () => {
    sref.current?.emit(
      "join-room",
      { code: joinCode.trim(), pin: joinPin.trim() },
      (res) => {
        if (!res?.ok) {
          addMsg({
            sys: true,
            ts: Date.now(),
            text: `Join failed: ${res?.error || "unknown error"}`,
          });
          return;
        }
        setRoom(res.room);
        addMsg({
          sys: true,
          ts: Date.now(),
          text: `Joined room: ${res.room.name} (${res.room.code})`,
        });
      }
    );
  };

  const leaveRoom = () => {
    sref.current?.emit("leave-room");
    setRoom(null);
    addMsg({ sys: true, ts: Date.now(), text: "Left room" });
  };

  const sendChat = () => {
    const t = text.trim();
    if (!t) return;
    sref.current?.emit("chat", t);
    setText("");
  };

  return (
    <div className="shell">
      <div className="glass">
        <header className="head">
          <h1>H2N Forum</h1>
          <span className={`pill ${connected ? "ok" : ""}`}>
            {connected ? "Connected to server" : "Disconnected"}
          </span>
        </header>

        <div className="row meta">
          <div className="mono small">Client connects to:</div>
          <div className="mono">{SERVER_URL}</div>
        </div>

        <div className="row">
          <label>Your name</label>
          <input value={me} onChange={(e) => setMe(e.target.value)} />
        </div>

        {/* create / join */}
        {!room && (
          <>
            <div className="row title">Create a meeting</div>
            <div className="row">
              <input
                placeholder="Family Room (optional)"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
              />
              <input
                placeholder="PIN (4–6 digits, optional)"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              <button className="btn primary" onClick={createRoom}>
                Create Meeting
              </button>
            </div>

            <div className="row title right">Code + optional PIN</div>
            <div className="row">
              <input
                placeholder="6-digit code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
              />
              <input
                placeholder="PIN (if required)"
                value={joinPin}
                onChange={(e) => setJoinPin(e.target.value)}
              />
              <button className="btn" onClick={joinRoom}>
                Join
              </button>
            </div>

            <div className="hint">
              Rooms auto-delete after being empty for a while. Share the
              6-digit code (and PIN if set).
            </div>
          </>
        )}

        {room && (
          <div className="row">
            <div className="inroom">
              In room: <b>{room.name}</b> <span className="mono">({room.code})</span>
              <button className="link" onClick={leaveRoom}>
                Leave
              </button>
            </div>
          </div>
        )}

        {/* messages */}
        <div className="msgs">
          {msgs.length === 0 ? (
            <div className="muted">No messages yet. Say hi! 👋</div>
          ) : (
            msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.sys ? "sys" : ""}`}>
                {!m.sys && (
                  <div className="meta">
                    <span className="who">{m.name}</span>
                    <span className="ts">
                      {new Date(m.ts).toLocaleTimeString()}
                    </span>
                  </div>
                )}
                <div className="text">{m.text}</div>
              </div>
            ))
          )}
        </div>

        <div className="send">
          <textarea
            placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChat();
              }
            }}
          />
          <button className="btn primary" onClick={sendChat}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
