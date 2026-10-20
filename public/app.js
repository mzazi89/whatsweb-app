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
    tab: "chats",
    calls: [],
    statuses: [],
    snapState: "idle",
    loadingTimedOut: false,
    typing: new Map(), // jid -> {on, until}
    avatars: new Map(),
  };

  const els = {
    meName: $("me-name"), meNum: $("me-num"), meAvatar: $("me-avatar"),
    railLoading: $("rail-loading"), heading: $("rail-heading"), searchWrap: $("search-wrap"), tabs: $("tabs"), loadingScreen: $("loading-screen"), loadingNote: $("loading-note"),
    chats: $("chats"), railEmpty: $("rail-empty"), search: $("search"),
    blank: $("blank"), chat: $("chat"), thread: $("thread"),
    chatName: $("chat-name"), chatSub: $("chat-sub"), chatAvatar: $("chat-avatar"),
    text: $("text"), send: $("btn-send"), attach: $("attach"), file: $("attach"),
    link: $("link"), qr: $("qr"), qrSkel: $("qr-skel"), qrWrap: $("qr-wrap"), qrNote: $("qr-note"), lead: $("link-lead"), pairForm: $("pair-form"),
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
    const tab = state.tab;
    els.heading.textContent = tab === "chats" ? "Chats" : tab === "channels" ? "Channels" : tab === "calls" ? "Calls" : "Updates";
    els.searchWrap.style.display = tab === "chats" || tab === "channels" ? "" : "none";
    for (const b of els.tabs.querySelectorAll(".tab")) b.classList.toggle("is-on", b.dataset.tab === tab);

    const unread = state.chats.reduce((n, c) => n + (c.unread || 0), 0);
    const bChats = $("badge-chats");
    bChats.hidden = !unread;
    bChats.textContent = unread > 99 ? "99+" : String(unread);
    const bUp = $("badge-updates");
    bUp.hidden = !state.statuses.length;
    bUp.textContent = String(state.statuses.length);

    let rows = [];
    if (tab === "chats" || tab === "channels") {
      const want = tab === "chats" ? (c) => c.kind === "dm" || c.kind === "group" : (c) => c.kind === "channel" || c.kind === "broadcast";
      rows = state.chats.filter(want).filter((c) => {
        const q = state.filter.toLowerCase();
        return !q || (c.name || "").toLowerCase().includes(q) || (c.number || "").includes(q);
      }).sort((a, b) => (b.lastTs || b.updated || 0) - (a.lastTs || a.updated || 0)).map((c) => {
        const typing = state.typing.get(c.id);
        const sub = typing && typing.on ? "typing…" : (c.last || "");
        return `<div class="chat-row${state.current === c.id ? " active" : ""}" data-jid="${esc(c.id)}">
          <div class="avatar" data-avatar="${esc(c.id)}">${initial(c.name)}</div>
          <div class="meta">
            <div class="top"><span class="name">${esc(c.name || c.number)}</span><span class="time">${shortTime(c.lastTs)}</span></div>
            <div class="bottom"><span class="last">${esc(sub)}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</div>
          </div>
        </div>`;
      });
    } else if (tab === "calls") {
      rows = (state.calls || []).map((c) => {
        const chat = state.chats.find((x) => x.id === c.jid);
        const name = chat?.name || pretty(c.jid);
        const missed = ["terminate", "timeout"].includes(c.status);
        return `<div class="chat-row" data-call="${esc(c.jid)}">
          <div class="avatar">${initial(name)}</div>
          <div class="meta">
            <div class="top"><span class="name ${missed ? "missed" : ""}">${esc(name)}</span><span class="time">${shortTime(c.ts)}</span></div>
            <div class="bottom"><span class="last">${missed ? "Missed" : "Incoming"}${c.video ? " · video" : ""} call</span></div>
          </div>
        </div>`;
      });
    } else {
      rows = (state.statuses || []).map((x) => {
        const chat = state.chats.find((c) => c.id === x.jid);
        const name = x.name || chat?.name || pretty(x.jid);
        return `<div class="chat-row" data-status="${esc(x.jid)}">
          <div class="avatar ring">${initial(name)}</div>
          <div class="meta">
            <div class="top"><span class="name">${esc(name)}</span><span class="time">${shortTime(x.ts)}</span></div>
            <div class="bottom"><span class="last">${esc(x.kind === "text" ? x.text : x.kind + " status")}</span></div>
          </div>
        </div>`;
      });
    }

    const waiting = state.snapState === "open" && !state.chats.length && !state.loadingTimedOut && tab === "chats";
    els.railLoading.hidden = !waiting;
    els.chats.innerHTML = rows.join("");
    els.railEmpty.hidden = rows.length > 0 || waiting;
    els.railEmpty.innerHTML =
      tab === "chats" ? "<p>No chats yet.</p><p class=\"muted\">Link your phone to load them.</p>"
      : tab === "channels" ? "<p>No channels yet.</p><p class=\"muted\">Channels you follow appear here.</p>"
      : tab === "calls" ? "<p>No calls yet.</p><p class=\"muted\">Calls show up here as they happen.</p>"
      : "<p>No updates yet.</p><p class=\"muted\">Status updates from your contacts appear here.</p>";
    paintAvatars();
  }

  function pretty(jid) {
    const n = String(jid || "").split("@")[0].replace(/\D/g, "");
    if (n.length === 12) return `+${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}`;
    return n ? `+${n}` : String(jid || "").split("@")[0];
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
    els.chatSub.textContent = chat.group ? "Group" : (chat.number || "");
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

  function renderBlank() {
    const waiting = state.snapState === "open" && !state.chats.length && !state.loadingTimedOut;
    document.body.classList.toggle("is-loading", waiting);
    els.loadingScreen.hidden = !(waiting && !state.current);
    els.blank.hidden = waiting || !!state.current;
    if (waiting) {
      els.loadingNote.textContent = state.me
        ? "Linked as " + (state.me.number || state.me.name || "") + " · first sync in progress"
        : "This usually takes a few seconds.";
    }
  }

  function closeChat() {
    state.current = null;
    els.chat.hidden = true;
    renderBlank();
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
    if (snap.state === "open" && state.snapState !== "open") {
      state.loadingTimedOut = false;
      setTimeout(() => {
        state.loadingTimedOut = true;
        renderChats();
        renderBlank();
      }, 30000);
    }
    state.snapState = snap.state;
    if (snap.me) {
      els.meName.textContent = snap.me.name || "Linked";
      els.meNum.textContent = snap.me.number ? "+" + snap.me.number : "";
      els.meAvatar.textContent = initial(snap.me.name || snap.me.number);
    }
    const needsLink = ["idle", "qr", "pairing", "connecting", "close", "logged_out"].includes(snap.state) && !snap.me;
    const showOverlay = snap.state !== "open" &&
      (!snap.me || ["qr", "pairing", "pairing_error", "logged_out"].includes(snap.state));
    els.link.hidden = !showOverlay;
    const pairing = snap.state === "pairing" || snap.state === "pairing_error";
    els.qrWrap.style.display = pairing ? "none" : "";
    els.qrNote.style.display = pairing ? "none" : "";
    els.lead.innerHTML = pairing
      ? "Tap <b>Linked devices → Link a device → Link with phone number</b> on your phone, then type the code below."
      : "Open WhatsApp on your phone, tap <b>Settings → Linked devices → Link a device</b>, then scan this code.";
    if (snap.state === "qr" && snap.qr) {
      if (els.qr.src !== snap.qr) els.qr.src = snap.qr;
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
      els.linkErr.classList.remove("status", "bad");
    } else {
      els.pairCode.hidden = true;

    }
    const status = (txt, bad) => {
      els.linkErr.textContent = txt;
      els.linkErr.classList.toggle("status", !!txt && !bad);
      els.linkErr.classList.toggle("bad", !!bad);
    };
    if (snap.state === "connecting") status("Connecting…");
    else if (snap.state === "close") status("Connection lost, reconnecting…");
    else if (snap.state === "pairing") status("");
    else if (snap.state === "pairing_error") status(snap.pairingError || "WhatsApp did not answer. Try again.", true);
    else if (snap.state === "open") status("");
    if (snap.chats) { state.chats = snap.chats; renderChats(); }
  }

  api("/api/statuses").then((d) => {
    state.statuses = d.statuses || [];
    state.calls = d.calls || [];
    renderChats();
  }).catch(() => {});

  // A dropped socket event should not leave the page stale.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const snap = await api("/api/state");
      renderState(snap);
      if (state.snapState === "open") {
        const { chats } = await api("/api/chats");
        if (chats && chats.length !== state.chats.length) { state.chats = chats; renderChats(); renderBlank(); }
      }
    } catch (e) {}
  }, 15000);

  // ── installable app ───────────────────────────────────────────────────────
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  const installBar = $("install");
  if (!installBar) return;
  let installEvent = null;
  const installGone = () => localStorage.getItem("ww-install-dismissed") === "1";

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e;
    if (!installGone()) installBar.hidden = false;
  });

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (isIOS && !standalone && !installGone()) {
    installBar.querySelector(".install-text b").textContent = "Add to Home Screen";
    installBar.querySelector(".install-text span").textContent = "Share → Add to Home Screen to open it full screen.";
    $("install-go").textContent = "How";
    installBar.hidden = false;
  }

  $("install-go").addEventListener("click", async () => {
    if (installEvent) {
      installEvent.prompt();
      try { await installEvent.userChoice; } catch (e) {}
      installEvent = null;
      installBar.hidden = true;
      localStorage.setItem("ww-install-dismissed", "1");
    } else if (isIOS) {
      alert("Tap the Share button in Safari, then \"Add to Home Screen\".");
    } else {
      installBar.hidden = true;
    }
  });

  $("install-x").addEventListener("click", () => {
    installBar.hidden = true;
    localStorage.setItem("ww-install-dismissed", "1");
  });

  window.addEventListener("appinstalled", () => {
    installBar.hidden = true;
    localStorage.setItem("ww-install-dismissed", "1");
  });

  // ── events ─────────────────────────────────────────────────────────────────
  socket.on("state", renderState);
  els.tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    state.tab = b.dataset.tab;
    state.filter = "";
    els.search.value = "";
    renderChats();
  });

  socket.on("statuses", (list) => { state.statuses = list || []; renderChats(); });
  socket.on("calls", (list) => { state.calls = list || []; renderChats(); });

  socket.on("chats", (chats) => { state.chats = chats || []; renderChats(); renderBlank(); });

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
      // Only draw a QR when nothing is happening. Calling /api/link on load also
      // reset a pairing code that was already on screen.
      if (!snap.me && snap.state === "idle") {
        api("/api/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
      }
    } catch (e) {
      toast(e.message);
    }
  })();
})();
