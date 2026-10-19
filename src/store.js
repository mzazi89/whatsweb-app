// Tiny persistent store. Everything lives in one JSON file so a restart does
// not wipe the chat list; the real source of truth is still WhatsApp, we only
// keep enough to paint the first screen instantly.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "store.json");
const MAX_PER_CHAT = 400;
const MAX_CHATS = 500;

class Store {
  constructor() {
    this.chats = new Map();   // jid -> chat
    this.contacts = new Map(); // jid -> { name, pushName, number }
    this.messages = new Map(); // jid -> [message]
    this.meta = { me: null };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
      (raw.chats || []).forEach((c) => this.chats.set(c.id, c));
      (raw.contacts || []).forEach((c) => this.contacts.set(c.id, c));
      Object.entries(raw.messages || {}).forEach(([jid, list]) => this.messages.set(jid, list));
      this.meta = raw.meta || { me: null };
      this.statuses = raw.statuses || [];
      this.calls = raw.calls || [];
    } catch (e) {
      // A missing or corrupt file is not fatal: start empty.
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 800);
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const out = {
        meta: this.meta,
        chats: [...this.chats.values()],
        contacts: [...this.contacts.values()],
        messages: Object.fromEntries(this.messages),
        statuses: this.statuses || [],
        calls: this.calls || [],
      };
      fs.writeFileSync(FILE, JSON.stringify(out));
    } catch (e) {
      console.error("store: could not save", e.message);
    }
  }

  setMe(me) {
    this.meta.me = me;
    this.save();
  }

  getMe() {
    return this.meta.me;
  }

  upsertContact(jid, patch = {}) {
    const cur = this.contacts.get(jid) || { id: jid };
    // undefined must not erase a name we already learned
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...cur, ...clean };
    this.contacts.set(jid, next);
    return next;
  }

  contact(jid) {
    return this.contacts.get(jid) || null;
  }

  upsertChat(jid, patch = {}) {
    const cur = this.chats.get(jid) || { id: jid, unread: 0, messages: 0 };
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...cur, ...clean, updated: clean.updated || cur.updated || Date.now() };
    this.chats.set(jid, next);
    this.save();
    return next;
  }

  chat(jid) {
    return this.chats.get(jid) || null;
  }

  getStatuses() { return this.statuses || []; }
  setStatuses(list) { this.statuses = (list || []).slice(0, 60); this.save(); }
  getCalls() { return this.calls || []; }
  setCalls(list) { this.calls = (list || []).slice(0, 80); this.save(); }

  listChats() {
    return [...this.chats.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, MAX_CHATS);
  }

  addMessage(jid, msg) {
    const list = this.messages.get(jid) || [];
    if (msg.id && list.some((m) => m.id === msg.id)) return false;
    list.push(msg);
    list.sort((a, b) => a.ts - b.ts);
    this.messages.set(jid, list.slice(-MAX_PER_CHAT));
    const chat = this.chats.get(jid) || { id: jid, unread: 0 };
    const preview = msg.text || (msg.kind === "image" ? "Photo" : msg.kind === "video" ? "Video" : msg.kind === "audio" ? "Voice message" : msg.kind === "document" ? msg.fileName || "Document" : msg.kind === "sticker" ? "Sticker" : "");
    this.chats.set(jid, {
      ...chat,
      last: preview,
      lastTs: msg.ts,
      updated: msg.ts,
      unread: msg.fromMe ? chat.unread || 0 : (chat.unread || 0) + 1,
      messages: (chat.messages || 0) + 1,
    });
    this.save();
    return true;
  }

  patchMessage(jid, id, patch) {
    const list = this.messages.get(jid);
    if (!list) return null;
    const m = list.find((x) => x.id === id);
    if (!m) return null;
    Object.assign(m, patch);
    this.save();
    return m;
  }

  messagesFor(jid) {
    return this.messages.get(jid) || [];
  }

  clearUnread(jid) {
    const c = this.chats.get(jid);
    if (c) {
      c.unread = 0;
      this.save();
    }
  }

  reset() {
    this.chats.clear();
    this.contacts.clear();
    this.messages.clear();
    this.meta = { me: null };
    this.flush();
  }
}

module.exports = new Store();
