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
    this.mimes = new Map(); // message id -> mimetype, survives the file cache
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
      if (mapped) {
        const viaPn = store.contact(`${mapped}@s.whatsapp.net`)?.name;
        return viaPn || prettyNumber(`${mapped}@s.whatsapp.net`);
      }
      return "";
    }
    return prettyNumber(jid);
  }

  // Fills a thread from Postgres before it is painted, so opening a chat that
  // was not in the warmed top 15 never shows an empty list.
  async ensureMessages(jid) {
    if (store.messagesFor(jid).length) return 0;
    return store.loadFromDb(jid, 400);
  }

  // Asks the phone for the page of messages older than the oldest one we hold.
  // Baileys forwards the timestamp straight into oldestMsgTimestampMs, so it
  // must be milliseconds — passing seconds silently returns nothing.
  async loadOlder(jid, count = 50) {
    if (!this.sock) return { ok: false, reason: "Not connected" };
    const list = store.messagesFor(jid);
    if (!list.length) await this.ensureMessages(jid);
    const now = store.messagesFor(jid);
    const oldest = now[0];
    if (!oldest) return { ok: false, reason: "Open the chat first" };
    const mark = oldest.ts;
    try {
      await this.sock.fetchMessageHistory(
        count,
        { remoteJid: jid, id: oldest.id, fromMe: !!oldest.fromMe },
        Number(oldest.ts || Date.now())
      );
      this.emit("log", `older history requested ${jid} before ${mark}`);
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    // The phone answers asynchronously, if at all. Wait a few seconds so the
    // UI can tell "nothing older exists" from "the phone did not reply".
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const list2 = store.messagesFor(jid);
      const added = list2.filter((m) => m.ts < mark).length;
      if (added) return { ok: true, added, total: list2.length };
    }
    return { ok: false, reason: "The phone did not send older messages. Keep it online and try again." };
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

  async leaveGroup(jid) {
    await this.sock.groupLeave(jid);
    store.upsertChat(jid, { unread: 0 });
    return true;
  }

  setArchived(jids, archived) {
    for (const jid of jids || []) store.upsertChat(jid, { archived: !!archived });
    this.emit("chats:refresh", this.chats());
    return true;
  }

  clearChat(jid) {
    store.messages.set(jid, []);
    store.upsertChat(jid, { unread: 0, last: "" });
    if (db.enabled()) db.q("delete from wa_messages where account_id=$1 and jid=$2", [db.ACCOUNT, jid]).catch(() => {});
    this.emit("chats:refresh", this.chats());
    return true;
  }

  async contactInfo(jid) {
    const c = store.contact(jid) || {};
    let about = "";
    let blocked = false;
    try {
      const st = await this.sock.fetchStatus(jid);
      about = st?.[0]?.status || "";
    } catch (e) {}
    try {
      const list = await this.sock.fetchBlocklist();
      blocked = (list || []).some((b) => b === jid || jidToNumber(b) === jidToNumber(jid));
    } catch (e) {}
    // Groups we are both in, from the metadata we already cache.
    const common = [];
    for (const [gid, meta] of this.groupMeta) {
      if ((meta.participants || []).some((p) => (p.id || p.jid) === jid || (p.lid && p.lid === jid))) {
        common.push({ jid: gid, name: meta.subject || "Group" });
      }
    }
    return {
      jid,
      name: c.name || c.pushName || (isLid(jid) ? "Unknown contact" : prettyNumber(jid)),
      number: c.number ? prettyNumber(c.number) : isLid(jid) ? "" : prettyNumber(jid),
      username: c.username || "",
      about,
      lid: isLid(jid),
      blocked,
      common,
      disappearing: "off",
    };
  }

  async setProfilePhoto(buffer) {
    const me = store.getMe()?.id;
    if (!me) throw new Error("Not linked");
    await this.sock.updateProfilePicture(me.includes("@") ? me : `${me}@s.whatsapp.net`, { url: buffer });
    return true;
  }

  async setProfileName(name) {
    const clean = String(name || "").trim().slice(0, 25);
    if (!clean) throw new Error("Name cannot be empty");
    await this.sock.updateProfileName(clean);
    const me = store.getMe() || {};
    store.setMe({ ...me, name: clean });
    this.emit("state", this.snapshot());
    return clean;
  }

  async setBlock(jid, block) {
    await this.sock.updateBlockStatus(jid, block ? "block" : "unblock");
    return true;
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
        number: c.number ? prettyNumber(c.number) : p.phoneNumber ? prettyNumber(p.phoneNumber) : isLid(id) ? "" : prettyNumber(id),
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
  // Stub types are the "system" rows WhatsApp itself shows in a thread. They
  // carry no body, so without this map they were dropped and left a hole.
  stubName(n) {
    if (!this._stub) {
      try { this._stub = require("baileys").proto.WebMessageInfo.StubType || {}; } catch { this._stub = {}; }
    }
    return this._stub[n] || "";
  }

  systemText(name, params, jid) {
    const p = params || [];
    const who = (j) => this.nameFor(j) || (j && !isLid(j) ? prettyNumber(j) : "") || "Someone";
    switch (name) {
      case "CIPHERTEXT":
        return "Message could not be decrypted on this device";
      case "OVERSIZED":
        return "Message is too large to load here";
      case "REVOKE":
        return "This message was deleted";
      case "GROUP_CREATE":
        return "Group created";
      case "GROUP_CHANGE_SUBJECT":
        return p[0] ? `Group name changed to “${p[0]}”` : "Group name changed";
      case "GROUP_CHANGE_ICON":
        return "Group icon changed";
      case "GROUP_CHANGE_DESCRIPTION":
        return "Group description changed";
      case "GROUP_CHANGE_INVITE_LINK":
        return "Group invite link changed";
      case "GROUP_CHANGE_RESTRICT":
        return "Group settings changed";
      case "GROUP_CHANGE_ANNOUNCE":
        return "Group messaging settings changed";
      case "GROUP_PARTICIPANT_ADD":
        return `${p.map(who).join(", ") || "Someone"} joined`;
      case "GROUP_PARTICIPANT_ADD_REQUEST_JOIN":
        return `${p.map(who).join(", ") || "Someone"} requested to join`;
      case "GROUP_PARTICIPANT_REMOVE":
        return `${p.map(who).join(", ") || "Someone"} was removed`;
      case "GROUP_PARTICIPANT_LEAVE":
        return `${p.map(who).join(", ") || "Someone"} left`;
      case "GROUP_PARTICIPANT_PROMOTE":
        return `${p.map(who).join(", ") || "Someone"} is now an admin`;
      case "GROUP_PARTICIPANT_DEMOTE":
        return `${p.map(who).join(", ") || "Someone"} is no longer an admin`;
      case "GROUP_PARTICIPANT_INVITE":
        return `${p.map(who).join(", ") || "Someone"} was invited`;
      case "GROUP_PARTICIPANT_CHANGE_NUMBER":
        return "A member changed their phone number";
      case "GROUP_DELETE":
        return "Group deleted";
      case "CHANGE_EPHEMERAL_SETTING":
        return p[0] && Number(p[0]) > 0 ? `Disappearing messages set to ${p[0]}s` : "Disappearing messages turned off";
      case "DISAPPEARING_MODE":
        return "Disappearing messages changed";
      case "CALL_MISSED_VOICE":
      case "CALL_MISSED_GROUP_VOICE":
        return "Missed voice call";
      case "CALL_MISSED_VIDEO":
      case "CALL_MISSED_GROUP_VIDEO":
        return "Missed video call";
      case "E2E_ENCRYPTED":
      case "E2E_ENCRYPTED_NOW":
        return "Messages are end-to-end encrypted";
      case "E2E_IDENTITY_CHANGED":
      case "E2E_DEVICE_CHANGED":
        return "Security code changed";
      case "BLOCK_CONTACT":
        return "Contact blocked";
      case "CHANGE_LID":
        return "A contact moved to a new identifier";
      case "":
        return "System message";
      default:
        return name.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
    }
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

    // System rows (group events, deleted messages, undecryptable traffic) have
    // no body at all. They are real rows in WhatsApp, so keep them.
    const stub = Number(raw.messageStubType) || 0;
    const stubLabel = stub ? this.stubName(stub) : "";

    let m = raw.message || {};
    // Unwrap the containers WhatsApp puts in front of the real content.
    for (let i = 0; i < 4 && m; i++) {
      const next =
        m.ephemeralMessage?.message ||
        m.viewOnceMessage?.message ||
        m.viewOnceMessageV2?.message ||
        m.viewOnceMessageV2Extension?.message ||
        m.documentWithCaptionMessage?.message ||
        m.editedMessage?.message ||
        m.deviceSentMessage?.message;
      if (!next) break;
      m = next;
    }
    const inner = m || {};

    const text =
      inner.conversation ||
      inner.extendedTextMessage?.text ||
      inner.buttonsResponseMessage?.selectedDisplayText ||
      inner.listResponseMessage?.title ||
      inner.templateButtonReplyMessage?.selectedDisplayText ||
      "";

    const media =
      inner.imageMessage || inner.videoMessage || inner.audioMessage ||
      inner.documentMessage || inner.stickerMessage || null;

    let kind = "text";
    let body = text;
    if (inner.imageMessage) kind = "image";
    else if (inner.videoMessage) kind = "video";
    else if (inner.ptvMessage) kind = "ptv";
    else if (inner.audioMessage) kind = "audio";
    else if (inner.documentMessage) kind = "document";
    else if (inner.stickerMessage) kind = "sticker";
    else if (inner.locationMessage || inner.liveLocationMessage) kind = "location";
    else if (inner.contactMessage || inner.contactsArrayMessage) kind = "contact";
    else if (inner.pollCreationMessage || inner.pollCreationMessageV2 || inner.pollCreationMessageV3) kind = "poll";
    else if (inner.eventMessage) kind = "event";
    else if (inner.productMessage) kind = "product";
    else if (inner.groupInviteMessage) kind = "invite";
    else if (inner.albumMessage) kind = "album";

    // Kinds the old packer threw away now get a readable body instead.
    const derived = {
      ptv: "Video message",
      location: inner.locationMessage?.name || inner.locationMessage?.address || "Location",
      contact: inner.contactMessage?.displayName
        ? `Contact: ${inner.contactMessage.displayName}`
        : inner.contactsArrayMessage?.contacts?.length
          ? `${inner.contactsArrayMessage.contacts.length} contacts`
          : "Contact card",
      poll: `Poll: ${inner.pollCreationMessage?.name || inner.pollCreationMessageV2?.name || inner.pollCreationMessageV3?.name || "Vote"}`,
      event: inner.eventMessage?.name || "Event",
      product: inner.productMessage?.product?.title || "Product",
      invite: "Group invite",
      album: "Album",
    };
    if (!body && derived[kind]) body = derived[kind];

    if (inner.protocolMessage) {
      // 0 = REVOKE, 3 = EPHEMERAL_SETTING. Everything else in here is key
      // traffic (history sync notices, key shares) and must stay invisible.
      const ptype = inner.protocolMessage.type;
      if (ptype === 0) { kind = "system"; body = "This message was deleted"; }
      else if (ptype === 3) { kind = "system"; body = "Disappearing messages changed"; }
      else return null;
    }
    if (stubLabel && !body) {
      kind = "system";
      body = this.systemText(stubLabel, raw.messageStubParameters, jid);
    }

    // Nothing to show and no system event: keys, receipts, protocol traffic.
    if (!body && !media) return null;

    // remoteJidAlt/participantAlt carry the real phone JID when the primary is a LID
    const altChat = key.remoteJidAlt && !isLid(key.remoteJidAlt) ? key.remoteJidAlt : null;
    const altPart = key.participantAlt && !isLid(key.participantAlt) ? key.participantAlt : null;
    if (altChat) store.upsertContact(jid, { number: jidToNumber(altChat) });
    if (altPart && key.participant) store.upsertContact(key.participant, { number: jidToNumber(altPart) });

    // A DM carries the sender's published name; a group carries the member's.
    this.rememberPushName(jid, raw.pushName);
    if (key.participant) this.rememberPushName(key.participant, raw.pushName);

    const ctx =
      (inner.extendedTextMessage || inner.imageMessage || inner.videoMessage ||
        inner.audioMessage || inner.documentMessage || inner.stickerMessage || {}).contextInfo;
    const me = store.getMe()?.id;
    let quoted = null;
    if (ctx?.quotedMessage) {
      const q = ctx.quotedMessage;
      const qbody =
        q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption ||
        q.videoMessage?.caption || "";
      const from = ctx.participant || (key.fromMe ? me : "");
      const mine = !!me && !!from && from === me;
      quoted = {
        from,
        mine,
        name: mine ? "You" : this.nameFor(from),
        text: qbody || (q.imageMessage ? "Photo" : q.videoMessage ? "Video" : q.audioMessage ? "Voice note" : q.stickerMessage ? "Sticker" : "Message"),
      };
    }

    return {
      id: key.id,
      jid,
      fromMe: !!key.fromMe,
      from: key.participant || (key.fromMe ? me : jid),
      author: key.participant || "",
      authorName: this.nameFor(key.participant, raw.pushName),
      ts: (Number(raw.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000,
      kind,
      text: body || media?.caption || "",
      fileName: media?.fileName || "",
      mimetype: media?.mimetype || "",
      seconds: media?.seconds || 0,
      hasMedia: !!media,
      quoted,
      mentioned: ctx?.mentionedJid || [],
      status: key.fromMe ? 1 : 0,
    };
  }

  ingest(raw, live) {
    const packed = this.pack(raw);
    if (!packed) return;
    const isNew = store.addMessage(packed.jid, packed);
    if (packed.hasMedia) {
      this.raw.set(packed.id, raw);
      if (packed.mimetype) this.mimes.set(packed.id, packed.mimetype);
      if (this.raw.size > 300) this.raw.delete(this.raw.keys().next().value);
      // Keep the protobuf so the photo can still be fetched after a redeploy.
      try {
        const B = this.getBaileys();
        db.saveRawMessage(packed.id, JSON.parse(JSON.stringify(raw, B.BufferJSON.replacer))).catch(() => {});
      } catch { /* the message still renders, only the file is lost */ }
    }
    if (!isNew) return;
    store.upsertChat(packed.jid, {
      name: store.chat(packed.jid)?.name || (isGroup(packed.jid) ? "Group" : store.contact(packed.jid)?.name),
    });
    this.emit("message", { chat: this.chatView(packed.jid), message: packed, live });
    // No read receipt here on purpose: a companion that acknowledges on arrival
    // turns every sender's ticks blue before anyone has looked at the chat.
    // Group events and deleted-message notices are not something to "read".
    if (!packed.fromMe && live && packed.kind !== "system") {
      const chat = store.chat(packed.jid);
      store.upsertChat(packed.jid, { unread: (chat?.unread || 0) + 1 });
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
      archived: !!chat.archived,
      pn: isLid(jid) ? store.contact(jid)?.number || "" : "",
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
    const cached = path.join(MEDIA_DIR, `${String(id).replace(/[^\w-]/g, "")}`);
    const held = store.findMessage(id);
    const fallbackMime = { image: "image/jpeg", video: "video/mp4", audio: "audio/ogg", sticker: "image/webp" }[held?.kind] || "";
    const knownMime = this.mimes.get(id) || held?.mimetype || fallbackMime;
    if (fs.existsSync(cached) && fs.statSync(cached).size) {
      return { file: cached, mimetype: knownMime };
    }
    let raw = this.raw.get(id);
    if (!raw) {
      // After a restart memory is empty; rebuild the message from Postgres.
      try {
        const stored = await db.loadRawMessage(id);
        if (stored) {
          const B = this.getBaileys();
          raw = JSON.parse(JSON.stringify(stored), B.BufferJSON.reviver);
          this.raw.set(id, raw);
        }
      } catch { /* fall through to 404 */ }
    }
    if (!raw) return null;
    try {
      const buf = await this.B.downloadMediaMessage(raw, "buffer", {}, { logger });
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const file = path.join(MEDIA_DIR, `${id.replace(/[^\w-]/g, "")}`);
      this.mimes.set(id, this.pack(raw)?.mimetype || "");
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
