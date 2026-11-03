# Oila shajarasi — mustaqil sayt

Cloudflare Worker (bepul) + D1 bazasi. Kod va haftalik zaxira shu GitHub repozitoriyda saqlanadi.

- **Ko'rish:** havolani olgan har kim ko'radi (kirishsiz). Tirik insonlarning tug'ilgan kun va oyi yashiriladi — faqat yili ko'rinadi.
- **Tahrirlash:** faqat egasi, sahifadagi «Kirish» tugmasi orqali parol bilan.
- Qidiruv tizimlari saytni indekslamaydi (`noindex`).
- Zaxira fayllarida qarindoshlarning shaxsiy ma'lumotlari va sanalari bor. GitHub repozitoriysi `Private` ekanini tekshiring.

## Bir martalik sozlash

Loyiha Cloudflare **Worker** (statik fayllar + API) sifatida ishlaydi. Har `main` ga push qilinganda Cloudflare o'zi qayta quradi.

1. **Workers & Pages → Create → Import a repository** → `shajara` (allaqachon ulangan).
   Build command: `npm run build`, Deploy command: `npx wrangler deploy` (standart).
2. D1 bazasi (`shajara-db`) birinchi deployda **avtomatik yaratiladi** — qo'lda hech narsa kerak emas.
   Jadvallar va boshlang'ich 10 kishilik shajara sayt birinchi ochilganda yoziladi. Avvaldan ishlayotgan bazadagi odamlar avtomatik o'zgarmaydi.
3. Worker → **Settings → Variables and Secrets → Add**:
   - Type **Secret**, `ADMIN_PASSWORD` = tahrirlash paroli (kamida 12 belgi)
   - Type **Secret**, `BACKUP_TOKEN` = kamida 16 belgili tasodifiy matn (zaxira uchun)
4. Sayt manzili: Worker → **Domains** bo'limida (`shajara.<akkaunt>.workers.dev`). Oching → **Kirish** → parol.

### Haftalik avtomatik zaxira
GitHub → repozitoriy → **Settings → Secrets and variables → Actions → New repository secret**:
- `SITE_URL` = sayt manzili (masalan `https://shajara.xxxx.workers.dev`)
- `BACKUP_TOKEN` = Cloudflare'dagi bilan aynan bir xil

Har yakshanba `backup/shajara-zaxira.json` yangilanadi. Darhol sinash: **Actions → Haftalik zaxira → Run workflow**.

## Zaxiradan tiklash
Saytda **Eksport → Zaxira nusxa → Fayldan tiklash** → zaxira faylini tanlang. Import mavjud odamlarni ham o'chirib, zaxiradagi shajara bilan to'liq almashtiradi; avval joriy bazadan zaxira yuklab oling.

Yangi shajarani avvaldan ishlayotgan saytga o'rnatish uchun `backup/yusupovlar-zaxira.json` faylini import qiling. Saytdan yuklangan egasi zaxirasi fotosuratlarni ham o'z ichiga oladi.

## O'z domeningiz (ixtiyoriy, pullik)
Masalan `qochqorovlar.uz` sotib olsangiz: Worker → **Domains → Add custom domain**.

## Dasturchi uchun
- `src/shajara.html` — asosiy sahifa (claude.ai versiyasi bilan bir xil).
- `python3 build.py` (Linux/macOS) yoki `python build.py` (Windows) → `public/index.html` yasaydi (server adapteri va kirish tugmasini qo'shadi). `npm run build` barcha muhitlarda shu build'ni ishga tushiradi.
- `public/sj-adapter.js` — sahifani `/api` ga ulaydi.
- `src/worker.js` — kirish nuqtasi, `src/api.js` — API (D1), `src/blob.js` — suratlar, `wrangler.jsonc` — sozlama.
- `lib/seed.js` — Mavluda, Toxir, Sayfiddin, Kimyoxon, Maxbubaxon, Aqoyiddin, Ulugbek, Nodira, OdinaBonu va Abdulaziz shajarasi. Maxbubaxon va Aqoyiddinning qarindoshlik aloqasi ko'rsatilmagani uchun hozircha alohida turadi.
- Mahalliy sinov: `npm i && npm run dev` → http://localhost:8788 (parol: `sinov123`).
