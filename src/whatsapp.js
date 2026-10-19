// WhatsApp connection built on Baileys. One linked device per install, the
// same model WhatsApp Web uses: the phone stays the owner, this is a companion.
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const QRCode = require("qrcode");
const pino = require("pino");
const store = require("./store");

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
    downloadMediaMessage: b.downloadMediaMessage,
  };
}

const jidToNumber = (jid) => String(jid || "").split("@")[0].split(":")[0];
const isGroup = (jid) => String(jid || "").endsWith("@g.us");

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
    this.mode = wanted.length >= 8 ? "pairing" : null;
    this.lastPhone = wanted.length >= 8 ? wanted : null;
    if (this.mode !== "pairing") {
      this.pairing = null;
      this.pairingError = null;
    }
    try {
      const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = this.getBaileys();
      const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
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
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
      });
      this.sock = sock;
      this.setState("connecting");

      sock.ev.on("creds.update", () => { if (this.sock === sock) saveCreds(); });

      // Pairing code has to be asked for after the socket exists but before the
      // QR is printed; Baileys rejects it once the device is registered.
      if (phone) {
        const digits = String(phone).replace(/\D/g, "");
        if (digits.length >= 8) {
          this.mode = "pairing";
          this.lastPhone = digits;
          this.pairing = null;
          this.pairingError = null;
          // Baileys answers only once the noise handshake is up; asking in the
          // same tick returns nothing and the code never reaches WhatsApp.
          const ask = async () => {
            if (this.sock !== sock || this.state === "open") return false;
            try {
              const code = await sock.requestPairingCode(digits);
              if (!code) throw new Error("WhatsApp did not return a code");
              this.pairing = { code, phone: digits };
              this.pairingError = null;
              this.setState("pairing");
              this.emit("pairing", this.pairing);
              return true;
            } catch (e) {
              this.pairingError = e.message || "Pairing failed";
              this.emit("log", `pairing failed: ${this.pairingError}`);
              return false;
            }
          };
          setTimeout(async () => {
            if (this.sock !== sock || this.state === "open" || this.pairing) return;
            if (await ask()) return;
            setTimeout(async () => {
              if (this.sock !== sock || this.state === "open" || this.pairing) return;
              if (!(await ask())) {
                this.setState("pairing_error");
                this.emit("pairing:error", { message: this.pairingError });
              }
            }, 2500);
          }, 1500);
        }
      }

      sock.ev.on("connection.update", async (u) => {
        // A replaced socket keeps emitting its close; acting on it wiped the
        // session that the new socket had just created.
        if (this.sock !== sock) return;
        const { connection, lastDisconnect, qr } = u;
        if (qr) {
          if (this.mode === "pairing") return; // the code owns the screen now
          try {
            const png = await QRCode.toDataURL(qr, { margin: 1, width: 320, color: { dark: "#0b1f1a", light: "#ffffff" } });
            if (png === this.qr) return; // same QR, no need to redraw the client
            this.qr = png;
            this.setState("qr");
          } catch (e) {
            this.emit("log", `qr render failed: ${e.message}`);
          }
        }
        if (connection === "connecting") this.setState("connecting");
        if (connection === "open") {
          const me = jidToNumber(sock.user?.id || "");
          store.setMe({ id: sock.user?.id, number: me, name: sock.user?.name || "" });
          this.qr = null;
          this.pairing = null;
          this.mode = null;
          this.pairingError = null;
          this.retry = 0;
          this.setState("open");
          this.emit("ready", store.getMe());
        }
        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === this.getBaileys().DisconnectReason?.loggedOut;
          this.qr = null;
          if (loggedOut) {
            if (this.mode === "pairing") {
              // A wrong or unregistered number comes back as 401, which used to
              // look like "you are logged out" instead of a fixable mistake.
              this.pairing = null;
              this.lastPhone = null;
              this.mode = null;
              this.pairingError = "WhatsApp did not accept that number. Check the country code and that the number has WhatsApp, then try again.";
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

      sock.ev.on("messaging-history.set", ({ chats, messages, contacts }) => {
        (contacts || []).forEach((c) => this.ingestContact(c));
        (chats || []).forEach((c) => this.ingestChat(c));
        (messages || []).forEach((m) => this.ingest(m, false));
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
  }

  ingestContact(c) {
    const jid = c.id;
    if (!jid || !jid.endsWith("@s.whatsapp.net")) return;
    store.upsertContact(jid, {
      name: c.name || c.verifiedName || c.notify || undefined,
      pushName: c.notify || undefined,
      number: jidToNumber(jid),
    });
  }

  ingestChat(c) {
    const jid = c.id;
    if (!jid || jid === "status@broadcast") return;
    store.upsertChat(jid, {
      name: c.name || undefined,
      unread: typeof c.unreadCount === "number" ? c.unreadCount : undefined,
      updated: c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : undefined,
      pinned: c.pinned ? true : undefined,
      archived: c.archived ? true : undefined,
    });
  }

  // Turns a raw WAMessage into the small shape the UI needs.
  pack(raw, live) {
    const key = raw.key || {};
    const jid = key.remoteJid;
    if (!jid || jid === "status@broadcast") return null;
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

    return {
      id: key.id,
      jid,
      fromMe: !!key.fromMe,
      from: key.participant || (key.fromMe ? store.getMe()?.id : jid),
      ts: (Number(raw.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000,
      kind,
      text: text || media?.caption || "",
      fileName: media?.fileName || "",
      mimetype: media?.mimetype || "",
      seconds: media?.seconds || 0,
      hasMedia: !!media,
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
    const name = chat.name || contact?.name || contact?.pushName || (isGroup(jid) ? "Group" : jidToNumber(jid));
    return {
      id: jid,
      name,
      number: isGroup(jid) ? "" : jidToNumber(jid),
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
    try {
      if (this.sock) await this.sock.logout();
    } catch (e) {}
    this.wipeSession();
    store.reset();
    this.setState("logged_out");
    setTimeout(() => this.start().catch(() => {}), 800);
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
