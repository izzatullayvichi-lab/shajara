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
      env.DB.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, data TEXT NOT NULL, updated INTEGER NOT NULL)"),
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
/* ---------- yordamchi hisoblar: parol xeshi, sessiya, ruxsatlar ---------- */
async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const PERM_MODES = ["none", "view", "edit"];
function cleanPerms(p) {
  p = p && typeof p === "object" ? p : {};
  const fam = PERM_MODES.includes(p.family) ? p.family : "none", cir = PERM_MODES.includes(p.circles) ? p.circles : "none";
  const br = p.branches === "all" ? "all" : Array.isArray(p.branches) ? [...new Set(p.branches.filter(x => typeof x === "string" && ID_RE.test(x)))].slice(0, 200) : [];
  return { family: fam, branches: fam === "none" ? [] : br, circles: cir };
}
// foydalanuvchi sessiyasi: "u.<id>.<exp>.<sig>", sig xeshning boshiga bog'langan — parol almashsa eski sessiyalar o'chadi
async function getUser(req, env) {
  if (!env.ADMIN_PASSWORD) return null;
  const v = readCookie(req, COOKIE); if (!v || !v.startsWith("u.")) return null;
  const [, uid, exp, sig] = v.split(".");
  if (!uid || !exp || !sig || +exp < Date.now() || !ID_RE.test(uid)) return null;
  const row = await env.DB.prepare("SELECT id, login, data FROM users WHERE id = ?").bind(uid).first(); if (!row) return null;
  const d = JSON.parse(row.data); if (d.disabled) return null;
  if (!safeEq(sig, await hmac(env.ADMIN_PASSWORD, "user." + uid + "." + exp + "." + String(d.hash).slice(0, 12)))) return null;
  return { id: row.id, login: row.login, name: d.name || row.login, perms: cleanPerms(d.perms) };
}
// ko'rinadigan odamlar: oila (butun yoki tanlangan shoxlar: avlodlar + turmush o'rtoqlari) va do'stlar davrasi
function computeScope(people, perms) {
  const byId = new Map(people.map(p => [p.id, p])), fam = new Set(), cir = new Set();
  for (const p of people) if (p.circle) { if (perms.circles !== "none") cir.add(p.id); }
  if (perms.family !== "none") {
    if (perms.branches === "all") { for (const p of people) if (!p.circle) fam.add(p.id); }
    else {
      const kids = new Map();
      for (const p of people) for (const par of [p.fatherId, p.motherId]) if (par) { if (!kids.has(par)) kids.set(par, []); kids.get(par).push(p.id); }
      const q = perms.branches.filter(id => byId.has(id) && !byId.get(id).circle);
      for (const r of q) fam.add(r);
      while (q.length) {
        const id = q.pop(), p = byId.get(id);
        for (const k of kids.get(id) || []) if (!fam.has(k)) { fam.add(k); q.push(k); }
        for (const s of (p && p.spouses) || []) if (byId.has(s) && !byId.get(s).circle) fam.add(s);
      }
    }
  }
  return { fam, cir, byId };
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

/* yordamchi hisob yozishi mumkinmi? null = ha, aks holda sabab matni */
async function guardWrite(env, user, tbl, id, method, body) {
  const pm = user.perms;
  if (tbl === "groups") return pm.circles === "edit" ? null : "Do'stlar davrasini tahrirlash ruxsati yo'q";
  const rows = (await env.DB.prepare("SELECT id, data FROM people").all()).results || [];
  const people = rows.map(r => ({ id: r.id, ...JSON.parse(r.data) }));
  const sc = computeScope(people, pm), cur = sc.byId.get(id) || null;
  const isCircleDoc = cur ? !!cur.circle : !!body.circle;
  if (cur && method !== "DELETE" && body.circle !== undefined && !!body.circle !== !!cur.circle) return "Turini o'zgartirib bo'lmaydi";
  if (isCircleDoc) {
    if (pm.circles !== "edit") return "Do'stlar davrasini tahrirlash ruxsati yo'q";
    if (body.fatherId || body.motherId || (body.spouses && body.spouses.length)) return "Do'st qarindoshlik bog'lamaydi";
    return null;
  }
  if (pm.family !== "edit") return "Oilani tahrirlash ruxsati yo'q";
  const inFam = x => sc.fam.has(x);
  const refsOk = () => [body.fatherId, body.motherId, ...(Array.isArray(body.spouses) ? body.spouses : [])].filter(Boolean).every(inFam);
  if (cur) {
    if (!inFam(id)) return "Bu shox sizga ochiq emas";
    if (method === "DELETE") return null;
    return refsOk() ? null : "Bog'langan odam sizga ochiq emas";
  }
  if (method === "DELETE") return null;
  const linked = [body.fatherId, body.motherId, ...(Array.isArray(body.spouses) ? body.spouses : [])].filter(Boolean);
  if (pm.branches === "all" && !linked.length) return null;
  if (!linked.length || !linked.some(inFam)) return "Yangi odamni ruxsat etilgan shoxga bog'lang";
  return refsOk() ? null : "Bog'langan odam sizga ochiq emas";
}

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const seg = [].concat(params.path || []);
  const method = req.method;
  try {
    await init(env);
    const admin = await isAdmin(req, env);
    const user = admin ? null : await getUser(req, env);
    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating && req.headers.get("x-sj") !== "1") return fail(400, "Bad request");

    // GET /api/me
    if (seg[0] === "me" && method === "GET") return json({ admin, user: user ? { id: user.id, name: user.name, perms: user.perms } : null, configured: !!env.ADMIN_PASSWORD });

    // POST /api/login {login?, password} — login bo'sh yoki "owner" bo'lsa: egasi (ADMIN_PASSWORD); aks holda yordamchi hisob
    if (seg[0] === "login" && method === "POST") {
      if (!env.ADMIN_PASSWORD) return fail(503, "ADMIN_PASSWORD o'rnatilmagan");
      const { password, login } = await readBodyJson(req), lg = String(login || "").trim().toLowerCase();
      if (typeof password !== "string") return fail(400, "Parol kerak");
      const cookie = v => `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secureFlag(req)}`;
      const exp = Date.now() + SESSION_DAYS * 864e5;
      if (!lg || lg === "owner") {
        const ok = safeEq(await hmac("cmp", password), await hmac("cmp", env.ADMIN_PASSWORD));
        if (!ok) { await new Promise(r => setTimeout(r, 1200)); return fail(401, "Parol noto'g'ri"); }
        return json({ admin: true }, 200, { "set-cookie": cookie(exp + "." + await hmac(env.ADMIN_PASSWORD, "admin." + exp)) });
      }
      const row = await env.DB.prepare("SELECT id, data FROM users WHERE login = ?").bind(lg).first();
      const d = row ? JSON.parse(row.data) : null;
      const ok = d && !d.disabled && safeEq(await pbkdf2(password, d.salt), d.hash);
      if (!ok) { await new Promise(r => setTimeout(r, 1200)); return fail(401, "Login yoki parol noto'g'ri"); }
      return json({ admin: false, user: { id: row.id, name: d.name } }, 200, { "set-cookie": cookie(`u.${row.id}.${exp}.` + await hmac(env.ADMIN_PASSWORD, "user." + row.id + "." + exp + "." + String(d.hash).slice(0, 12))) });
    }
    // POST /api/logout
    if (seg[0] === "logout" && method === "POST")
      return json({ admin: false }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFlag(req)}` });

    // GET /api/data
    // Egasi: hammasi. Yordamchi: faqat ruxsat etilgan shox/bo'lim. Mehmon: ochiq bo'lsa (meta.publicView !== false) oila,
    // tirik odamlarning kun/oyi va telefonlari yashirin (meta.birthPublic / phonesPublic bo'lmasa); do'stlar davrasi faqat meta.circlesPublic bo'lsa.
    if (seg[0] === "data" && method === "GET") {
      const rows = (await env.DB.prepare("SELECT id, data, updated FROM people").all()).results || [];
      const grows = (await env.DB.prepare("SELECT id, data, updated FROM groups").all()).results || [];
      const m = await env.DB.prepare("SELECT data FROM meta WHERE k = 'info'").first();
      const meta = m ? JSON.parse(m.data) : {};
      let upd = 0;
      let people = rows.map(r => { upd = Math.max(upd, r.updated); return { id: r.id, ...JSON.parse(r.data) }; });
      let groups = grows.map(r => { upd = Math.max(upd, r.updated); return { id: r.id, ...JSON.parse(r.data) }; });
      let me = admin ? { role: "owner" } : null;
      if (!admin) {
        delete meta.meId;
        const strip = p => { if (!p.phone && !p.tg && !p.ig) return p; const { phone, tg, ig, ...rest } = p; return rest; };
        if (user) {
          me = { role: "user", name: user.name, perms: user.perms };
          const sc = computeScope(people, user.perms);
          people = people.filter(p => sc.fam.has(p.id) || sc.cir.has(p.id));
          const vis = new Set(people.map(p => p.id));
          groups = user.perms.circles === "none" ? [] : groups.map(g => ({ ...g, members: (g.members || []).filter(x => vis.has(x.id)) }));
          people = people.map(p => {
            const canEditP = p.circle ? user.perms.circles === "edit" : user.perms.family === "edit";
            if (canEditP) return p;
            p = forViewer(p, !!meta.birthPublic); return meta.phonesPublic ? p : strip(p);
          });
        } else if (meta.publicView === false) {
          return json({ people: [], groups: [], meta: { title: meta.title, publicView: false }, rev: "locked", admin: false, locked: true });
        } else {
          if (!meta.circlesPublic) { people = people.filter(p => !p.circle); groups = []; }
          people = people.map(p => forViewer(p, !!meta.birthPublic));
          if (!meta.phonesPublic) people = people.map(strip);
        }
      }
      return json({ people, groups, meta, me, rev: upd + ":" + people.length + ":" + groups.length + ":" + JSON.stringify(meta).length + ":" + (user ? user.id : ""), admin });
    }

    // GET /api/users (faqat egasi)
    if (seg[0] === "users" && method === "GET") {
      if (!admin) return fail(403, "Faqat egasi");
      const us = (await env.DB.prepare("SELECT id, login, data FROM users ORDER BY login").all()).results || [];
      return json({ users: us.map(r => { const d = JSON.parse(r.data); return { id: r.id, login: r.login, name: d.name, perms: cleanPerms(d.perms), disabled: !!d.disabled }; }) });
    }

    // GET /api/stats — baza hajmi (faqat egasi). D1 bepul tarifi: bitta baza 500 MB, qator 2 MB, akkaunt bo'yicha 5 GB.
    if (seg[0] === "stats" && method === "GET") {
      if (!admin) return fail(403, "Ruxsat yo'q");
      const one = async q => (await env.DB.prepare(q).first()) || {};
      const pe = await one("SELECT COUNT(*) n, COALESCE(SUM(LENGTH(data)),0) b FROM people");
      const gr = await one("SELECT COUNT(*) n, COALESCE(SUM(LENGTH(data)),0) b FROM groups");
      const ph = await one("SELECT COUNT(*) n, COALESCE(SUM(LENGTH(b64)),0) b, COALESCE(MAX(LENGTH(b64)),0) mx FROM photos");
      const me = await one("SELECT COALESCE(SUM(LENGTH(data)),0) b FROM meta");
      const total = pe.b + gr.b + ph.b + me.b, LIMIT = 500 * 1024 * 1024;
      return json({ people: pe.n, peopleBytes: pe.b, groups: gr.n, groupsBytes: gr.b, photos: ph.n, photosBytes: ph.b, photoMax: ph.mx, metaBytes: me.b,
        totalBytes: total, limitBytes: LIMIT, avgPhoto: ph.n ? Math.round(ph.b / ph.n) : 0, photosLeft: Math.floor((LIMIT - total) / Math.max(150 * 1024, ph.n ? ph.b / ph.n : 0)) });
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
    const canAny = admin || (user && (user.perms.family === "edit" || user.perms.circles === "edit"));
    if (!canAny) return fail(403, "Tahrirlash uchun kiring");

    // ---- foydalanuvchilar (faqat egasi) ----
    if (seg[0] === "users") {
      if (!admin) return fail(403, "Faqat egasi");
      if (seg.length === 1 && method === "GET") { /* quyida GET bo'limida */ }
      if (seg[1] && ID_RE.test(seg[1]) && seg.length === 2) {
        const id = seg[1], now = Date.now();
        if (method === "DELETE") { await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run(); return json({ ok: true }); }
        if (method === "PUT") {
          const b = await readBodyJson(req), lg = String(b.login || "").trim().toLowerCase();
          if (!/^[a-z0-9._-]{3,32}$/.test(lg) || lg === "owner") return fail(400, "Login 3–32 belgi: a–z, 0–9, . _ -");
          const cur = await env.DB.prepare("SELECT data FROM users WHERE id = ?").bind(id).first(), old = cur ? JSON.parse(cur.data) : null;
          let salt = old && old.salt, hash = old && old.hash;
          if (b.password) {
            if (typeof b.password !== "string" || b.password.length < 8) return fail(400, "Parol kamida 8 belgi");
            salt = randomId(16); hash = await pbkdf2(b.password, salt);
          }
          if (!hash) return fail(400, "Parol kerak");
          const dup = await env.DB.prepare("SELECT id FROM users WHERE login = ? AND id != ?").bind(lg, id).first();
          if (dup) return fail(409, "Bu login band");
          const data = { name: String(b.name || lg).slice(0, 80), salt, hash, perms: cleanPerms(b.perms), disabled: !!b.disabled, createdAt: (old && old.createdAt) || now };
          await env.DB.prepare("INSERT INTO users (id, login, data, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET login = ?2, data = ?3, updated = ?4").bind(id, lg, JSON.stringify(data), now).run();
          return json({ ok: true });
        }
      }
      return fail(404, "Not found");
    }
    if (seg[0] === "meta" && !admin) return fail(403, "Faqat egasi");


    // PUT/PATCH/DELETE /api/people/:id  va  /api/groups/:id
    if ((seg[0] === "people" || seg[0] === "groups") && seg[1] && ID_RE.test(seg[1]) && seg.length === 2) {
      const tbl = seg[0] === "groups" ? "groups" : "people", id = seg[1], now = Date.now();
      if (method === "DELETE") {
        if (user) { const g = await guardWrite(env, user, tbl, id, "DELETE", {}); if (g) return fail(403, g); }
        await env.DB.prepare(`DELETE FROM ${tbl} WHERE id = ?`).bind(id).run(); return json({ ok: true });
      }
      const body = method === "DELETE" ? {} : await readBodyJson(req); delete body.id;
      if (user) {
        const g = await guardWrite(env, user, tbl, id, method, body);
        if (g) return fail(403, g);
      }
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
