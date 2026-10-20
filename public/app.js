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
    filterKind: "all",
    selectMode: false,
    selected: new Set(),
    showArchived: false,
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
    railLoading: $("rail-loading"), searchWrap: $("search-wrap"), tabs: $("tabs"),
    brandDp: $("brand-dp"), menu: $("menu"), filters: $("filters"), older: $("older"), olderWrap: $("older-wrap"), cntUnread: $("cnt-unread"), cntGroups: $("cnt-groups"), loadingScreen: $("loading-screen"), loadingNote: $("loading-note"),
    chats: $("chats"), railEmpty: $("rail-empty"), search: $("search"),
    blank: $("blank"), chat: $("chat"), thread: $("thread"),
    selbar: $("selbar"), selCount: $("sel-count"),
    tray: $("tray"), trayBody: $("tray-body"), btnEmoji: $("btn-emoji"),
    settings: $("settings"), ginfo: $("ginfo"), ginfoBody: $("ginfo-body"), ginfoName: $("ginfo-name"),
    chatName: $("chat-name"), chatSub: $("chat-sub"), chatAvatar: $("chat-avatar"),
    text: $("text"), send: $("btn-send"), attach: $("attach"), file: $("attach"),
    link: $("link"), lead: $("link-lead"), pairForm: $("pair-form"),
    phone: $("phone"), pairBtn: $("pair-btn"), pairCode: $("pair-code"), linkErr: $("link-err"),
    toast: $("toast"),
  };

  // ── helpers ────────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Names start with emoji and decorative unicode often enough that the first
  // character rendered as a missing-glyph box; pick a readable letter instead.
  const initial = (name, group) => {
    const clean = String(name || "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
    const m = clean.match(/[A-Za-z0-9\u0600-\u06FF\u0900-\u097F]/);
    if (m) return m[0].toUpperCase();
    return group ? "G" : "#";
  };
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
    const d = new Date(ts);
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, "0");
    const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
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

    els.searchWrap.style.display = tab === "chats" || tab === "channels" ? "" : "none";
    for (const b of els.tabs.querySelectorAll(".tab")) b.classList.toggle("is-on", b.dataset.tab === tab);

    const unread = state.chats.reduce((n, c) => n + (c.unread || 0), 0);
    const bChats = $("badge-chats");
    bChats.hidden = !unread;
    bChats.textContent = unread > 99 ? "99+" : String(unread);
    const bUp = $("badge-updates");
    bUp.hidden = !state.statuses.length;
    bUp.textContent = String(state.statuses.length);

    const unreadCount = state.chats.filter((c) => (c.unread || 0) > 0).length;
    const groupCount = state.chats.filter((c) => c.kind === "group").length;
    if (els.cntUnread) els.cntUnread.textContent = unreadCount ? String(unreadCount) : "";
    if (els.cntGroups) els.cntGroups.textContent = groupCount ? String(groupCount) : "";
    els.filters.style.display = tab === "chats" ? "" : "none";

    let rows = [];
    if (tab === "chats" || tab === "channels") {
      const want = tab === "chats" ? (c) => c.kind === "dm" || c.kind === "group" : (c) => c.kind === "channel" || c.kind === "broadcast";
      const pool = state.chats.filter(want).filter((c) => (state.showArchived ? c.archived : !c.archived));
      const archivedCount = state.chats.filter(want).filter((c) => c.archived).length;
      rows = pool.filter((c) => {
        if (tab === "chats" && state.filterKind === "unread" && !(c.unread > 0)) return false;
        if (tab === "chats" && state.filterKind === "groups" && c.kind !== "group") return false;
        const q = state.filter.toLowerCase();
        return !q || (c.name || "").toLowerCase().includes(q) || (c.number || "").includes(q);
      }).sort((a, b) => (b.lastTs || b.updated || 0) - (a.lastTs || a.updated || 0)).map((c) => {
        const typing = state.typing.get(c.id);
        const sub = typing && typing.on ? "typing…" : (c.last || "");
        return `<div class="chat-row${state.current === c.id ? " active" : ""}" data-jid="${esc(c.id)}">
          <div class="avatar" data-avatar="${esc(c.id)}" title="${esc(c.name)}">${initial(c.name, c.kind === "group")}</div>
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
    const archRow = (!state.selectMode && (archivedCount || state.showArchived))
      ? `<div class="arch-row" id="arch-row"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 6h18v3H3V6Zm1 5h16v9H4v-9Zm5 2v2h6v-2H9Z"/></svg>
         <div><div>${state.showArchived ? "Back to chats" : "Archived"}</div><div class="n">${archivedCount} chat${archivedCount === 1 ? "" : "s"}</div></div></div>`
      : "";
    els.chats.innerHTML = archRow + rows.join("");
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
    const boxes = [...document.querySelectorAll("[data-avatar]")].filter((el) => !el.dataset.done);
    // four at a time: enough to fill the screen without hammering WhatsApp
    for (let i = 0; i < boxes.length; i += 4) {
      await Promise.all(boxes.slice(i, i + 4).map(async (el) => {
        el.dataset.done = "1";
        const jid = el.getAttribute("data-avatar");
        const cached = state.avatars.get(jid);
        if (cached !== undefined) {
          if (cached) el.innerHTML = `<img src="${cached}" alt="">`;
          return;
        }
        try {
          const { url } = await api(`/api/chats/${jidOf(jid)}/avatar`);
          state.avatars.set(jid, url || null);
          if (url) el.innerHTML = `<img src="${url}" alt="">`;
        } catch (e) {
          state.avatars.set(jid, null);
        }
      }));
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
  function renderThread(keepPosition) {
    if (!state.current) return;
    const prevH = els.thread.scrollHeight;
    const prevTop = els.thread.scrollTop;
    const rows = [];
    let lastDay = "";
    for (const m of state.messages) {
      // skip anything that carries no content (old rows stored before the packer
      // learned to drop protocol traffic)
      if (!m.text && !m.hasMedia && !m.quoted) continue;
      const day = dayLabel(m.ts);
      if (day !== lastDay) { rows.push(`<div class="day">${esc(day)}</div>`); lastDay = day; }
      rows.push(bubble(m));
    }
    els.thread.innerHTML = rows.join("") || `<div class="day">No messages yet</div>`;
    els.thread.scrollTop = keepPosition ? els.thread.scrollHeight - prevH + prevTop : els.thread.scrollHeight;
    wireMedia();
  }

  function bubble(m) {
    const cls = m.fromMe ? "out" : "in";
    const showName = !m.fromMe && (state.current || "").endsWith("@g.us");
    const parts = [];
    if (showName) {
      const who = (state.people && state.people[m.author]) ||
        (m.authorName && m.authorName !== "Member" ? m.authorName : "") ||
        (m.author && !m.author.endsWith("@lid") ? pretty(m.author) : "") ||
        (m.from && !m.from.endsWith("@lid") ? pretty(m.from) : "") ||
        "Member";
      if (who) parts.push(`<div class="who">${esc(who)}</div>`);
    }
    if (m.quoted && m.quoted.text) {
      const qname = m.quoted.name || (m.quoted.mine ? "You" : "");
      parts.push(`<div class="quote">${qname ? `<b>${esc(qname)}</b>` : ""}<span>${esc(m.quoted.text).slice(0, 220)}</span></div>`);
    }

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
    els.chatAvatar.textContent = initial(chat.name || chat.number, chat.group);
    els.chatAvatar.style.backgroundImage = "";
    els.chat.hidden = false;
    els.blank.hidden = true;
    document.body.classList.add("show-chat");
    els.olderWrap.hidden = false;
    els.older.disabled = false;
    delete els.older.dataset.done;
    els.older.textContent = "Load older messages";
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
    els.olderWrap.hidden = true;
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
    if (state.me && !state.dpLoaded) {
      state.dpLoaded = true;
      api("/api/me/avatar").then((d) => {
        if (d && d.url) {
          els.brandDp.style.backgroundImage = `url("${d.url}")`;
          els.brandDp.textContent = "";
        }
      }).catch(() => {});
    }
    if (state.me && !els.brandDp.style.backgroundImage) {
      els.brandDp.textContent = initial(state.me.name || state.me.number || "M");
    }
    if (!state.me) {
      state.dpLoaded = false;
      els.brandDp.style.backgroundImage = "";
      els.brandDp.textContent = "M";
    }
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
    const showOverlay = snap.state !== "open" &&
      (!snap.me || ["pairing", "pairing_error", "logged_out"].includes(snap.state));
    els.link.hidden = !showOverlay;
    els.lead.innerHTML = snap.state === "pairing"
      ? "Tap <b>Linked devices → Link a device → Link with phone number</b> on your phone, then type the code below."
      : "Enter your number with the country code. WhatsApp sends a code you type on the phone — no camera needed.";
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

  // header menu and filter chips
  $("btn-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    els.menu.hidden = !els.menu.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!els.menu.hidden && !els.menu.contains(e.target) && e.target.id !== "btn-menu") els.menu.hidden = true;
  });
  $("btn-cam").addEventListener("click", () => toast("The camera is not available in the browser build."));
  $("chip-new").addEventListener("click", () => toast("Start a chat from your phone for now."));

  els.filters.addEventListener("click", (e) => {
    const b = e.target.closest(".chip[data-f]");
    if (!b) return;
    state.filterKind = b.dataset.f;
    for (const c of els.filters.querySelectorAll(".chip[data-f]")) c.classList.toggle("is-on", c === b);
    renderChats();
  });

  els.menu.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    els.menu.hidden = true;
    const act = b.dataset.act;
    if (act === "reload") return window.location.reload();
    if (act === "link") {
      if (state.me) return toast(`Linked as ${state.me.number || state.me.name || "this device"}`);
      return (els.link.hidden = false);
    }
    if (act === "settings") return openSettings();
    if (act === "select") {
      state.selectMode = true; state.selected.clear();
      els.selbar.hidden = false; els.selCount.textContent = "0 selected";
      return renderChats();
    }
    if (act === "logout") {
      if (!confirm("Log out of MZAZI APP and unlink this device?")) return;
      try { await api("/api/logout", { method: "POST" }); } catch (err) {}
      state.chats = [];
      state.messages = [];
      state.current = null;
      state.statuses = [];
      state.calls = [];
      state.me = null;
      els.chats.innerHTML = "";
      els.link.hidden = false;
      closeChat();
      toast("Logged out");
    }
  });

  async function loadGroupInfo(jid) {
    try {
      const { group } = await api(`/api/chats/${jidOf(jid)}/info`);
      if (!group) return;
      state.people = state.people || {};
      for (const p of group.people) {
        if (p.jid && p.name) state.people[p.jid] = p.name;
      }
      state.group = group;
      if (state.current === jid) renderThread(true);
    } catch (e) {}
  }

  let gtab = "members";

  function paintGroup(tab) {
    gtab = tab || gtab;
    for (const b of document.querySelectorAll("#ginfo-tabs button")) b.classList.toggle("on", b.dataset.gtab === gtab);
    const g = state.group;
    const body = els.ginfoBody;
    if (!g) { body.innerHTML = `<div class="gp-sec">Group details are not available.</div>`; return; }

    if (gtab === "members") {
      const me = state.me && (state.me.id || state.me.number);
      const mine = g.people.find((p) => me && (p.jid === me || p.number === pretty(me)));
      body.innerHTML = `
        <div class="gp-sec">${g.size} members</div>
        ${mine ? `<div class="gp-row"><div class="avatar">${initial(mine.name, false)}</div><div class="t">You<div class="s">${esc(mine.number || "")}</div></div></div>` : ""}
        ${g.people.map((p) => `
          <div class="gp-row" data-member="${esc(p.jid)}" data-pn="${esc((p.number || "").replace(/\D/g, ""))}">
            <div class="avatar">${initial(p.name, false)}</div>
            <div class="t">${esc(p.name)}<div class="s">${esc(p.number || "Tap to message")}</div></div>
            ${p.admin ? `<span class="tag">${p.admin === "owner" ? "Group owner" : "Group admin"}</span>` : ""}
          </div>`).join("")}`;
    } else if (gtab === "media") {
      const media = (state.messages || []).filter((m) => m.hasMedia && ["image", "video", "sticker"].includes(m.kind));
      body.innerHTML = media.length
        ? `<div class="gp-sec">Media, links and docs · ${media.length}</div><div class="gp-media">${
            media.slice(0, 60).map((m) => m.kind === "video"
              ? `<video src="/api/media/${encodeURIComponent(m.id)}" muted></video>`
              : `<img src="/api/media/${encodeURIComponent(m.id)}" alt="">`).join("")
          }</div>`
        : `<div class="gp-sec">No media in this session yet.</div>`;
    } else {
      body.innerHTML = `
        <div class="gp-sec">Privacy</div>
        ${row("Encryption", "Messages and calls are end-to-end encrypted.", "lock", "enc")}
        ${row("Chat lock", "Lock and hide this chat on this device.", "lock", "lock")}
        ${row("Advanced chat privacy", "Not available in the browser build.", "shield", "priv")}
        <div class="gp-sec">Chat</div>
        ${row("Add to favorites", "Pin this group to the top of your list.", "heart", "fav")}
        ${row("Export chat", "Download this conversation as JSON.", "up", "export")}
        ${row("Clear chat", "Delete the messages stored on this server.", "slash", "clear", true)}
        <div class="gp-sec">Group</div>
        ${row("Exit group", "Leave and stop receiving messages.", "exit", "exit", true)}
        ${row("Report group", "Report this group to WhatsApp.", "flag", "report", true)}
        <div class="gp-foot">${g.size} members${g.desc ? " · " + esc(g.desc) : ""}</div>`;
    }
  }

  const ICONS = {
    lock: "M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8h16v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z",
    shield: "M12 2 4 5v7c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V5l-8-3Z",
    heart: "M12 21s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7 3.7C19 16.6 12 21 12 21Z",
    up: "M12 3 5 10h4v8h6v-8h4l-7-7Z",
    slash: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 0 1 6.3 3.1L6.1 16.3A8 8 0 0 1 12 4Z",
    exit: "M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3Zm5 4-1.4 1.4L16.2 11H9v2h7.2l-2.6 2.6L15 17l5-5-5-5Z",
    flag: "M6 3v18h2v-7h9l-2-4 2-4H8V3H6Z",
  };

  function row(title, sub, icon, act, danger) {
    return `<div class="gp-row${danger ? " danger" : ""}" data-gact="${act}">
      <svg class="i" viewBox="0 0 24 24"><path fill="currentColor" d="${ICONS[icon] || ICONS.lock}"/></svg>
      <div class="t">${title}<div class="s">${sub}</div></div>
    </div>`;
  }

  function openGroupInfo() {
    const jid = state.current;
    if (!jid) return;
    if (!jid.endsWith("@g.us")) return openContactInfo(jid);
    document.querySelectorAll("#ginfo-tabs button").forEach((b) => { b.style.display = ""; });
    els.ginfo.hidden = false;
    els.ginfoName.textContent = state.group?.subject || "Group";
    $("ginfo-title").textContent = state.group?.subject || "Group";
    $("ginfo-sub").textContent = state.group ? `${state.group.size} members` : "";
    els.ginfoBody.innerHTML = `<div class="gp-sec">Loading members…</div>`;
    api(`/api/chats/${jidOf(jid)}/info`).then(({ group }) => {
      if (!group) { els.ginfoBody.innerHTML = `<div class="gp-sec">Group details are not available.</div>`; return; }
      state.group = group;
      state.people = Object.fromEntries(group.people.filter((p) => p.name).map((p) => [p.jid, p.name]));
      els.ginfoName.textContent = group.subject || "Group";
      $("ginfo-title").textContent = group.subject || "Group";
      $("ginfo-sub").textContent = `${group.size} members`;
      paintGroup("members");
      renderThread(true);
      const av = $("ginfo-avatar");
      api(`/api/chats/${jidOf(jid)}/avatar`).then(({ url }) => {
        if (url) { av.style.backgroundImage = `url("${url}")`; av.textContent = ""; }
        else { av.style.backgroundImage = ""; av.textContent = initial(group.subject, true); }
      }).catch(() => {});
    }).catch(() => { els.ginfoBody.innerHTML = `<div class="gp-sec">Could not load members.</div>`; });
  }

  // Whole header opens the group page: photo, name and the empty space between.
  document.querySelector(".chat-top").addEventListener("click", (e) => {
    if (e.target.closest("#btn-back")) return;
    openGroupInfo();
  });

  function openContactInfo(jid) {
    els.ginfo.hidden = false;
    els.ginfoName.textContent = "Contact info";
    $("ginfo-title").textContent = "Contact";
    $("ginfo-sub").textContent = "";
    els.ginfoBody.innerHTML = `<div class="gp-sec">Loading…</div>`;
    document.querySelectorAll("#ginfo-tabs button").forEach((b) => { b.style.display = "none"; });
    api(`/api/chats/${jidOf(jid)}/info`).then(({ contact }) => {
      if (!contact) { els.ginfoBody.innerHTML = `<div class="gp-sec">No details for this contact.</div>`; return; }
      $("ginfo-title").textContent = contact.name === "Unknown contact" && contact.number ? contact.number : contact.name;
      $("ginfo-sub").textContent = contact.number || (contact.lid ? "Number not shared" : "");
      const av = $("ginfo-avatar");
      api(`/api/chats/${jidOf(jid)}/avatar`).then(({ url }) => {
        if (url) { av.style.backgroundImage = `url("${url}")`; av.textContent = ""; }
        else { av.style.backgroundImage = ""; av.textContent = initial(contact.name, false); }
      }).catch(() => {});
      els.ginfoBody.innerHTML = `
        <div class="gp-sec">About</div>
        <div class="gp-row"><div class="t">${esc(contact.about || "No about set")}</div></div>
        <div class="gp-sec">Phone number</div>
        <div class="gp-row"><div class="t">${esc(contact.number || "Not shared")}${contact.username ? `<div class="s">@${esc(contact.username)}</div>` : ""}</div></div>
        <div class="gp-sec">Disappearing messages</div>
        <div class="gp-row"><div class="t">Off<div class="s">Managed on the phone</div></div></div>
        <div class="gp-sec">Groups in common · ${contact.common.length}</div>
        ${contact.common.length
          ? contact.common.map((g) => `<div class="gp-row"><div class="avatar">${initial(g.name, true)}</div><div class="t">${esc(g.name)}</div></div>`).join("")
          : `<div class="gp-row"><div class="t">None<div class="s">Groups appear here once their details are loaded.</div></div></div>`}
        <div class="gp-sec">Privacy</div>
        ${row(contact.blocked ? "Unblock contact" : "Block contact", contact.blocked ? "Allow messages again." : "Stop messages and calls from this person.", "slash", contact.blocked ? "unblock" : "block", true)}
        ${row("Report contact", "Not available from a linked device.", "flag", "report", true)}
        ${row("Report and block", "Blocks now; reporting needs the phone.", "flag", "reportblock", true)}
        <div class="gp-sec">Chat</div>
        ${row("Clear chat", "Delete the messages stored on this server.", "slash", "clear", true)}`;
      state.contact = contact;
    }).catch(() => { els.ginfoBody.innerHTML = `<div class="gp-sec">Could not load this contact.</div>`; });
  }

  $("ginfo-back").addEventListener("click", () => {
    els.ginfo.hidden = true;
    document.querySelectorAll("#ginfo-tabs button").forEach((b) => { b.style.display = ""; });
  });
  document.getElementById("ginfo-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-gtab]");
    if (b) paintGroup(b.dataset.gtab);
  });
  els.ginfoBody.addEventListener("click", async (e) => {
    const mem = e.target.closest("[data-member]");
    if (mem) {
      const pn = (mem.dataset.pn || "").replace(/\D/g, "");
      const target = pn.length >= 8 ? `${pn}@s.whatsapp.net` : mem.dataset.member;
      els.ginfo.hidden = true;
      document.querySelectorAll("#ginfo-tabs button").forEach((b) => { b.style.display = ""; });
      await openChat(target);
      if (!pn) toast("Their number isn't shared; sending may fail.");
      return;
    }
    const r = e.target.closest("[data-gact]");
    if (!r) return;
    const act = r.dataset.gact;
    const jid = state.current;
    if (state.contact) {
      if (act === "block" || act === "unblock" || act === "reportblock") {
        const block = act !== "unblock";
        if (!confirm(block ? "Block this contact?" : "Unblock this contact?")) return;
        try {
          await api(`/api/chats/${jidOf(jid)}/block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ block }) });
          toast(block ? "Blocked" : "Unblocked");
          state.contact.blocked = block;
          openContactInfo(jid);
        } catch (e) { toast(e.message); }
        return;
      }
      if (act === "report") return toast("WhatsApp does not accept reports from a linked device.");
    }
    if (act === "enc") return toast("Messages and calls are end-to-end encrypted by WhatsApp.");
    if (act === "lock" || act === "priv" || act === "report") return toast("Not available in the browser build.");
    if (act === "fav") return toast("Favourites are not stored on the server yet.");
    if (act === "export") {
      const blob = new Blob([JSON.stringify(state.messages, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mzazi-chat-${Date.now()}.json`;
      a.click();
      return;
    }
    if (act === "clear") {
      if (!confirm("Clear the messages stored on this server for this chat?")) return;
      await api(`/api/chats/${jidOf(jid)}/clear`, { method: "POST" });
      state.messages = [];
      renderThread();
      toast("Chat cleared");
      return;
    }
    if (act === "exit") {
      if (!confirm("Leave this group?")) return;
      try {
        await api(`/api/chats/${jidOf(jid)}/leave`, { method: "POST" });
        els.ginfo.hidden = true;
        closeChat();
        toast("You left the group");
      } catch (err) { toast(err.message); }
    }
  });

  const endSelect = () => {
    state.selectMode = false; state.selected.clear();
    els.selbar.hidden = true;
    renderChats();
  };
  $("sel-done").addEventListener("click", endSelect);
  const archive = async (archived) => {
    const jids = [...state.selected];
    if (!jids.length) return;
    try {
      await api("/api/chats/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jids, archived }) });
      state.chats = state.chats.map((c) => jids.includes(c.id) ? { ...c, archived } : c);
      toast(archived ? `Archived ${jids.length}` : `Unarchived ${jids.length}`);
      endSelect();
    } catch (e) { toast(e.message); }
  };
  $("sel-archive").addEventListener("click", () => archive(true));
  $("sel-unarchive").addEventListener("click", () => archive(false));

  // ── screen animation (canvas overlay) ─────────────────────────────────────
  const FX = (() => {
    // The canvas lives at the end of <body>, which is after this script runs.
    let canvas = document.getElementById("fx-canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "fx-canvas";
      canvas.setAttribute("aria-hidden", "true");
      document.body.appendChild(canvas);
    }
    const ctx = canvas.getContext("2d");
    const rnd = (a, b) => a + Math.random() * (b - a);
    let type = "off", parts = [], raf = 0, w = 0, h = 0;

    const TYPES = {
      flowers: { n: 16, color: () => ["#ff8fb1", "#ffc2d1", "#f7e6a5", "#e8b4ff"][Math.floor(Math.random() * 4)] },
      fire: { n: 34, color: () => ["#ffb347", "#ff7a1a", "#ffd166", "#ff4d1a"][Math.floor(Math.random() * 4)] },
      water: { n: 40, color: () => "rgba(140,205,255,.75)" },
      snow: { n: 55, color: () => "rgba(255,255,255,.85)" },
      confetti: { n: 30, color: () => ["#ff4d6d", "#ffd166", "#4cc9f0", "#8ac926", "#c77dff"][Math.floor(Math.random() * 5)] },
      bubbles: { n: 22, color: () => "rgba(160,230,255,.35)" },
      leaves: { n: 18, color: () => ["#8ac926", "#c9a227", "#e07a2f", "#5e8c31"][Math.floor(Math.random() * 4)] },
    };

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function spawn(top) {
      const c = TYPES[type];
      const up = type === "fire" || type === "bubbles";
      return {
        x: rnd(0, w),
        y: up ? (top ? rnd(h, h + 60) : h + 20) : (top ? rnd(-h, 0) : rnd(-40, 0)),
        r: type === "flowers" ? rnd(4, 7) : type === "confetti" ? rnd(3, 6) : rnd(1.2, 4),
        vy: up ? rnd(-0.9, -0.3) : type === "water" ? rnd(3.5, 6) : rnd(0.5, 1.8),
        vx: rnd(-0.35, 0.35),
        a: rnd(0, Math.PI * 2),
        va: rnd(-0.03, 0.03),
        col: c.color(),
        life: 1,
      };
    }

    function draw(p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.col;
      if (type === "flowers") {
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.ellipse(Math.cos((i / 5) * Math.PI * 2) * p.r, Math.sin((i / 5) * Math.PI * 2) * p.r, p.r * 0.75, p.r * 0.45, (i / 5) * Math.PI * 2, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (type === "leaves") {
        ctx.beginPath(); ctx.ellipse(0, 0, p.r * 1.8, p.r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
      } else if (type === "confetti") {
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      } else if (type === "water") {
        ctx.beginPath(); ctx.ellipse(0, 0, p.r * 0.7, p.r * 1.9, 0, 0, Math.PI * 2); ctx.fill();
      } else if (type === "bubbles") {
        ctx.strokeStyle = p.col; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(0, 0, p.r * 2, 0, Math.PI * 2); ctx.stroke();
      } else if (type === "fire") {
        ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    function step() {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.x += p.vx + Math.sin((p.y + p.a * 40) / 60) * 0.35;
        p.y += p.vy;
        p.a += p.va;
        if (p.y > h + 40 || p.y < -60 || p.x < -60 || p.x > w + 60) Object.assign(p, spawn(false));
        draw(p);
      }
      raf = requestAnimationFrame(step);
    }

    return {
      start(t) {
        cancelAnimationFrame(raf); raf = 0; parts = [];
        type = t;
        if (!TYPES[t] || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        resize();
        for (let i = 0; i < TYPES[t].n; i++) {
          const p = spawn(true);
          p.y = rnd(-h, h); // already spread over the screen on start
          parts.push(p);
        }
        step();
      },
    };
  })();

  // ── settings: profile, theme, wallpaper ───────────────────────────────────
  const prefs = {
    get theme() { return localStorage.getItem("ww-theme") || "dark"; },
    set theme(v) { localStorage.setItem("ww-theme", v); },
    get wall() { return localStorage.getItem("ww-wall") || "none"; },
    set wall(v) { localStorage.setItem("ww-wall", v); },
    get wallImage() { return localStorage.getItem("ww-wall-image") || ""; },
    set wallImage(v) { localStorage.setItem("ww-wall-image", v); },
    get fx() { return localStorage.getItem("ww-fx") || "off"; },
    set fx(v) { localStorage.setItem("ww-fx", v); },
  };

  function applyPrefs() {
    document.body.dataset.theme = prefs.theme;
    document.body.dataset.wall = prefs.wall;
    const img = prefs.wallImage;
    els.thread.style.backgroundImage = prefs.wall === "custom" && img ? `url("${img}")` : "";
    for (const b of document.querySelectorAll("#themes .chip")) b.classList.toggle("is-on", b.dataset.theme === prefs.theme);
    for (const b of document.querySelectorAll("#walls .wall[data-wall]")) b.classList.toggle("on", b.dataset.wall === prefs.wall);
    document.body.dataset.fx = prefs.fx;
    for (const b of document.querySelectorAll("#fx .chip")) b.classList.toggle("is-on", b.dataset.fx === prefs.fx);
    FX.start(prefs.fx);
  }

  function openSettings() {
    els.settings.hidden = false;
    $("set-name").value = state.me?.name || "";
    $("set-number").textContent = state.me?.number ? "Linked as " + state.me.number : "Not linked yet";
    const av = $("set-avatar");
    av.style.backgroundImage = els.brandDp.style.backgroundImage;
    av.textContent = av.style.backgroundImage ? "" : (state.me ? initial(state.me.name || "M") : "M");
    applyPrefs();
  }

  $("set-back").addEventListener("click", () => { els.settings.hidden = true; });

  document.getElementById("themes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme]");
    if (!b) return;
    prefs.theme = b.dataset.theme;
    applyPrefs();
  });

  document.getElementById("walls").addEventListener("click", (e) => {
    const b = e.target.closest("[data-wall]");
    if (!b) return;
    prefs.wall = b.dataset.wall;
    if (b.dataset.wall !== "custom") prefs.wallImage = "";
    applyPrefs();
  });

  document.getElementById("fx").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fx]");
    if (!b) return;
    prefs.fx = b.dataset.fx;
    applyPrefs();
  });

  $("set-wall").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { prefs.wallImage = String(r.result); prefs.wall = "custom"; applyPrefs(); };
    r.readAsDataURL(f);
  });

  $("set-photo").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("photo", f);
    try {
      const r = await fetch("/api/me/photo", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Upload failed");
      toast("Profile photo updated");
      state.dpLoaded = false;
      const { url } = await api("/api/me/avatar");
      if (url) {
        els.brandDp.style.backgroundImage = `url("${url}")`;
        els.brandDp.textContent = "";
        $("set-avatar").style.backgroundImage = `url("${url}")`;
        $("set-avatar").textContent = "";
      }
    } catch (err) { toast(err.message); }
  });

  $("set-save-name").addEventListener("click", async () => {
    try {
      const { name } = await api("/api/me/name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("set-name").value }) });
      toast("Name saved as " + name);
      if (state.me) state.me.name = name;
    } catch (e) { toast(e.message); }
  });

  $("set-logout").addEventListener("click", async () => {
    if (!confirm("Log out of MZAZI APP and unlink this device?")) return;
    try { await api("/api/logout", { method: "POST" }); } catch (e) {}
    location.reload();
  });

  applyPrefs();

  // ── emoji / gif / stickers ────────────────────────────────────────────────
  const EMOJI = {
    "Smileys": "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕",
    "Gestures": "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐 🖖 👋 🤝 🙏 💪 🦾 🖕 ✍️ 🤳 💅 👏 🙌 👐 🤲 🫶",
    "Hearts": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💯 💢 💥 💫 💦 💨",
    "Animals": "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦅 🦆 🦉 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🦑 🦀 🐡 🐠 🐟 🐬 🐳 🦈 🐊 🐘 🦒 🐎 🐖 🐑 🦙 🐐 🦌",
    "Food": "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🌽 🥕 🍞 🧀 🍗 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍿 🧂 🍦 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 ☕ 🍵 🧃 🥤 🍺 🍷",
    "Activity": "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🥅 🏒 🏑 🥍 🏏 🪃 🥊 🥋 🎽 🛹 🛼 🛷 🥌 🎿 ⛷ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚴 🚵 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸",
    "Travel": "🚗 🚕 🚙 🚌 🚎 🏎 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🚲 🛴 🛵 🏍 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩 💺 🛰 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥 🛳 ⛴ 🚢 ⚓",
    "Objects": "⌚ 📱 💻 ⌨️ 🖥 🖨 🖱 🖲 🕹 🗜 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽 🎞 📞 ☎️ 📟 📠 📺 📻 🎙 🎚 🎛 🧭 ⏱ ⏲ ⏰ 🕰 ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯 🪔 🧯 🛢 💸 💵 💴 💶 💷 💰 💳 🧾 💎 ⚖️ 🧰 🔧 🔨 ⚒ 🛠 ⛏ 🔩 ⚙️ 🧱 ⛓ 🧲 🔫 💣 🧨 🪓 🔪 🗡 ⚔️ 🛡 🚬 ⚰️ ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳 💊 💉 🩸 🩹 🩺 🌡 🪥 🧹 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪒 🧽 🔑 🗝 🚪 🪑 🛋 🛏 🖼 🛍 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒 🗓 📆 📅 🗑 📇 🗃 🗳 🗄 📋 📁 📂 🗂 🗞 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇 📐 📏 🧮 📌 📍 ✂️ 🖊 🖋 ✒️ 🖌 🖍 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓",
    "Symbols": "✅ ❌ ❎ ✔️ ☑️ 🔘 ⚪ ⚫ 🔴 🟠 🟡 🟢 🔵 🟣 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾ ◽ ◼️ ◻️ 🟥 🟧 🟨 🟩 🟦 🟪 🟫 ⬛ ⬜ 🔈 🔉 🔊 🔇 📢 📣 📯 🔔 🔕 🎵 🎶 💤 ♻️ ⚡ 🔥 💧 🌟 ⭐ 🌠 🌈 ☀️ 🌤 ⛅ 🌥 ☁️ 🌦 🌧 ⛈ 🌩 🌨 ❄️ ☃️ ⛄ 🌬 💨 🌪 🌫 🌊 💦 💨 🕐 🕑 🕒 🕓 🕔 🕕 🕖 🕗 🕘 🕙 🕚 🕛 ⏰ ⏳ ⌛"
  };

  let trayTab = "emoji";

  function insertEmoji(ch) {
    const el = els.text;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + ch.length;
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function paintTray() {
    for (const b of document.querySelectorAll(".tray-tab")) b.classList.toggle("is-on", b.dataset.tray === trayTab);
    if (trayTab === "emoji") {
      els.trayBody.innerHTML = Object.entries(EMOJI).map(([name, list]) =>
        `<div class="tray-sec">${name}</div><div class="emoji-grid">${
          list.split(" ").filter(Boolean).map((e) => `<button data-e="${e}">${e}</button>`).join("")
        }</div>`).join("");
    } else if (trayTab === "sticker") {
      els.trayBody.innerHTML = `<div class="tray-note">Loading stickers…</div>`;
      api("/api/stickers").then(({ stickers }) => {
        if (!stickers.length) {
          els.trayBody.innerHTML = `<div class="tray-note">No stickers in this session yet. Once a sticker arrives in a chat it appears here and can be sent again.</div>`;
          return;
        }
        els.trayBody.innerHTML = `<div class="tray-sec">Recent</div><div class="sticker-grid">${
          stickers.map((s) => `<button data-sticker="${esc(s.id)}"><img src="/api/media/${encodeURIComponent(s.id)}" alt=""></button>`).join("")
        }</div>`;
      }).catch(() => { els.trayBody.innerHTML = `<div class="tray-note">Could not load stickers.</div>`; });
    } else {
      els.trayBody.innerHTML = `<div class="gif-search"><input id="gif-q" placeholder="Search GIFs"></div><div class="gif-grid" id="gif-grid"></div>`;
      const q = $("gif-q");
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") searchGif(q.value); });
      searchGif("");
    }
  }

  async function searchGif(q) {
    const grid = $("gif-grid");
    if (!grid) return;
    grid.innerHTML = `<div class="tray-note">Searching…</div>`;
    try {
      const out = await api(`/api/gif?q=${encodeURIComponent(q || "hello")}`);
      if (out.needsKey) {
        grid.innerHTML = `<div class="tray-note">GIF search needs a free API key. Add <b>GIF_KEY</b> in Render (Giphy or Tenor) and this tab fills up.</div>`;
        return;
      }
      grid.innerHTML = out.gifs.map((g) => `<img data-gif="${g.url}" src="${g.preview}" alt="">`).join("") ||
        `<div class="tray-note">Nothing found.</div>`;
    } catch (e) {
      grid.innerHTML = `<div class="tray-note">GIF search failed.</div>`;
    }
  }

  els.btnEmoji.addEventListener("click", () => {
    els.tray.hidden = !els.tray.hidden;
    if (!els.tray.hidden) paintTray();
  });
  $("tray-x").addEventListener("click", () => { els.tray.hidden = true; });
  document.querySelector(".tray-head").addEventListener("click", (e) => {
    const b = e.target.closest(".tray-tab");
    if (!b) return;
    trayTab = b.dataset.tray;
    paintTray();
  });
  els.trayBody.addEventListener("click", async (e) => {
    const em = e.target.closest("[data-e]");
    if (em) return insertEmoji(em.dataset.e);
    const st = e.target.closest("[data-sticker]");
    if (st) {
      if (!state.current) return toast("Open a chat first");
      try {
        await api(`/api/chats/${jidOf(state.current)}/sticker`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: st.dataset.sticker }) });
        toast("Sticker sent");
      } catch (err) { toast(err.message); }
      return;
    }
    const gi = e.target.closest("[data-gif]");
    if (gi) {
      if (!state.current) return toast("Open a chat first");
      try {
        await api(`/api/chats/${jidOf(state.current)}/gif`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: gi.dataset.gif }) });
        toast("GIF sent");
      } catch (err) { toast(err.message); }
    }
  });

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

  els.older.addEventListener("click", async () => {
    if (!state.current || els.older.disabled || els.older.dataset.done) return;
    els.older.disabled = true;
    els.older.textContent = "Loading…";
    const jid = state.current;
    const before = (state.messages || []).length;
    try {
      const out = await api(`/api/chats/${jidOf(jid)}/older`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 50 }) });
      if (!out.ok) throw new Error(out.reason || "WhatsApp refused");
      let grew = false;
      for (let i = 0; i < 4 && !grew; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        const { messages } = await api(`/api/chats/${jidOf(jid)}/messages`);
        if ((messages || []).length > before) {
          state.messages = messages;
          renderThread(true);
          grew = true;
        }
      }
      els.older.disabled = false;
      els.older.textContent = grew ? "Load older messages" : "No more messages";
      if (!grew) { els.older.dataset.done = "1"; els.older.disabled = true; }
    } catch (e) {
      els.older.disabled = false;
      els.older.textContent = "Try again";
      toast(e.message || "Could not load older messages");
    }
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

  els.chats.addEventListener("click", async (e) => {
    const row = e.target.closest(".chat-row");
    if (!row) return;
    if (e.target.closest("#arch-row")) { state.showArchived = !state.showArchived; return renderChats(); }
    const jid = row.getAttribute("data-jid");
    if (state.selectMode) {
      if (state.selected.has(jid)) state.selected.delete(jid); else state.selected.add(jid);
      els.selCount.textContent = `${state.selected.size} selected`;
      return renderChats();
    }
    const onAvatar = !!e.target.closest("[data-avatar]");
    await openChat(jid);
    // Tapping the photo in the list goes straight to the group's info page.
    if (onAvatar) openGroupInfo();
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
    } catch (e) {
      toast(e.message);
    }
  })();
})();
