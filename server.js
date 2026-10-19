require("dotenv").config();
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { Server } = require("socket.io");

const store = require("./src/store");
const wa = require("./src/whatsapp");

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = String(process.env.ACCESS_PASSWORD || "").trim();
const ALLOWED = String(process.env.ALLOWED_NUMBER || "").replace(/\D/g, "");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const upload = multer({ dest: path.join(__dirname, "data", "uploads"), limits: { fileSize: 64 * 1024 * 1024 } });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ── gate ─────────────────────────────────────────────────────────────────────
// One shared password, stored as an HMAC cookie. No accounts, no database:
// this app has exactly one WhatsApp session, like WhatsApp Web on one computer.
const secret = crypto.randomBytes(32);
const token = () => crypto.createHmac("sha256", secret).update(PASSWORD).digest("hex");
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || "").split(";").filter(Boolean).map((c) => {
  const i = c.indexOf("=");
  return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
}));

function allowed(req) {
  if (!PASSWORD) return true;
  return cookies(req).ww === token();
}

app.post("/api/unlock", (req, res) => {
  if (!PASSWORD) return res.json({ ok: true });
  if (String(req.body?.password || "") !== PASSWORD) return res.status(401).json({ ok: false, error: "Wrong password" });
  res.setHeader("Set-Cookie", `ww=${token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  if (!allowed(req)) return res.sendFile(path.join(__dirname, "public", "unlock.html"));
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Everything below needs the gate.
app.use("/api", (req, res, next) => {
  if (req.path === "/unlock" || req.path === "/health") return next();
  if (!allowed(req)) return res.status(401).json({ error: "locked" });
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get("/api/state", (req, res) => {
  const snap = wa.snapshot();
  res.json({ ...snap, me: store.getMe(), chats: wa.chats() });
});

app.post("/api/link", async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  if (ALLOWED && phone && phone !== ALLOWED) return res.status(403).json({ error: "This number is not allowed on this installation" });
  if (phone && phone.length < 8) return res.status(400).json({ error: "Enter the full number with country code" });
  res.json({ ok: true });
  wa.start({ phone: phone || undefined }).catch((e) => console.error("link:", e.message));
});

app.get("/api/chats", (req, res) => res.json({ chats: wa.chats() }));

app.get("/api/chats/:jid/messages", (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  res.json({ chat: wa.chatView(jid), messages: wa.messages(jid) });
});

app.get("/api/chats/:jid/avatar", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const url = await wa.avatar(jid);
  res.json({ url });
});

app.post("/api/chats/:jid/read", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  await wa.markRead(jid);
  res.json({ ok: true });
});

app.post("/api/chats/:jid/typing", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  await wa.sendTyping(jid, !!req.body?.on);
  res.json({ ok: true });
});

app.post("/api/chats/:jid/send", async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Empty message" });
  if (text.length > 65000) return res.status(400).json({ error: "Message too long" });
  try {
    const msg = await wa.sendText(jid, text);
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/chats/:jid/upload", upload.single("file"), async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  if (!req.file) return res.status(400).json({ error: "No file" });
  try {
    const msg = await wa.sendMedia(jid, req.file, String(req.body?.caption || ""));
    fs.unlink(req.file.path, () => {});
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/media/:id", async (req, res) => {
  const out = await wa.media(req.params.id);
  if (!out) return res.status(404).json({ error: "Media no longer cached" });
  res.setHeader("Content-Type", out.mimetype || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=86400");
  fs.createReadStream(out.file).pipe(res);
});

app.post("/api/logout", async (req, res) => {
  res.json({ ok: true });
  wa.logout().catch(() => {});
});

app.post("/api/restart", async (req, res) => {
  res.json({ ok: true });
  wa.restart().catch(() => {});
});

// ── live events ──────────────────────────────────────────────────────────────
io.use((socket, next) => {
  if (!PASSWORD) return next();
  const c = Object.fromEntries(String(socket.handshake.headers.cookie || "").split(";").filter(Boolean).map((x) => {
    const i = x.indexOf("=");
    return [x.slice(0, i).trim(), decodeURIComponent(x.slice(i + 1))];
  }));
  if (c.ww === token()) return next();
  next(new Error("locked"));
});

io.on("connection", (socket) => {
  socket.emit("state", wa.snapshot());
  socket.emit("chats", wa.chats());
});

wa.on("state", (snap) => io.emit("state", snap));
wa.on("chats:refresh", (chats) => io.emit("chats", chats));
wa.on("message", (payload) => io.emit("message", payload));
wa.on("message:update", (payload) => io.emit("message:update", payload));
wa.on("presence", (payload) => io.emit("presence", payload));
wa.on("log", (line) => console.log("[wa]", line));

server.listen(PORT, () => {
  console.log(`WhatsWeb on http://localhost:${PORT}`);
  if (!PASSWORD) console.log("! ACCESS_PASSWORD is empty: anyone who can reach this port can read the chats.");
  const hasSession = fs.existsSync(path.join(__dirname, "data", "session", "creds.json"));
  if (hasSession) wa.start().catch(() => {});
});
