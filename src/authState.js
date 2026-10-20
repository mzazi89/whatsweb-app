// Baileys auth state kept in Postgres instead of a folder, so a redeploy does
// not unlink the phone. Shape matches useMultiFileAuthState.
const db = require("./db");

async function usePostgresAuthState(mod) {
  // baileys ships both CJS and ESM; the named exports may sit on mod or mod.default
  const b = mod && mod.default ? mod.default : mod;
  const initAuthCreds = (mod && mod.initAuthCreds) || b.initAuthCreds;
  const B = (mod && mod.BufferJSON) || b.BufferJSON;
  if (typeof initAuthCreds !== "function") throw new Error("baileys initAuthCreds missing");
  const read = async (name) => {
    const raw = await db.getAuth(name);
    if (!raw) return null;
    return JSON.parse(JSON.stringify(raw), B.reviver);
  };
  const write = async (name, value) => {
    await db.setAuth(name, JSON.parse(JSON.stringify(value, B.replacer)));
  };

  const stored = await read("creds");
  const creds = stored || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await read(`${type}-${id}`);
              if (value !== null && value !== undefined) {
                if (type === "app-state-sync-key") out[id] = B.reviver("", value);
                else out[id] = value;
              }
            })
          );
          return out;
        },
        set: async (data) => {
          const jobs = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type] || {})) {
              const value = data[type][id];
              if (value) jobs.push(write(`${type}-${id}`, value));
              else jobs.push(db.delAuth(`${type}-${id}`));
            }
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: async () => write("creds", creds),
  };
}

module.exports = { usePostgresAuthState };
