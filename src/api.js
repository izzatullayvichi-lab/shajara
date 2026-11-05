// Shajara API — Cloudflare Worker + D1.
// Kerakli sozlamalar (Cloudflare → Worker → Settings):
//   • D1 binding:        DB  (wrangler.jsonc da, deployda avtomatik yaratiladi)
//   • Secret (maxfiy):   ADMIN_PASSWORD → tahrirlash paroli
import seed from "../lib/seed.js";

const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 256 * 1024;
const MAX_PHOTO = 3 * 1024 * 1024;
const COOKIE = "sj_s";
const SESSION_DAYS = 180;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (status, message) => json({ error: message }, status);

/* ---------- database setup (runs once per worker instance) ---------- */
let ready = null;
function init(env) {
  if (!env.DB) throw new Error("D1 bazasi ulanmagan: Settings → Bindings → D1 → nomi DB");
  if (!ready) ready = (async () => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, data TEXT NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, type TEXT NOT NULL, b64 TEXT NOT NULL, created INTEGER NOT NULL)"),
    ]);
    const seeded = await env.DB.prepare("SELECT k FROM meta WHERE k = 'seeded'").first();
    if (!seeded) {
      const now = Date.now(), stmts = [];
      for (const p of seed.people || []) {
        const { id, ...data } = p;
        if (ID_RE.test(id)) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO people (id, data, updated) VALUES (?, ?, ?)").bind(id, JSON.stringify(data), now));
      }
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO meta (k, data) VALUES ('info', ?)").bind(JSON.stringify(seed.meta || {})));
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k, data) VALUES ('seeded', ?)").bind(JSON.stringify({ at: now })));
      await env.DB.batch(stmts);
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/* ---------- auth: signed cookie derived from ADMIN_PASSWORD ---------- */
const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function readCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  for (const part of c.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
async function isAdmin(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const v = readCookie(req, COOKIE); if (!v) return false;
  const [exp, sig] = v.split(".");
  if (!exp || !sig || +exp < Date.now()) return false;
  return safeEq(sig, await hmac(env.ADMIN_PASSWORD, "admin." + exp));
}
const secureFlag = req => new URL(req.url).protocol === "https:" ? "; Secure" : "";

/* ---------- privacy: viewers see only the birth year of living people ---------- */
function yearOnly(s) { const m = String(s || "").match(/(\d{4})/); return m ? m[1] : ""; }
// meta.birthPublic = egasi tirik qarindoshlarning kun va oyini hammaga ochgan; p.privBirth = shu odam uchun baribir yashirin.
function forViewer(p, pub) {
  const living = !p.deceased && !p.deathDate;
  if (!living || (pub && !p.privBirth)) return p;
  return { ...p, birthDate: yearOnly(p.birthDate) };
}

/* ---------- handlers ---------- */
async function readBodyJson(req) {
  const len = +(req.headers.get("content-length") || 0);
  if (len > MAX_DOC) throw Object.assign(new Error("too large"), { status: 413 });
  const txt = await req.text();
  if (txt.length > MAX_DOC) throw Object.assign(new Error("too large"), { status: 413 });
  const v = JSON.parse(txt);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Object.assign(new Error("object expected"), { status: 400 });
  return v;
}
function b64FromBuf(buf) { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function randomId(n = 16) { return [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join(""); }

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const seg = [].concat(params.path || []);
  const method = req.method;
  try {
    await init(env);
    const admin = await isAdmin(req, env);
    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating && req.headers.get("x-sj") !== "1") return fail(400, "Bad request");

    // GET /api/me
    if (seg[0] === "me" && method === "GET") return json({ admin, configured: !!env.ADMIN_PASSWORD });

    // POST /api/login {password}
    if (seg[0] === "login" && method === "POST") {
      if (!env.ADMIN_PASSWORD) return fail(503, "ADMIN_PASSWORD o'rnatilmagan");
      const { password } = await readBodyJson(req);
      const ok = typeof password === "string" && safeEq(await hmac("cmp", password), await hmac("cmp", env.ADMIN_PASSWORD));
      if (!ok) { await new Promise(r => setTimeout(r, 1200)); return fail(401, "Parol noto'g'ri"); }
      const exp = Date.now() + SESSION_DAYS * 864e5;
      const v = exp + "." + await hmac(env.ADMIN_PASSWORD, "admin." + exp);
      return json({ admin: true }, 200, { "set-cookie": `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secureFlag(req)}` });
    }
    // POST /api/logout
    if (seg[0] === "logout" && method === "POST")
      return json({ admin: false }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFlag(req)}` });

    // GET /api/data
    // Egasi: hammasi. Mehmon: tirik odamlarning kun/oyi yashirin (meta.birthPublic bo'lmasa); do'stlar davrasi faqat meta.circlesPublic bo'lsa.
    if (seg[0] === "data" && method === "GET") {
      const rows = (await env.DB.prepare("SELECT id, data, updated FROM people").all()).results || [];
      const grows = (await env.DB.prepare("SELECT id, data, updated FROM groups").all()).results || [];
      const m = await env.DB.prepare("SELECT data FROM meta WHERE k = 'info'").first();
      const meta = m ? JSON.parse(m.data) : {};
      let upd = 0;
      let people = rows.map(r => { upd = Math.max(upd, r.updated); return { id: r.id, ...JSON.parse(r.data) }; });
      let groups = grows.map(r => { upd = Math.max(upd, r.updated); return { id: r.id, ...JSON.parse(r.data) }; });
      if (!admin) {
        if (!meta.circlesPublic) { people = people.filter(p => !p.circle); groups = []; }
        people = people.map(p => forViewer(p, !!meta.birthPublic));
        if (!meta.phonesPublic) people = people.map(p => { if (!p.phone) return p; const { phone, ...rest } = p; return rest; });
        delete meta.meId;
      }
      return json({ people, groups, meta, rev: upd + ":" + people.length + ":" + groups.length + ":" + JSON.stringify(meta).length, admin });
    }

    // GET /api/backup — to'liq zaxira (GitHub Actions haftalik oladi). Authorization: Bearer <BACKUP_TOKEN>
    if (seg[0] === "backup" && method === "GET") {
      const auth = req.headers.get("authorization") || "";
      const okToken = env.BACKUP_TOKEN && env.BACKUP_TOKEN.length >= 16 && safeEq(auth, "Bearer " + env.BACKUP_TOKEN);
      if (!admin && !okToken) return fail(403, "Ruxsat yo'q");
      const rows = (await env.DB.prepare("SELECT id, data FROM people ORDER BY id").all()).results || [];
      const m = await env.DB.prepare("SELECT data FROM meta WHERE k = 'info'").first();
      const ph = (await env.DB.prepare("SELECT id, type, b64 FROM photos ORDER BY id").all()).results || [];
      const gr = (await env.DB.prepare("SELECT id, data FROM groups ORDER BY id").all()).results || [];
      return json({ app: "shajara", version: 3, exportedAt: new Date().toISOString(), meta: m ? JSON.parse(m.data) : {},
        people: rows.map(r => ({ id: r.id, ...JSON.parse(r.data) })), groups: gr.map(r => ({ id: r.id, ...JSON.parse(r.data) })), photos: ph });
    }

    if (!mutating) return fail(404, "Not found");
    if (!admin) return fail(403, "Tahrirlash uchun kiring");

    // PUT/PATCH/DELETE /api/people/:id  va  /api/groups/:id
    if ((seg[0] === "people" || seg[0] === "groups") && seg[1] && ID_RE.test(seg[1]) && seg.length === 2) {
      const tbl = seg[0] === "groups" ? "groups" : "people", id = seg[1], now = Date.now();
      if (method === "DELETE") { await env.DB.prepare(`DELETE FROM ${tbl} WHERE id = ?`).bind(id).run(); return json({ ok: true }); }
      const body = await readBodyJson(req); delete body.id;
      if (method === "PUT") {
        await env.DB.prepare(`INSERT INTO ${tbl} (id, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, updated = ?3`).bind(id, JSON.stringify(body), now).run();
        return json({ ok: true });
      }
      if (method === "PATCH") {
        const cur = await env.DB.prepare(`SELECT data FROM ${tbl} WHERE id = ?`).bind(id).first();
        if (!cur) return fail(404, "Topilmadi");
        const merged = { ...JSON.parse(cur.data), ...body };
        await env.DB.prepare(`UPDATE ${tbl} SET data = ?, updated = ? WHERE id = ?`).bind(JSON.stringify(merged), now, id).run();
        return json({ ok: true });
      }
    }
    // PUT /api/meta
    if (seg[0] === "meta" && method === "PUT" && seg.length === 1) {
      const body = await readBodyJson(req);
      await env.DB.prepare("INSERT INTO meta (k, data) VALUES ('info', ?1) ON CONFLICT(k) DO UPDATE SET data = ?1").bind(JSON.stringify(body)).run();
      return json({ ok: true });
    }
    // POST /api/photos  (raw image body)   DELETE /api/photos/:id
    if (seg[0] === "photos") {
      if (method === "POST" && seg.length === 1) {
        const type = (req.headers.get("content-type") || "").split(";")[0].trim();
        if (!["image/jpeg", "image/png", "image/webp"].includes(type)) return fail(415, "Faqat JPG, PNG yoki WEBP");
        const buf = await req.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > MAX_PHOTO) return fail(413, "Surat juda katta");
        const id = randomId();
        await env.DB.prepare("INSERT INTO photos (id, type, b64, created) VALUES (?, ?, ?, ?)").bind(id, type, b64FromBuf(buf), Date.now()).run();
        return json({ id, url: "/_blob/" + id, sizeBytes: buf.byteLength, contentType: type });
      }
      if (method === "PUT" && seg[1] && /^[a-f0-9]{32}$/.test(seg[1])) {
        const len = +(req.headers.get("content-length") || 0);
        if (len > MAX_PHOTO * 1.4) return fail(413, "Surat juda katta");
        const { type, b64 } = JSON.parse(await req.text());
        if (!["image/jpeg", "image/png", "image/webp"].includes(type) || typeof b64 !== "string" || !/^[A-Za-z0-9+/=]+$/.test(b64)) return fail(400, "Surat noto'g'ri");
        await env.DB.prepare("INSERT OR REPLACE INTO photos (id, type, b64, created) VALUES (?, ?, ?, ?)").bind(seg[1], type, b64, Date.now()).run();
        return json({ ok: true });
      }
      if (method === "DELETE" && seg[1] && /^[a-f0-9]{32}$/.test(seg[1])) {
        const r = await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(seg[1]).run();
        return json({ deleted: !!(r.meta && r.meta.changes) });
      }
    }
    return fail(404, "Not found");
  } catch (e) {
    if (e && e.status) return fail(e.status, e.message);
    if (e instanceof SyntaxError) return fail(400, "JSON noto'g'ri");
    return fail(500, String(e && e.message || e));
  }
}
