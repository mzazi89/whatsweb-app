require("dotenv").config();
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { Server } = require("socket.io");

const store = require("./src/store");
const db = require("./src/db");
const wa = require("./src/whatsapp");

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = String(process.env.ACCESS_PASSWORD || "").trim();
const ALLOWED = String(process.env.ALLOWED_NUMBER || "").replace(/\D/g, "");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
// Vercel (and any read-only serverless filesystem) only allows writes in /tmp.
// multer creates its destination directory at construction time, so pointing it
// at data/uploads there throws EROFS before a single route can answer.
const SERVERLESS_PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>WhatsWeb needs a persistent server</title>\n<style>\n  :root { color-scheme: dark; }\n  body {\n    margin: 0; min-height: 100vh; display: grid; place-items: center;\n    background: #0b141a; color: #e9edef;\n    font: 15px/1.6 \"Segoe UI\", system-ui, -apple-system, Roboto, Arial, sans-serif;\n    padding: 24px;\n  }\n  main { max-width: 620px; }\n  h1 { font-size: 24px; margin: 0 0 8px; font-weight: 600; }\n  p { color: #8696a0; margin: 0 0 14px; }\n  ul { color: #8696a0; padding-left: 20px; margin: 0 0 16px; }\n  li { margin-bottom: 6px; }\n  code, pre {\n    background: #111b21; border: 1px solid #22303a; border-radius: 8px;\n    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n    font-size: 13px;\n  }\n  code { padding: 1px 6px; }\n  pre { padding: 12px 14px; overflow: auto; color: #d7e2e7; }\n  .badge {\n    display: inline-flex; align-items: center; gap: 8px;\n    background: rgba(241,92,109,.12); color: #ff9aa6;\n    border: 1px solid rgba(241,92,109,.3);\n    border-radius: 999px; padding: 4px 12px; font-size: 13px; margin-bottom: 18px;\n  }\n  a { color: #53bdeb; }\n</style>\n</head>\n<body>\n<main>\n  <div class=\"badge\">503 &middot; wrong kind of host</div>\n  <h1>This app cannot run on Vercel</h1>\n  <p>\n    WhatsWeb keeps a long-lived socket open to WhatsApp and stores the linked-device\n    credentials on disk. Vercel functions are created per request and their filesystem\n    is read-only, so the QR would appear and die with the same request.\n  </p>\n  <p>Run it on anything that keeps a Node process alive, with a persistent disk:</p>\n  <ul>\n    <li>Railway, Render, Fly.io, a VPS, or Docker on your own machine</li>\n    <li>Any host where <code>npm start</code> stays running</li>\n  </ul>\n  <pre>git clone https://github.com/mzazi89/whatsappweb\ncd whatsappweb\nnpm install\ncp .env.example .env\nnpm start</pre>\n  <p>\n    The full setup, the environment variables and the deployment notes are in the\n    <a href=\"https://github.com/mzazi89/whatsappweb#readme\">README</a>.\n  </p>\n</main>\n</body>\n</html>\n";
const ON_SERVERLESS = !!process.env.VERCEL;
const UPLOAD_DIR = ON_SERVERLESS ? path.join(require("os").tmpdir(), "whatsweb-uploads") : path.join(__dirname, "data", "uploads");
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 64 * 1024 * 1024 } });

app.use(express.json({ limit: "1mb" }));

// A WhatsApp companion needs a process that stays alive: the socket to WhatsApp
// is long-lived and the session lives on disk. Serverless functions are created
// per request, so linking can never survive there. Say so instead of failing 500.
if (ON_SERVERLESS) {
  app.get("/api/health", (req, res) => res.json({ ok: true, serverless: true, supported: false }));
  app.use((req, res) => {
    res.status(503).type("html").send(SERVERLESS_PAGE);
  });
  module.exports = app;
} else {
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ── gate ─────────────────────────────────────────────────────────────────────
// One shared password, stored as an HMAC cookie. No accounts, no database:
// this app has exactly one WhatsApp session, like WhatsApp Web on one computer.
// Derived, not random: a restart used to invalidate every browser that had
// already unlocked, which felt like being logged out for no reason.
const token = () => crypto.createHmac("sha256", PASSWORD || "open").update("ww-session-v1").digest("hex");
const isHttps = (req) => req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https");
const cookieFor = (req, maxAge) => `ww=${token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
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
  res.setHeader("Set-Cookie", cookieFor(req, 60 * 60 * 24 * 400)); // stays until logout
  res.json({ ok: true });
});

app.get("/manifest.webmanifest", (req, res) => {
  res.type("application/manifest+json");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(path.join(__dirname, "public", "manifest.webmanifest"));
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

app.get("/api/diag", (req, res) => res.json({ ...wa.snapshot(), logs: recent }));

app.get("/api/chats", (req, res) => res.json({ chats: wa.chats() }));

app.get("/api/statuses", (req, res) => res.json({ statuses: wa.statuses || [], calls: wa.calls || [] }));

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
  // Unlinking the phone and forgetting this browser are two different things;
  // this ends both so "log out" really logs out.
  res.setHeader("Set-Cookie", "ww=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
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
wa.on("statuses", (list) => io.emit("statuses", list));
wa.on("calls", (list) => io.emit("calls", list));

wa.on("chats:refresh", (chats) => io.emit("chats", chats));
wa.on("message", (payload) => io.emit("message", payload));
wa.on("message:update", (payload) => io.emit("message:update", payload));
wa.on("presence", (payload) => io.emit("presence", payload));
const recent = [];
wa.on("log", (line) => {
  recent.push(`${new Date().toISOString()} ${line}`);
  if (recent.length > 120) recent.shift();
  console.log("[wa]", line);
});

if (!ON_SERVERLESS) {
  (async () => {
    if (db.enabled()) {
      try {
        await db.migrate();
        await store.hydrate();
        console.log("[db] connected, history restored");
        db.prune().catch(() => {});
      } catch (e) {
        console.error("[db] unavailable:", e.message);
      }
    }
  })().then(() => server.listen(PORT, () => {
    console.log(`WhatsWeb on http://localhost:${PORT}`);
    if (!PASSWORD) console.log("! ACCESS_PASSWORD is empty: anyone who can reach this port can read the chats.");
    const hasSession = db.enabled() || fs.existsSync(path.join(__dirname, "data", "session", "creds.json"));
    if (hasSession) wa.start().catch(() => {});
  }));
}
}
