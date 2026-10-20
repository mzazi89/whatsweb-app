// Neon/Postgres persistence for the two things a container cannot keep:
// the linked-device credentials and the messages themselves.
const crypto = require("crypto");
const { Pool } = require("pg");

const URL = String(process.env.DATABASE_URL || "").trim();
const RAW_KEY = String(process.env.SESSION_KEY || "").trim();
const ACCOUNT = String(process.env.ACCOUNT_ID || "default");

const enabled = () => !!URL;

// creds are a full WhatsApp session: private keys that can send as the user.
// They are encrypted before they ever reach the database.
const key = RAW_KEY
  ? crypto.createHash("sha256").update(RAW_KEY).digest()
  : crypto.createHash("sha256").update("insecure-default-" + ACCOUNT).digest();

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function open(blob) {
  if (!blob) return null;
  if (!blob.ct) return blob; // tolerate plaintext rows from an earlier version
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  d.setAuthTag(Buffer.from(blob.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.ct, "base64")), d.final()]).toString("utf8"));
}

let pool = null;
function db() {
  if (!enabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: URL,
      ssl: URL.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
      max: 3,
      idleTimeoutMillis: 20000,
    });
    pool.on("error", (e) => console.error("[db]", e.message));
  }
  return pool;
}

async function q(sql, params = []) {
  const p = db();
  if (!p) return { rows: [] };
  return p.query(sql, params);
}

const SCHEMA = `
create table if not exists wa_auth (
  account_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, key)
);

create table if not exists wa_chats (
  account_id text not null,
  jid text not null,
  name text,
  kind text,
  last_ts bigint,
  unread int default 0,
  last_text text,
  primary key (account_id, jid)
);
alter table wa_chats add column if not exists last_text text;
alter table wa_chats add column if not exists archived boolean default false;
alter table wa_messages add column if not exists author_name text;

create table if not exists wa_contacts (
  account_id text not null,
  jid text not null,
  name text,
  push_name text,
  primary key (account_id, jid)
);

create table if not exists wa_messages (
  account_id text not null,
  jid text not null,
  id text not null,
  ts bigint not null,
  from_me boolean not null default false,
  kind text not null default 'text',
  body text,
  author text,
  primary key (account_id, id)
);
create index if not exists wa_messages_chat on wa_messages (account_id, jid, ts desc);

create table if not exists wa_statuses (
  account_id text not null,
  jid text not null,
  ts bigint not null,
  kind text,
  body text,
  primary key (account_id, jid, ts)
);

create table if not exists wa_calls (
  id bigserial primary key,
  account_id text not null,
  jid text not null,
  ts bigint not null,
  status text,
  video boolean default false
);
`;

async function migrate() {
  if (!enabled()) return false;
  await q(SCHEMA);
  return true;
}

// ---- auth state ----
async function getAuth(keyName) {
  const { rows } = await q("select value from wa_auth where account_id=$1 and key=$2", [ACCOUNT, keyName]);
  if (!rows.length) return null;
  try { return open(rows[0].value); } catch (e) { console.error("[db] decrypt failed", keyName, e.message); return null; }
}

async function setAuth(keyName, value) {
  await q(
    `insert into wa_auth (account_id, key, value, updated_at) values ($1,$2,$3,now())
     on conflict (account_id, key) do update set value=excluded.value, updated_at=now()`,
    [ACCOUNT, keyName, JSON.stringify(seal(value))]
  );
}

async function delAuth(keyName) {
  await q("delete from wa_auth where account_id=$1 and key=$2", [ACCOUNT, keyName]);
}

async function clearAuth() {
  await q("delete from wa_auth where account_id=$1", [ACCOUNT]);
}

// ---- chats / contacts ----
async function saveChat(c) {
  await q(
    `insert into wa_chats (account_id, jid, name, kind, last_ts, unread, last_text, archived) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (account_id, jid) do update set
       name=coalesce(excluded.name, wa_chats.name),
       kind=coalesce(excluded.kind, wa_chats.kind),
       last_ts=greatest(coalesce(wa_chats.last_ts,0), coalesce(excluded.last_ts,0)),
       unread=excluded.unread,
       last_text=case when coalesce(excluded.last_ts,0) >= coalesce(wa_chats.last_ts,0) then coalesce(excluded.last_text, wa_chats.last_text) else wa_chats.last_text end,
       archived=coalesce(excluded.archived, wa_chats.archived)`,
    [ACCOUNT, c.id, c.name || null, c.kind || null, c.lastTs || null, c.unread || 0, c.last || null, c.archived ?? null]
  );
}

async function saveContact(c) {
  await q(
    `insert into wa_contacts (account_id, jid, name, push_name) values ($1,$2,$3,$4)
     on conflict (account_id, jid) do update set
       name=coalesce(excluded.name, wa_contacts.name),
       push_name=coalesce(excluded.push_name, wa_contacts.push_name)`,
    [ACCOUNT, c.id, c.name || null, c.pushName || null]
  );
}

async function saveMessage(m) {
  await q(
    `insert into wa_messages (account_id, jid, id, ts, from_me, kind, body, author, author_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (account_id, id) do update set author_name=coalesce(excluded.author_name, wa_messages.author_name)`,
    [ACCOUNT, m.jid, m.id, m.ts || Date.now(), !!m.fromMe, m.kind || "text", m.text || m.body || null, m.author || null, m.authorName || null]
  );
}

async function loadChats() {
  const { rows } = await q(
    "select jid, name, kind, last_ts, unread, last_text, archived from wa_chats where account_id=$1 order by last_ts desc nulls last limit 400",
    [ACCOUNT]
  );
  return rows.map((r) => ({ id: r.jid, name: r.name, kind: r.kind, lastTs: Number(r.last_ts) || 0, unread: r.unread || 0, last: r.last_text, archived: r.archived }));
}

async function loadContacts() {
  const { rows } = await q("select jid, name, push_name from wa_contacts where account_id=$1 limit 2000", [ACCOUNT]);
  return rows.map((r) => ({ id: r.jid, name: r.name, pushName: r.push_name }));
}

async function loadMessages(jid, limit = 200) {
  const { rows } = await q(
    `select id, ts, from_me, kind, body, author from wa_messages
     where account_id=$1 and jid=$2 order by ts desc limit $3`,
    [ACCOUNT, jid, limit]
  );
  return rows.reverse().map((r) => ({
    id: r.id, ts: Number(r.ts), fromMe: r.from_me, kind: r.kind, text: r.body, author: r.author, authorName: r.author_name,
  }));
}

async function saveStatus(s) {
  await q(
    `insert into wa_statuses (account_id, jid, ts, kind, body) values ($1,$2,$3,$4,$5)
     on conflict (account_id, jid, ts) do update set kind=excluded.kind, body=excluded.body`,
    [ACCOUNT, s.jid, s.ts || Date.now(), s.kind || "text", s.text || null]
  );
}

async function saveCall(c) {
  await q("insert into wa_calls (account_id, jid, ts, status, video) values ($1,$2,$3,$4,$5)",
    [ACCOUNT, c.jid, c.ts || Date.now(), c.status || "offer", !!c.video]);
}

// 90 days is enough to re-open a chat after a re-link without filling the free tier.
async function prune() {
  await q("delete from wa_messages where account_id=$1 and ts < $2", [ACCOUNT, Date.now() - 90 * 864e5]);
}

module.exports = {
  enabled, db, q, migrate, prune,
  getAuth, setAuth, delAuth, clearAuth,
  saveChat, saveContact, saveMessage, loadChats, loadContacts, loadMessages,
  saveStatus, saveCall,
  ACCOUNT,
};
