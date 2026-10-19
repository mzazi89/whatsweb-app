/* WhatsWeb client: one socket, a small state object, and plain DOM rendering. */
(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ["websocket", "polling"] });

  const state = {
    me: null,
    chats: [],
    current: null,
    messages: [],
    filter: "",
    typing: new Map(), // jid -> {on, until}
    avatars: new Map(),
  };

  const els = {
    meName: $("me-name"), meNum: $("me-num"), meAvatar: $("me-avatar"),
    chats: $("chats"), railEmpty: $("rail-empty"), search: $("search"),
    blank: $("blank"), chat: $("chat"), thread: $("thread"),
    chatName: $("chat-name"), chatSub: $("chat-sub"), chatAvatar: $("chat-avatar"),
    text: $("text"), send: $("btn-send"), attach: $("attach"), file: $("attach"),
    link: $("link"), qr: $("qr"), qrSkel: $("qr-skel"), pairForm: $("pair-form"),
    phone: $("phone"), pairBtn: $("pair-btn"), pairCode: $("pair-code"), linkErr: $("link-err"),
    toast: $("toast"),
  };

  // ── helpers ────────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initial = (name) => (String(name || "?").trim()[0] || "?").toUpperCase();
  const jidOf = (v) => encodeURIComponent(v);

  function linkify(text) {
    return esc(text).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  }

  function timeOf(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (same(d, now)) return "Today";
    if (same(d, y)) return "Yesterday";
    return d.toLocaleDateString([], { day: "2-digit", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  }

  function shortTime(ts) {
    if (!ts) return "";
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return timeOf(ts);
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
  }

  async function api(url, opts) {
    const r = await fetch(url, opts);
    if (r.status === 401) { location.reload(); throw new Error("locked"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  // ── chat list ──────────────────────────────────────────────────────────────
  function visibleChats() {
    const q = state.filter.trim().toLowerCase();
    if (!q) return state.chats;
    return state.chats.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.number || "").includes(q));
  }

  function renderChats() {
    const list = visibleChats();
    els.railEmpty.hidden = list.length > 0;
    els.chats.innerHTML = list.map((c) => {
      const typing = state.typing.get(c.id);
      const sub = typing && typing.on ? "typing…" : (c.last || "");
      return `<div class="chat-row${state.current === c.id ? " active" : ""}" data-jid="${esc(c.id)}">
        <div class="avatar" data-avatar="${esc(c.id)}">${initial(c.name)}</div>
        <div class="meta">
          <div class="top"><span class="name">${esc(c.name || c.number)}</span><span class="time">${shortTime(c.lastTs)}</span></div>
          <div class="bottom"><span class="last">${esc(sub)}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</div>
        </div>
      </div>`;
    }).join("");
    paintAvatars();
  }

  async function paintAvatars() {
    for (const el of document.querySelectorAll("[data-avatar]")) {
      const jid = el.getAttribute("data-avatar");
      if (el.dataset.done) continue;
      el.dataset.done = "1";
      if (state.avatars.has(jid)) {
        const url = state.avatars.get(jid);
        if (url) el.innerHTML = `<img src="${url}" alt="">`;
        continue;
      }
      const url = state.avatars.get(jid) || null;
      if (url) el.innerHTML = `<img src="${url}" alt="">`;
    }
  }

  async function loadAvatar(jid, el) {
    if (state.avatars.has(jid)) return;
    try {
      const { url } = await api(`/api/chats/${jidOf(jid)}/avatar`);
      state.avatars.set(jid, url || null);
      if (url) {
        const box = el || document.querySelector(`[data-avatar="${CSS.escape(jid)}"]`);
        if (box) box.innerHTML = `<img src="${url}" alt="">`;
      }
    } catch (e) {}
  }

  // ── thread ─────────────────────────────────────────────────────────────────
  function renderThread() {
    if (!state.current) return;
    const rows = [];
    let lastDay = "";
    for (const m of state.messages) {
      const day = dayLabel(m.ts);
      if (day !== lastDay) { rows.push(`<div class="day">${esc(day)}</div>`); lastDay = day; }
      rows.push(bubble(m));
    }
    els.thread.innerHTML = rows.join("") || `<div class="day">No messages yet</div>`;
    els.thread.scrollTop = els.thread.scrollHeight;
    wireMedia();
  }

  function bubble(m) {
    const cls = m.fromMe ? "out" : "in";
    const showName = !m.fromMe && (state.current || "").endsWith("@g.us");
    const parts = [];
    if (showName) parts.push(`<div class="who">${esc((m.from || "").split("@")[0])}</div>`);
    if (m.quoted && m.quoted.text) parts.push(`<div class="quote">${esc(m.quoted.text).slice(0, 220)}</div>`);

    if (m.kind === "image" && m.hasMedia) parts.push(`<img class="media" data-media="${esc(m.id)}" alt="Photo" loading="lazy">`);
    else if (m.kind === "video" && m.hasMedia) parts.push(`<video class="media" data-media="${esc(m.id)}" controls preload="none"></video>`);
    else if (m.kind === "audio" && m.hasMedia) parts.push(`<audio data-media="${esc(m.id)}" controls preload="none"></audio>`);
    else if (m.kind === "document" && m.hasMedia) parts.push(`<a href="/api/media/${encodeURIComponent(m.id)}" target="_blank" rel="noopener">📄 ${esc(m.fileName || "Document")}</a>`);
    else if (m.kind === "sticker" && m.hasMedia) parts.push(`<img class="media" data-media="${esc(m.id)}" alt="Sticker" style="max-width:140px" loading="lazy">`);

    if (m.text) parts.push(`<div class="body">${linkify(m.text)}</div>`);

    const tick = m.fromMe
      ? `<svg class="ticks${m.status >= 3 ? " read" : ""}" viewBox="0 0 16 11" aria-hidden="true"><path fill="currentColor" d="M11.07.65 5.9 8.34 3.2 5.9.9 8.2l5 5 6.6-9.8L11.07.65Zm3.9 0L9.8 8.34l-.5-.47-1.4 2.1 1.9 1.8 6.6-9.8L14.97.65Z"/></svg>`
      : "";
    parts.push(`<span class="stamp">${timeOf(m.ts)}${tick}</span>`);

    return `<div class="msg ${cls}" data-id="${esc(m.id)}">${parts.join("")}</div>`;
  }

  function wireMedia() {
    for (const el of els.thread.querySelectorAll("[data-media]")) {
      if (el.dataset.wired) continue;
      el.dataset.wired = "1";
      const src = `/api/media/${encodeURIComponent(el.getAttribute("data-media"))}`;
      el.setAttribute("src", src);
    }
  }

  // ── open a chat ────────────────────────────────────────────────────────────
  async function openChat(jid) {
    state.current = jid;
    const chat = state.chats.find((c) => c.id === jid) || { id: jid, name: jid, unread: 0 };
    els.chatName.textContent = chat.name || chat.number || jid;
    els.chatSub.textContent = chat.group ? "Group" : "+" + (chat.number || "");
    els.chatAvatar.textContent = initial(chat.name || chat.number);
    els.chat.hidden = false;
    els.blank.hidden = true;
    document.body.classList.add("show-chat");
    renderChats();

    try {
      const { messages } = await api(`/api/chats/${jidOf(jid)}/messages`);
      state.messages = messages || [];
      renderThread();
      api(`/api/chats/${jidOf(jid)}/read`, { method: "POST" }).catch(() => {});
      loadAvatar(jid, els.chatAvatar);
    } catch (e) {
      toast(e.message);
    }
  }

  function closeChat() {
    state.current = null;
    els.chat.hidden = true;
    els.blank.hidden = false;
    document.body.classList.remove("show-chat");
  }

  // ── sending ────────────────────────────────────────────────────────────────
  let typingTimer = null;
  function pingTyping(on) {
    if (!state.current) return;
    fetch(`/api/chats/${jidOf(state.current)}/typing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    }).catch(() => {});
  }

  function autosize() {
    els.text.style.height = "auto";
    els.text.style.height = Math.min(els.text.scrollHeight, 140) + "px";
  }

  async function send() {
    const text = els.text.value.trim();
    if (!text || !state.current) return;
    els.text.value = "";
    autosize();
    try {
      await api(`/api/chats/${jidOf(state.current)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      pingTyping(false);
    } catch (e) {
      toast(e.message);
      els.text.value = text;
    }
  }

  async function upload(file) {
    if (!file || !state.current) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("caption", els.text.value.trim());
    els.text.value = "";
    autosize();
    toast("Uploading…");
    try {
      await api(`/api/chats/${jidOf(state.current)}/upload`, { method: "POST", body: fd });
    } catch (e) {
      toast(e.message);
    }
  }

  // ── link overlay ───────────────────────────────────────────────────────────
  function renderState(snap) {
    state.me = snap.me || null;
    if (snap.me) {
      els.meName.textContent = snap.me.name || "Linked";
      els.meNum.textContent = snap.me.number ? "+" + snap.me.number : "";
      els.meAvatar.textContent = initial(snap.me.name || snap.me.number);
    }
    const needsLink = ["idle", "qr", "pairing", "connecting", "close", "logged_out"].includes(snap.state) && !snap.me;
    const showOverlay = !snap.me || snap.state === "qr" || snap.state === "pairing" || snap.state === "logged_out";
    els.link.hidden = !showOverlay;
    if (snap.state === "qr" && snap.qr) {
      els.qr.src = snap.qr;
      els.qr.hidden = false;
      els.qrSkel.style.display = "none";
    } else {
      els.qr.hidden = true;
      els.qrSkel.style.display = "grid";
    }
    if (snap.state === "pairing" && snap.pairing) {
      els.pairCode.hidden = false;
      els.pairCode.textContent = String(snap.pairing.code || "").replace(/(.{4})/g, "$1 ").trim();
      els.linkErr.textContent = "";
    } else {
      els.pairCode.hidden = true;
    }
    const status = (txt) => { els.linkErr.textContent = txt; els.linkErr.classList.toggle("status", !!txt); };
    if (snap.state === "connecting") status("Connecting…");
    else if (snap.state === "close") status("Connection lost, reconnecting…");
    else if (snap.state === "open") status("");
    if (snap.chats) { state.chats = snap.chats; renderChats(); }
  }

  // ── events ─────────────────────────────────────────────────────────────────
  socket.on("state", renderState);
  socket.on("chats", (chats) => { state.chats = chats || []; renderChats(); });

  socket.on("message", ({ chat, message }) => {
    if (!chat) return;
    const i = state.chats.findIndex((c) => c.id === chat.id);
    if (i > -1) state.chats[i] = chat; else state.chats.unshift(chat);
    state.chats.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (state.current === chat.id) {
      if (!state.messages.some((m) => m.id === message.id)) {
        state.messages.push(message);
        renderThread();
      }
      if (!message.fromMe) api(`/api/chats/${jidOf(chat.id)}/read`, { method: "POST" }).catch(() => {});
    }
    renderChats();
  });

  socket.on("message:update", ({ jid, id, status }) => {
    if (state.current !== jid) return;
    const m = state.messages.find((x) => x.id === id);
    if (m && status !== undefined) { m.status = status; renderThread(); }
  });

  socket.on("presence", ({ jid, typing }) => {
    state.typing.set(jid, { on: typing, until: Date.now() + 6000 });
    if (state.current === jid) renderChats();
  });

  els.chats.addEventListener("click", (e) => {
    const row = e.target.closest(".chat-row");
    if (!row) return;
    openChat(row.getAttribute("data-jid"));
  });

  els.search.addEventListener("input", () => { state.filter = els.search.value; renderChats(); });
  $("btn-back").addEventListener("click", closeChat);

  els.text.addEventListener("input", () => {
    autosize();
    clearTimeout(typingTimer);
    pingTyping(true);
    typingTimer = setTimeout(() => pingTyping(false), 1800);
  });

  els.text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  els.send.addEventListener("click", send);

  $("btn-attach").addEventListener("click", () => els.attach.click());
  els.attach.addEventListener("change", () => {
    const f = els.attach.files && els.attach.files[0];
    if (f) upload(f);
    els.attach.value = "";
  });

  $("btn-refresh").addEventListener("click", async () => {
    try {
      const { chats } = await api("/api/chats");
      state.chats = chats || [];
      renderChats();
      if (state.current) openChat(state.current);
      toast("Chats refreshed");
    } catch (e) { toast(e.message); }
  });

  $("btn-logout").addEventListener("click", async () => {
    if (!confirm("Unlink this device? You will need to scan the code again.")) return;
    try { await api("/api/logout", { method: "POST" }); toast("Unlinked"); } catch (e) { toast(e.message); }
  });

  els.pairForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = els.phone.value.replace(/\D/g, "");
    if (phone.length < 8) { els.linkErr.textContent = "Enter the number with the country code."; return; }
    els.linkErr.textContent = "Asking WhatsApp for a code…";
    els.pairBtn.disabled = true;
    try {
      await api("/api/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) });
    } catch (err) {
      els.linkErr.textContent = err.message;
    } finally {
      setTimeout(() => (els.pairBtn.disabled = false), 6000);
    }
  });

  // Ask once at load: if nothing is linked the server starts a fresh QR.
  (async () => {
    try {
      const snap = await api("/api/state");
      renderState(snap);
      if (!snap.me) api("/api/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    } catch (e) {
      toast(e.message);
    }
  })();
})();
