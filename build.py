#!/usr/bin/env python3
"""claude.ai versiyasidagi sahifadan (src/shajara.html) mustaqil sayt uchun public/index.html yasaydi."""
import pathlib, sys
root = pathlib.Path(__file__).parent
src = (root / "src" / "shajara.html").read_text(encoding="utf-8")

def rep(s, a, b):
    if a not in s: sys.exit("build: topilmadi -> " + a[:70])
    return s.replace(a, b, 1)

# 1) login / logout button in the header
src = rep(src, '<button class="me-chip" id="meChip" hidden></button>',
  '<button class="me-chip" id="meChip" hidden></button>\n      <button class="side-btn" id="authBtn" hidden></button>')

# 2) auth UI code, inserted before boot
auth_js = r'''
/* ================= Server login (Cloudflare) ================= */
Object.assign(L, { login:"Kirish", logout:"Chiqish", loginTitle:"Tahrirlash uchun kirish", pw:"Parol", loginErr:"Parol noto'g'ri.",
  loginHint:"Faqat shajara egasi kiradi. Qarindoshlar saytni parolsiz ko'radi.", loginNoPw:"Serverda parol hali o'rnatilmagan (ADMIN_PASSWORD).", loginBusy:"Tekshirilmoqda…" });
function renderAuth(){
  const b = $("authBtn"); if (!b) return;
  if (!window.SJ || !S.loaded){ b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = SJ.admin
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/></svg><span>${esc(t("logout"))}</span>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/></svg><span>${esc(t("login"))}</span>`;
}
function openLogin(){
  const m = $("modal");
  m.innerHTML = `<form class="form" id="lf" novalidate style="width:min(420px,100%)">
    <h2>${esc(t("loginTitle"))}</h2><p class="hint">${esc(t(SJ.configured ? "loginHint" : "loginNoPw"))}</p>
    <label class="f-field"><span>${esc(t("pw"))}</span><input id="lpw" type="password" autocomplete="current-password" required></label>
    <p class="err" id="lerr" hidden></p>
    <div class="form-foot"><button type="button" class="btn" id="lcancel">${esc(t("cancel"))}</button><button class="btn primary" id="lgo">${esc(t("login"))}</button></div></form>`;
  m.hidden = false; setTimeout(() => $("lpw").focus(), 30);
  const close = () => { m.hidden = true; m.innerHTML = ""; };
  $("lcancel").onclick = close; m.onclick = e => { if (e.target === m) close(); };
  $("lf").onsubmit = async e => {
    e.preventDefault(); const pw = $("lpw").value; if (!pw) return;
    $("lgo").disabled = true; $("lgo").textContent = t("loginBusy");
    try { if (await SJ.login(pw)){ location.reload(); return; } $("lerr").textContent = t("loginErr"); }
    catch(x){ $("lerr").textContent = t(SJ.configured ? "errSave" : "loginNoPw"); }
    $("lerr").hidden = false; $("lgo").disabled = false; $("lgo").textContent = t("login");
  };
}
$("authBtn").onclick = async () => { if (!window.SJ) return; if (SJ.admin){ await SJ.logout(); location.reload(); } else openLogin(); };
const _renderChrome = renderChrome;
renderChrome = function(){ _renderChrome(); renderAuth(); };
'''
src = rep(src, "/* ================= Boot ================= */", auth_js + "\n/* ================= Boot ================= */")
# renderChrome must be reassignable
src = rep(src, "function renderChrome(){", "var renderChrome = function(){")
src = rep(src, "function renderState(){", ";\nfunction renderState(){")
# restore photos from a server backup
src = rep(src, 'for (const id of oldIds) if (!ids.has(id)) await ref(id).delete();',
  'if (Array.isArray(data.photos) && window.SJ) for (const ph of data.photos){ const r = await fetch("/api/photos/" + ph.id, { method:"PUT", headers:{ "x-sj":"1", "content-type":"application/json" }, body: JSON.stringify({ type:ph.type, b64:ph.b64 }) }); if (!r.ok) throw new Error("photo restore failed"); }\n        for (const id of oldIds) if (!ids.has(id)) await ref(id).delete();')
# adapter before the main script
src = rep(src, "<script>\n/* ================= Script conversion", '<script src="/sj-adapter.js"></script>\n<script>\n/* ================= Script conversion')

head = '''<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="Oila shajarasi — avlodlar daraxti">
<meta name="theme-color" content="#0E3B2C">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='10' fill='%230E3B2C'/%3E%3Cg fill='none' stroke='%23E5C16C' stroke-width='2.6'%3E%3Crect x='14' y='14' width='20' height='20'/%3E%3Crect x='14' y='14' width='20' height='20' transform='rotate(45 24 24)'/%3E%3Ccircle cx='24' cy='24' r='4'/%3E%3C/g%3E%3C/svg%3E">
<link rel="preload" href="/fonts/alegreya-800.woff" as="font" type="font/woff" crossorigin>
<script>(function(){try{var v=localStorage.getItem("shajara.theme");if(v!=="dark"&&v!=="light")v=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=v}catch(e){}})()</script>
<style>:root{color-scheme:light dark;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
'''
out = head + src.replace('url("img/', 'url("/img/').replace('url("fonts/', 'url("/fonts/').replace('fetch("fonts/', 'fetch("/fonts/') + "\n</body>\n</html>\n"
(root / "public" / "index.html").write_text(out, encoding="utf-8")
print("public/index.html:", len(out), "bytes")
