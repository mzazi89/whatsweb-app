// WhatsApp connection built on Baileys. One linked device per install, the
// same model WhatsApp Web uses: the phone stays the owner, this is a companion.
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const pino = require("pino");
const store = require("./store");
const db = require("./db");

const DATA = path.join(__dirname, "..", "data");
const SESSION_DIR = path.join(DATA, "session");
const MEDIA_DIR = path.join(DATA, "media");
const logger = pino({ level: process.env.LOG_LEVEL || "silent" });

function loadBaileys() {
  const b = require("baileys");
  return {
    makeWASocket: b.default || b.makeWASocket,
    useMultiFileAuthState: b.useMultiFileAuthState,
    fetchLatestBaileysVersion: b.fetchLatestBaileysVersion,
    DisconnectReason: b.DisconnectReason,
    Browsers: b.Browsers,
    jidNormalizedUser: b.jidNormalizedUser,
    initAuthCreds: b.initAuthCreds,
    BufferJSON: b.BufferJSON,
    downloadMediaMessage: b.downloadMediaMessage,
  };
}

const jidToNumber = (jid) => String(jid || "").split("@")[0].split(":")[0];
const isGroup = (jid) => String(jid || "").endsWith("@g.us");
const isLid = (jid) => String(jid || "").endsWith("@lid");
const kindOf = (jid) => {
  const j = String(jid || "");
  if (j.endsWith("@g.us")) return "group";
  if (j.endsWith("@newsletter")) return "channel";
  if (j.endsWith("@broadcast")) return "broadcast";
  return "dm";
};

// +254 712 345 678 for Kenyan-style numbers, otherwise grouped digits.
const prettyNumber = (jid) => {
  if (String(jid || "").endsWith("@lid")) return "";
  const n = String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
  // 14+ digits without a real suffix is a LID, not a subscriber number.
  if (!n || n.length >= 14) return "";
  if (!/^\d+$/.test(n)) return "";
  if (n.length === 12) return `+${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}`;
  if (n.length === 11) return `+${n.slice(0, 1)} ${n.slice(1, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  return `+${n}`;
};

class WhatsApp extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.state = "idle"; // idle | qr | pairing | pairing_error | connecting | open | close | logged_out
    this.mode = null;        // "pairing" while a pairing code is in flight
    this.pairingError = null;
    this.lastPhone = null;
    this.retry = 0;
    this.qr = null;
    this.pairing = null;
    this.raw = new Map(); // message id -> raw WAMessage (for media download)
    this.statuses = store.getStatuses ? store.getStatuses() : [];
    this.calls = store.getCalls ? store.getCalls() : [];
    this.groupNames = new Map(); // jid -> subject, resolved lazily
    this.groupMeta = new Map();
    this.lidTried = new Set();
    this.groupLookups = new Set();
    this.starting = false;
  }

  getBaileys() {
    if (!this.B) this.B = loadBaileys();
    return this.B;
  }

  snapshot() {
    return {
      state: this.state,
      qr: this.qr,
      pairing: this.pairing,
      pairingError: this.pairingError,
      me: store.getMe(),
    };
  }

  async start(opts = {}) {
    // A logout restarts the socket on its own; a pairing request that lands in
    // that window used to be dropped, leaving the QR on screen instead.
    if (this.starting) {
      this.queued = opts;
      return;
    }
    const { phone } = opts;
    this.starting = true;
    // A leftover "pairing" mode would swallow every qr event and leave the
    // screen stuck on "connecting" after a failed code or a logout.
    // Never leave the old socket running: two sockets race for the same
    // session and the QR then flips between them.
    if (this.sock) {
      try { this.sock.end(undefined); } catch (e) {}
      this.sock = null;
    }
    const wanted = String(phone || "").replace(/\D/g, "");
    if (wanted.length >= 8 && db.enabled()) {
      try {
        const existing = await db.getAuth("creds");
        // Keys from an aborted attempt make WhatsApp refuse the new code (401).
        if (existing && existing.registered !== true) {
          await db.clearAuth();
          this.emit("log", "cleared an unfinished pairing before starting");
        }
      } catch (e) {}
    }
    this.mode = wanted.length >= 8 ? "pairing" : null;
    this.lastPhone = wanted.length >= 8 ? wanted : null;
    if (this.mode !== "pairing") {
      this.pairing = null;
      this.pairingError = null;
    }
    try {
      const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = this.getBaileys();
      const { state, saveCreds } = db.enabled()
        ? await require("./authState").usePostgresAuthState(this.getBaileys())
        : await useMultiFileAuthState(SESSION_DIR);
      let version;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch (e) {
        version = undefined; // offline: Baileys falls back to its bundled version
      }

      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: false,
        // A freshly linked companion only receives the chat list and recent
        // messages when it asks for the history sync.
        syncFullHistory: true,
        generateHighQualityLinkPreview: true,
      });
      this.sock = sock;
      this.setState("connecting");

      sock.ev.on("creds.update", () => { if (this.sock === sock) saveCreds(); });

      // One request = one code. The code is tied to this socket, so it is asked
      // for exactly once, as soon as the handshake reports ready (the first qr
      // event), and never regenerated behind the user's back.
      let asked = false;
      const askOnce = async () => {
        if (asked || this.sock !== sock || this.state === "open") return;
        asked = true;
        try {
          this.emit("log", `requesting pairing code for ${this.lastPhone}`);
          const code = await sock.requestPairingCode(this.lastPhone);
          if (!code) throw new Error("WhatsApp did not return a code");
          this.pairing = { code, phone: this.lastPhone };
          this.pairingError = null;
          this.setState("pairing");
          this.emit("log", `pairing code issued ${code}`);
          this.emit("pairing", this.pairing);
        } catch (e) {
          this.pairingError = e.message || "Pairing failed";
          this.setState("pairing_error");
          this.emit("pairing:error", { message: this.pairingError });
        }
      };
      if (this.mode === "pairing") {
        // qr is the "socket is ready" signal; fall back to a timer if it is slow.
        this.pairTimer = setTimeout(() => askOnce(), 6000);
      }

      sock.ev.on("connection.update", async (u) => {
        // A replaced socket keeps emitting its close; acting on it wiped the
        // session that the new socket had just created.
        if (this.sock !== sock) return;
        const { connection, lastDisconnect, qr } = u;
        // Linking is code-only: the ready signal is still used, but no QR is
        // ever rendered or sent to the browser.
        if (qr) {
          if (this.mode === "pairing") {
            clearTimeout(this.pairTimer);
            askOnce();
          }
          return;
        }
        if (connection === "connecting") this.setState("connecting");
        if (connection === "open") {
          const me = jidToNumber(sock.user?.id || "");
          store.setMe({ id: sock.user?.id, number: me, name: sock.user?.name || "" });
          this.qr = null;
          this.pairing = null;
          this.mode = null;
          this.pairingError = null;
          this.codeIssued = false;
          clearTimeout(this.pairTimer);
          this.retry = 0;
          this.setState("open");
          this.emit("ready", store.getMe());
        }
        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          this.emit("log", `close code=${code} reason=${(lastDisconnect?.error?.message || "").slice(0, 120)}`);
          const loggedOut = code === this.getBaileys().DisconnectReason?.loggedOut;
          this.qr = null;
          if (this.mode === "pairing") {
            clearTimeout(this.pairTimer);
            const restart = code === 515; // restart required: the link may be fine
            if (restart) {
              this.mode = null;
              this.lastPhone = null;
              this.pairing = null;
              this.setState("connecting");
              setTimeout(() => this.start().catch(() => {}), 600);
              return;
            }
            this.mode = null;
            this.lastPhone = null;
            this.pairingError = code === 401
              ? "WhatsApp did not accept that number. Check the country code and that the number has WhatsApp, then try again."
              : this.pairing
                ? "The connection dropped before the phone finished. Ask for a new code."
                : "WhatsApp closed the connection before the code was issued. Try again.";
            this.pairing = null;
            this.wipeSession();
            this.setState("pairing_error");
            return; // no silent retry, no new code
          }
          if (loggedOut) {
            if (this.mode === "pairing") {
              // A wrong or unregistered number comes back as 401, which used to
              // look like "you are logged out" instead of a fixable mistake.
              this.pairing = null;
              this.lastPhone = null;
              this.mode = null;
              this.pairingError = "WhatsApp closed the pairing (401). That usually means the code expired, the attempt was replaced, or the phone already has four linked devices. Remove an old device on the phone, then press the button again.";
              this.wipeSession();
              this.setState("pairing_error");
            } else {
              this.setState("logged_out");
              this.wipeSession();
            }
          } else {
            this.setState(this.mode === "pairing" ? "pairing" : "close");
            this.retry = Math.min(this.retry + 1, 5);
            const wait = code === 428 ? 1500 : Math.min(3000 * this.retry, 30000);
            setTimeout(() => {
              if (this.state === "open") return;
              this.start({ phone: this.lastPhone || undefined }).catch(() => {});
            }, wait);
          }
        }
      });

      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify" && type !== "append") return;
        messages.forEach((m) => this.ingest(m, type === "notify"));
      });

      sock.ev.on("messages.update", (updates) => {
        updates.forEach((u) => {
          const jid = u.key?.remoteJid;
          if (!jid || !u.key?.id) return;
          const patch = {};
          if (u.update?.status !== undefined) patch.status = u.update.status;
          if (Object.keys(patch).length) this.emit("message:update", { jid, id: u.key.id, ...patch });
        });
      });

      sock.ev.on("messaging-history.set", ({ chats, messages, contacts, isLatest }) => {
        this.emit("log", `history chunk chats=${(chats || []).length} msgs=${(messages || []).length} latest=${!!isLatest}`);
        (contacts || []).forEach((c) => this.ingestContact(c));
        (chats || []).forEach((c) => this.ingestChat(c));
        (messages || []).forEach((m) => this.ingest(m, false));
        this.historyDone = !!isLatest;
        this.emit("chats:refresh", this.chats());
      });

      sock.ev.on("chats.upsert", (chats) => {
        chats.forEach((c) => this.ingestChat(c));
        this.emit("chats:refresh", this.chats());
      });
      sock.ev.on("chats.update", (chats) => {
        chats.forEach((c) => this.ingestChat(c));
        this.emit("chats:refresh", this.chats());
      });
      sock.ev.on("contacts.upsert", (list) => {
        list.forEach((c) => this.ingestContact(c));
        this.emit("chats:refresh", this.chats());
      });
      sock.ev.on("contacts.update", (list) => {
        list.forEach((c) => this.ingestContact(c));
        this.emit("chats:refresh", this.chats());
      });
      sock.ev.on("call", (events) => {
        (events || []).forEach((c) => {
          const jid = c.from || c.chatId;
          if (!jid) return;
          const entry = { jid, ts: Date.now(), status: c.status || "offer", video: !!c.isVideo };
          this.calls = [entry, ...(this.calls || [])].slice(0, 80);
          store.setCalls(this.calls);
          this.emit("calls", this.calls);
        });
      });

      sock.ev.on("presence.update", ({ id, presences }) => {
        const map = presences || {};
        const first = map[Object.keys(map)[0]] || {};
        this.emit("presence", { jid: id, typing: !!first.lastKnownPresence && first.lastKnownPresence === "composing" });
      });
    } catch (e) {
      this.setState("close");
      this.emit("log", `start failed: ${e.message}`);
    } finally {
      this.starting = false;
      if (this.queued) {
        const next = this.queued;
        this.queued = null;
        setTimeout(() => this.start(next).catch(() => {}), 150);
      }
    }
  }

  setState(state) {
    this.state = state;
    this.emit("state", this.snapshot());
  }

  wipeSession() {
    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch (e) {}
    // With Postgres auth the folder is empty; the half-finished handshake lives
    // in wa_auth and would poison the next attempt.
    if (db.enabled()) db.clearAuth().catch(() => {});
  }

  ingestContact(c) {
    const jid = c.id;
    if (!jid) return;
    const name = c.name || c.verifiedName || c.notify || undefined;
    if (jid.endsWith("@s.whatsapp.net")) {
      store.upsertContact(jid, { name, pushName: c.notify || undefined, number: jidToNumber(jid) });
    } else if (jid.endsWith("@lid")) {
      // A LID carries a name but no number; ask the signal store for the pair.
      store.upsertContact(jid, { name, pushName: c.notify || undefined });
      this.resolveLid(jid);
    }
  }

  async resolveLid(jid) {
    if (this.lidTried.has(jid) || !this.sock) return;
    this.lidTried.add(jid);
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        store.upsertContact(jid, { number: jidToNumber(pn) });
        this.emit("chats:refresh", this.chats());
      }
    } catch (e) {}
  }

  nameFor(jid, pushName) {
    if (!jid) return "";
    const c = store.contact(jid);
    const name = pushName || c?.name || c?.pushName;
    if (name) return name;
    if (String(jid).endsWith("@lid")) {
      this.resolveLid(jid);
      const mapped = store.contact(jid)?.number;
      const viaPn = mapped ? store.contact(`${mapped}@s.whatsapp.net`)?.name : "";
      return viaPn || "";
    }
    return prettyNumber(jid);
  }

  // Asks WhatsApp for the page of messages older than the oldest one we hold.
  async loadOlder(jid, count = 50) {
    if (!this.sock) return { ok: false, reason: "Not connected" };
    const list = store.messagesFor(jid);
    const oldest = list[0];
    if (!oldest) return { ok: false, reason: "Open the chat first" };
    try {
      await this.sock.fetchMessageHistory(
        count,
        { remoteJid: jid, id: oldest.id, fromMe: !!oldest.fromMe },
        Math.floor((oldest.ts || Date.now()) / 1000)
      );
      this.emit("log", `older history requested ${jid} before ${oldest.ts}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // Group names only arrive with metadata, not with the chat rows.
  async ensureGroupName(jid) {
    if (!isGroup(jid) || !this.sock || this.groupLookups.has(jid)) return;
    if (this.groupNames.has(jid) && this.groupMeta.has(jid)) return;
    this.groupLookups.add(jid);
    try {
      const meta = await this.sock.groupMetadata(jid);
      this.groupMeta.set(jid, meta);
      const subject = meta?.subject;
      if (subject) {
        this.groupNames.set(jid, subject);
        store.upsertChat(jid, { name: subject });
      }
      // Members carry the names history sync leaves out, plus the LID pairing.
      for (const p of meta?.participants || []) {
        const jidP = p.id || p.jid;
        if (!jidP) continue;
        const name = p.name || p.notify || p.verifiedName;
        if (name) store.upsertContact(jidP, { name, pushName: p.notify || undefined });
        if (p.lid && jidP && p.lid !== jidP) {
          store.upsertContact(p.lid, { name, number: jidToNumber(jidP) });
          store.upsertContact(jidP, { name });
        }
      }
      this.emit("chats:refresh", this.chats());
    } catch (e) {
      this.emit("log", `group metadata failed ${jid}: ${e.message}`);
    } finally {
      this.groupLookups.delete(jid);
    }
  }

  async groupInfo(jid) {
    await this.ensureGroupName(jid);
    const meta = this.groupMeta.get(jid);
    if (!meta) return null;
    const people = (meta.participants || []).map((p) => {
      const id = p.id || p.jid || "";
      const c = store.contact(id) || {};
      const admin = p.admin === "superadmin" ? "owner" : p.admin === "admin" ? "admin" : "";
      return {
        jid: id,
        name: c.name || p.name || p.notify || (isLid(id) ? "Member" : prettyNumber(id)),
        number: c.number ? prettyNumber(c.number) : isLid(id) ? "" : prettyNumber(id),
        admin,
      };
    }).sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0) || a.name.localeCompare(b.name));
    return { subject: meta.subject, desc: meta.desc || "", size: people.length, people };
  }

  ingestChat(c) {
    const jid = c.id;
    if (!jid || jid === "status@broadcast") return;
    if (isGroup(jid)) {
      if (c.name) this.groupNames.set(jid, c.name);
      this.ensureGroupName(jid);
    }
    store.upsertChat(jid, {
      name: c.name || this.groupNames.get(jid) || undefined,
      unread: typeof c.unreadCount === "number" ? c.unreadCount : undefined,
      updated: c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined,
      pinned: c.pinned ? true : undefined,
      archived: c.archived ? true : undefined,
    });
  }

  rememberStatus(raw) {
    const key = raw.key || {};
    const from = key.participant || key.remoteJid;
    if (!from || key.fromMe) return;
    const m = raw.message || {};
    const inner = m.imageMessage || m.videoMessage || m.extendedTextMessage || m.conversation ? m : m;
    const text = inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption || "";
    const kind = m.imageMessage ? "image" : m.videoMessage ? "video" : "text";
    const entry = { jid: from, ts: (Number(raw.messageTimestamp) || 0) * 1000, kind, text, name: raw.pushName || "" };
    if (!entry.ts) entry.ts = Date.now();
    this.statuses = [{ ...entry }, ...(this.statuses || []).filter((x) => x.jid !== from)].slice(0, 60);
    store.setStatuses(this.statuses);
    this.emit("statuses", this.statuses);
  }

  // Remember the name the sender publishes, so a chat is never a bare number.
  rememberPushName(jid, pushName) {
    if (!jid || !pushName) return;
    store.upsertContact(jid, { pushName });
    const chat = store.chat(jid);
    if (!chat?.name && !isGroup(jid)) store.upsertChat(jid, { name: pushName });
  }

  // Turns a raw WAMessage into the small shape the UI needs.
  pack(raw, live) {
    const key = raw.key || {};
    const jid = key.remoteJid;
    if (jid === "status@broadcast") {
      this.rememberStatus(raw);
      return null;
    }
    if (!jid) return null;
    const m = raw.message || {};
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message ||
      m;
    const text = inner.conversation || inner.extendedTextMessage?.text || "";
    const media =
      inner.imageMessage || inner.videoMessage || inner.audioMessage ||
      inner.documentMessage || inner.stickerMessage || null;
    let kind = "text";
    if (inner.imageMessage) kind = "image";
    else if (inner.videoMessage) kind = "video";
    else if (inner.audioMessage) kind = "audio";
    else if (inner.documentMessage) kind = "document";
    else if (inner.stickerMessage) kind = "sticker";
    else if (!text && inner.protocolMessage) kind = "system";

    // Anything without content (keys, receipts, protocol traffic) is not a
    // message: it used to become a bubble showing nothing but the clock.
    const meaningful = !!text || !!media || !!inner.buttonsResponseMessage || !!inner.listResponseMessage;
    if (!meaningful) return null;

    // A DM carries the sender's published name; a group carries the member's.
    this.rememberPushName(jid, raw.pushName);
    if (key.participant) this.rememberPushName(key.participant, raw.pushName);

    return {
      id: key.id,
      jid,
      fromMe: !!key.fromMe,
      from: key.participant || (key.fromMe ? store.getMe()?.id : jid),
      author: key.participant || "",
      authorName: this.nameFor(key.participant, raw.pushName),
      ts: (Number(raw.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000,
      kind,
      text: text || media?.caption || "",
      fileName: media?.fileName || "",
      mimetype: media?.mimetype || "",
      seconds: media?.seconds || 0,
      hasMedia: !!media,
      quoted: (() => {
        const ctx = (inner.extendedTextMessage || inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.documentMessage || {}).contextInfo;
        const q = ctx?.quotedMessage;
        if (!q) return null;
        const body = q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || "";
        const me = store.getMe()?.id;
        const from = ctx.participant || (key.fromMe ? me : "");
        const mine = !!me && (from === me || (ctx.participant && ctx.participant === me));
        return { from, mine, name: mine ? "You" : this.nameFor(from), text: body || (q.imageMessage ? "Photo" : q.videoMessage ? "Video" : q.audioMessage ? "Voice note" : q.stickerMessage ? "Sticker" : "Message") };
      })(),
      mentioned: inner.extendedTextMessage?.contextInfo?.mentionedJid || [],
      quoted:
        inner.extendedTextMessage?.contextInfo?.quotedMessage
          ? {
              text:
                inner.extendedTextMessage.contextInfo.quotedMessage.conversation ||
                inner.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text ||
                "Message",
              from: inner.extendedTextMessage.contextInfo.participant || "",
            }
          : null,
      status: key.fromMe ? 1 : 0,
    };
  }

  ingest(raw, live) {
    const packed = this.pack(raw);
    if (!packed) return;
    const isNew = store.addMessage(packed.jid, packed);
    if (packed.hasMedia) {
      this.raw.set(packed.id, raw);
      if (this.raw.size > 300) this.raw.delete(this.raw.keys().next().value);
    }
    if (!isNew) return;
    store.upsertChat(packed.jid, {
      name: store.chat(packed.jid)?.name || (isGroup(packed.jid) ? "Group" : store.contact(packed.jid)?.name),
    });
    this.emit("message", { chat: this.chatView(packed.jid), message: packed, live });
    if (!packed.fromMe && live && this.sock) {
      const k = raw.key || {};
      this.sock.readMessages([{ remoteJid: k.remoteJid, id: k.id, participant: k.participant }]).catch(() => {});
      store.clearUnread(packed.jid);
    }
  }

  chatView(jid) {
    const chat = store.chat(jid) || { id: jid, unread: 0 };
    const contact = store.contact(jid);
    const group = isGroup(jid);
    const name =
      chat.name ||
      contact?.name ||
      contact?.pushName ||
      (group ? this.groupNames.get(jid) : "") ||
      (group ? "Group" : isLid(jid) ? "Unknown contact" : prettyNumber(jid) || "Unknown contact");
    return {
      id: jid,
      name,
      number: group ? "" : contact?.number ? prettyNumber(contact.number) : isLid(jid) ? "" : prettyNumber(jid),
      kind: kindOf(jid),
      group: isGroup(jid),
      unread: chat.unread || 0,
      last: chat.last || "",
      lastTs: chat.lastTs || chat.updated || 0,
      updated: chat.updated || chat.lastTs || 0,
      pinned: !!chat.pinned,
    };
  }

  chats() {
    const seen = new Set(store.listChats().map((c) => c.id));
    return store.listChats().map((c) => this.chatView(c.id)).filter((c) => c.last || c.unread);
  }

  messages(jid) {
    return store.messagesFor(jid);
  }

  async sendText(jid, text) {
    if (!this.sock) throw new Error("not connected");
    const sent = await this.sock.sendMessage(jid, { text });
    return this.afterSend(jid, sent, text, "text");
  }

  async sendMedia(jid, file, caption) {
    if (!this.sock) throw new Error("not connected");
    const buf = fs.readFileSync(file.path);
    const mt = file.mimetype || "application/octet-stream";
    let payload;
    let kind = "document";
    if (mt.startsWith("image/")) {
      payload = { image: buf, caption };
      kind = "image";
    } else if (mt.startsWith("video/")) {
      payload = { video: buf, caption };
      kind = "video";
    } else if (mt.startsWith("audio/")) {
      payload = { audio: buf, mimetype: mt, ptt: false };
      kind = "audio";
    } else {
      payload = { document: buf, mimetype: mt, fileName: file.originalname, caption };
      kind = "document";
    }
    const sent = await this.sock.sendMessage(jid, payload);
    return this.afterSend(jid, sent, caption || file.originalname || "", kind);
  }

  afterSend(jid, sent, text, kind) {
    const packed = sent ? this.pack(sent, true) : null;
    const msg =
      packed && packed.id
        ? packed
        : {
            id: `local-${Date.now()}`,
            jid,
            fromMe: true,
            ts: Date.now(),
            kind,
            text,
            status: 1,
          };
    store.addMessage(jid, msg);
    this.emit("message", { chat: this.chatView(jid), message: msg, live: true });
    return msg;
  }

  async sendTyping(jid, on) {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(on ? "composing" : "paused", jid);
    } catch (e) {}
  }

  async markRead(jid) {
    const list = store.messagesFor(jid).filter((m) => !m.fromMe).slice(-20);
    if (!list.length || !this.sock) return;
    try {
      await this.sock.readMessages(list.map((m) => ({ remoteJid: jid, id: m.id })));
      store.clearUnread(jid);
    } catch (e) {}
  }

  async avatar(jid) {
    if (!this.sock) return null;
    try {
      return await this.sock.profilePictureUrl(jid, "image");
    } catch (e) {
      return null;
    }
  }

  recentStickers(limit = 40) {
    const out = [];
    for (const [id, raw] of this.raw) {
      const m = this.pack(raw);
      if (m && m.kind === "sticker") out.push({ id, ts: m.ts, jid: m.jid });
      if (out.length >= limit * 3) break;
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  async sendGif(jid, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Could not fetch that GIF");
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") || "";
    if (type.includes("video") || url.endsWith(".mp4")) {
      await this.sock.sendMessage(jid, { video: buf, gifPlayback: true });
    } else {
      await this.sock.sendMessage(jid, { image: buf });
    }
    return true;
  }

  async sendSticker(jid, id) {
    const out = await this.media(id);
    if (!out) throw new Error("Sticker is no longer cached");
    const buf = fs.readFileSync(out.file);
    await this.sock.sendMessage(jid, { sticker: buf });
    return true;
  }

  async media(id) {
    const raw = this.raw.get(id);
    if (!raw) return null;
    try {
      const buf = await this.B.downloadMediaMessage(raw, "buffer", {}, { logger });
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const file = path.join(MEDIA_DIR, `${id.replace(/[^\w-]/g, "")}`);
      fs.writeFileSync(file, buf);
      return { file, mimetype: this.pack(raw)?.mimetype || "" };
    } catch (e) {
      this.emit("log", `media failed: ${e.message}`);
      return null;
    }
  }

  async logout() {
    // Unlink on the phone's side first, then forget everything locally. No
    // reconnect afterwards: the next link has to be an explicit code request.
    try {
      if (this.sock) await this.sock.logout();
    } catch (e) {}
    try {
      if (this.sock) this.sock.end(undefined);
    } catch (e) {}
    this.sock = null;
    this.mode = null;
    this.pairing = null;
    this.pairingError = null;
    this.lastPhone = null;
    this.qr = null;
    this.statuses = [];
    this.calls = [];
    this.wipeSession();
    store.reset();
    this.emit("chats:refresh", []);
    this.emit("statuses", []);
    this.emit("calls", []);
    this.setState("idle");
    this.emit("log", "logged out, session cleared");
  }

  async restart() {
    try {
      if (this.sock) this.sock.end(undefined);
    } catch (e) {}
    this.sock = null;
    this.mode = null;
    this.pairing = null;
    this.setState("connecting");
    setTimeout(() => this.start().catch(() => {}), 500);
  }
}

module.exports = new WhatsApp();
