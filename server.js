/* ==========================================================================
   Beyaz Kuaför — Sunucu
   --------------------------------------------------------------------------
   Statik dosyaları sunar + JSON API sağlar. Harici paket yok (sadece Node.js
   yerleşik modülleri). Veriler `data/db.json` içinde, site başına ayrı tablolar
   hâlinde saklanır.

   Çalıştırma:
     node server.js          → http://localhost:8000
     PORT=3000 node server.js
   ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------
   Ayarlar
------------------------------------------------------------------ */
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 gün
const DEFAULT_USER = process.env.DEFAULT_USER || 'admin';
const DEFAULT_PASS = process.env.DEFAULT_PASS || 'beyaz2026';
const DEFAULT_PIN = process.env.DEFAULT_PIN || '1234';
const APPOINTMENTS_KEY = 'beyaz_kuafor_randevular';

/* ------------------------------------------------------------------
   Montaj öneki
   ------------------------------------------------------------------
   Uygulama bir alt klasöre monte edildiğinde (örn. Hostinger Passenger:
   public_html/nodeapp) istek yolları "/nodeapp/..." şeklinde gelir.
   Bu durumda önek sunucu tarafında kaldırılır, istemci tarafında ise
   store.js kendi konumundan otomatik olarak bulur (bkz. BB_API_BASE).
   Normalde (domain kökünde) boştur — mevcut davranış değişmez.
   ------------------------------------------------------------------ */
const MOUNT = (() => {
  const explicit = String(process.env.APP_BASE_PATH || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit.startsWith('/') ? explicit : '/' + explicit;
  const docRoot = process.env.DOCUMENT_ROOT;
  if (docRoot) {
    try {
      const rel = path.relative(path.resolve(docRoot), ROOT).split(path.sep).join('/');
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return '/' + rel;
    } catch { /* yoksay */ }
  }
  return '';
})();

/* ------------------------------------------------------------------
   Veritabanı (JSON dosya — atomik yazım)
------------------------------------------------------------------ */
function emptyDb() {
  return { version: 1, sites: {}, sessions: {} };
}

function loadDb() {
  try {
    let raw = fs.readFileSync(DB_FILE, 'utf8');
    raw = raw.replace(/^\uFEFF/, '');           // UTF-8 BOM toleransı
    const parsed = JSON.parse(raw);
    parsed.sites = parsed.sites || {};
    parsed.sessions = parsed.sessions || {};
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      /* Bozuk dosya: silme, yedekle ve uyar */
      const broken = DB_FILE + '.broken-' + Date.now();
      try { fs.copyFileSync(DB_FILE, broken); } catch { /* yoksay */ }
      console.error('[db] dosya okunamadı, bozuk kopyayı sakladım:', broken);
      console.error('[db] ' + err.message);
    }
    return emptyDb();
  }
}

/** Sunucu başlarken mevcut verinin yedeğini alır (koruma amaçlı). */
function backupDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    fs.copyFileSync(DB_FILE, DB_FILE + '.backup');
  } catch (err) {
    console.warn('[db] yedek alınamadı:', err.message);
  }
}

let db = loadDb();
let saveTimer = null;

function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error('[db] kaydedilemedi:', err.message);
    }
  }, 40);
  if (saveTimer.unref) saveTimer.unref();
}

/* ------------------------------------------------------------------
   Şifreleme
------------------------------------------------------------------ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function uid(prefix) {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/* ------------------------------------------------------------------
   Siteler
------------------------------------------------------------------ */
function publicSiteMeta(site) {
  return {
    id: site.id,
    name: site.name,
    tagline: site.meta.tagline || '',
    phone: site.meta.phone || '',
    phoneDisplay: site.meta.phoneDisplay || '',
    address: site.meta.address || '',
    whatsapp: site.meta.whatsapp || '',
    heroBadge: site.meta.heroBadge || '',
    heroSub: site.meta.heroSub || '',
    hours: site.meta.hours || '',
    theme: site.meta.theme || {},
    indexPath: site.indexPath || 'index.html',
    createdAt: site.createdAt
  };
}

function ensureSite(cfg) {
  const id = String(cfg.id || '').trim();
  if (!id) return null;
  let site = db.sites[id];
  if (!site) {
    site = db.sites[id] = {
      id,
      name: cfg.name || id,
      meta: { ...(cfg.meta || {}) },
      users: [],
      data: {},
      createdAt: new Date().toISOString()
    };
    console.log(`[site] yeni site oluşturuldu: ${id}`);
  } else {
    if (cfg.name) site.name = cfg.name;
    site.meta = { ...site.meta, ...(cfg.meta || {}) };
  }
  if (!site.users.length) {
    site.users.push({
      id: uid('U'),
      username: DEFAULT_USER,
      passHash: hashPassword(DEFAULT_PASS),
      name: 'Yönetici',
      role: 'owner',
      createdAt: new Date().toISOString()
    });
    console.log(`[site] "${id}" için varsayılan kullanıcı: ${DEFAULT_USER} / ${DEFAULT_PASS}`);
  }
  if (!site.data || typeof site.data !== 'object') site.data = {};
  /* Mali İşlemler ekranı PIN ile korunur */
  if (!site.pin) {
    site.pin = { hash: hashPassword(DEFAULT_PIN), len: DEFAULT_PIN.length, updatedAt: new Date().toISOString(), isDefault: true };
    console.log(`[site] "${id}" için varsayılan PIN: ${DEFAULT_PIN}`);
  }
  return site;
}

/** Proje kökündeki site tanım dosyalarını tara (kök + sites/<id>/). */
function discoverSites() {
  const found = [];
  const candidates = [path.join(ROOT, 'site.json')];
  const sitesDir = path.join(ROOT, 'sites');
  try {
    fs.readdirSync(sitesDir, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory()) candidates.push(path.join(sitesDir, entry.name, 'site.json'));
    });
  } catch { /* sites/ yok */ }

  candidates.forEach((file) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const site = ensureSite(cfg);
      if (site) {
        /* Site index sayfasının yolu (yönetim panelindeki "Siteyi Aç" bağlantısı) */
        const rel = path.relative(ROOT, path.dirname(file)).split(path.sep).join('/');
        site.indexPath = rel ? `${rel}/index.html` : 'index.html';
        found.push(site);
      }
    } catch (err) {
      console.warn(`[site] okunamadı: ${file} (${err.message})`);
    }
  });
  return found;
}

/* ------------------------------------------------------------------
   Oturum
------------------------------------------------------------------ */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function getSession(req) {
  const token = parseCookies(req).bb_session || bearerToken(req);
  if (!token) return null;
  const sess = db.sessions[token];
  if (!sess) return null;
  if (sess.exp < Date.now()) {
    delete db.sessions[token];
    saveDb();
    return null;
  }
  const site = db.sites[sess.site];
  if (!site) return null;
  const user = site.users.find((u) => u.username === sess.username);
  if (!user) return null;
  return { token, site, user };
}

function createSession(siteId, username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { site: siteId, username, exp: Date.now() + SESSION_TTL_MS };
  saveDb();
  return token;
}

function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `bb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/* ------------------------------------------------------------------
   HTTP yardımcıları
------------------------------------------------------------------ */
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Gövde çok büyük'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Geçersiz JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8'
};

const BLOCKED_PREFIXES = ['/data/', '/.git/', '/node_modules/'];

function serveStatic(req, res, pathname) {
  let rel = pathname;
  try { rel = decodeURIComponent(pathname); } catch { /* bozuk kodlama */ }

  if (BLOCKED_PREFIXES.some((p) => rel.startsWith(p))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }

  if (rel.endsWith('/')) rel += 'index.html';
  const target = path.normalize(path.join(ROOT, rel));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403');
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><p>Sayfa bulunamadı.</p>');
    }
    const ext = path.extname(target).toLowerCase();
    /* Uygulama dosyaları (html/css/js/json) asla cache'lenmez — güncellemeler
       sayfa yenilendiğinde anında görülür. Görseller/fontlar cache'lenebilir. */
    const cacheable = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-store, must-revalidate'
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------------------------------------------
   Basit hız sınırlayıcı (IP başına)
------------------------------------------------------------------ */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    buckets.set(key, list);
    return false;
  }
  list.push(now);
  buckets.set(key, list);
  if (buckets.size > 5000) buckets.clear();
  return true;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------------
   Randevu yardımcıları
------------------------------------------------------------------ */
function readAppointments(site) {
  try {
    const list = JSON.parse(site.data[APPOINTMENTS_KEY] || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeAppointments(site, list) {
  site.data[APPOINTMENTS_KEY] = JSON.stringify(list);
  saveDb();
}

/* ------------------------------------------------------------------
   API yönlendirici
------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  /* ---------- Site listesi (herkese açık) ---------- */
  if (pathname === '/api/sites' && method === 'GET') {
    const sites = Object.values(db.sites).map((s) => ({
      id: s.id,
      name: s.name,
      indexPath: s.indexPath || 'index.html'
    }));
    return sendJson(res, 200, { sites });
  }

  /* ---------- Site bilgisi (herkese açık) ---------- */
  if (pathname.startsWith('/api/site/') && method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/api/site/'.length));
    const site = db.sites[id];
    if (!site) return sendJson(res, 404, { error: 'Site bulunamadı' });
    return sendJson(res, 200, { site: publicSiteMeta(site) });
  }

  /* ---------- Giriş ---------- */
  if (pathname === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    if (!rateLimit(`login:${ip}`, 20, 60 * 60 * 1000)) {
      return sendJson(res, 429, { error: 'Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.' });
    }
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }

    const siteId = String(body.site || '').trim();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    const site = db.sites[siteId];
    if (!site) return sendJson(res, 401, { error: 'Site bulunamadı.' });

    const user = site.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !verifyPassword(password, user.passHash)) {
      return sendJson(res, 401, { error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    const token = createSession(site.id, user.username);
    return sendJson(res, 200, {
      ok: true,
      token,
      site: publicSiteMeta(site),
      user: { username: user.username, name: user.name, role: user.role }
    }, { 'Set-Cookie': sessionCookie(token) });
  }

  /* ---------- Çıkış ---------- */
  if (pathname === '/api/logout' && method === 'POST') {
    const sess = getSession(req);
    if (sess) {
      delete db.sessions[sess.token];
      saveDb();
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'bb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }

  /* ---------- Oturum bilgisi ---------- */
  if (pathname === '/api/me' && method === 'GET') {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });
    return sendJson(res, 200, {
      site: publicSiteMeta(sess.site),
      user: { username: sess.user.username, name: sess.user.name, role: sess.user.role }
    });
  }

  /* ---------- Kullanıcı yönetimi ---------- */
  if (pathname === '/api/users') {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });

    if (method === 'GET') {
      return sendJson(res, 200, {
        users: sess.site.users.map((u) => ({
          username: u.username, name: u.name, role: u.role, createdAt: u.createdAt
        }))
      });
    }

    if (method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        return sendJson(res, 400, { error: 'Kullanıcı adı 3-32 karakter olmalı (harf, rakam, . _ -).' });
      }
      if (password.length < 4) {
        return sendJson(res, 400, { error: 'Şifre en az 4 karakter olmalı.' });
      }
      if (sess.site.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        return sendJson(res, 409, { error: 'Bu kullanıcı adı zaten kullanılıyor.' });
      }
      const role = String(body.role || 'usta');
      if (!['owner', 'usta'].includes(role)) {
        return sendJson(res, 400, { error: 'Geçersiz rol. "owner" veya "usta" olmalı.' });
      }
      const user = {
        id: uid('U'),
        username,
        passHash: hashPassword(password),
        name: String(body.name || username).slice(0, 60),
        role,
        createdAt: new Date().toISOString()
      };
      sess.site.users.push(user);
      saveDb();
      return sendJson(res, 201, { ok: true, user: { username: user.username, name: user.name, role: user.role } });
    }

    if (method === 'DELETE') {
      const target = decodeURIComponent((url.searchParams.get('username') || '').trim());
      const user = sess.site.users.find((u) => u.username === target);
      if (!user) return sendJson(res, 404, { error: 'Kullanıcı bulunamadı.' });
      if (user.username === sess.user.username) {
        return sendJson(res, 400, { error: 'Kendi hesabınızı silemezsiniz.' });
      }
      if (sess.site.users.length <= 1) {
        return sendJson(res, 400, { error: 'Son kullanıcı silinemez.' });
      }
      sess.site.users = sess.site.users.filter((u) => u.username !== target);
      Object.keys(db.sessions).forEach((token) => {
        if (db.sessions[token].site === sess.site.id && db.sessions[token].username === target) {
          delete db.sessions[token];
        }
      });
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ---------- Şifre değiştirme ---------- */
  if (pathname === '/api/password' && method === 'POST') {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const current = String(body.current || '');
    const next = String(body.next || '');
    if (!verifyPassword(current, sess.user.passHash)) {
      return sendJson(res, 400, { error: 'Mevcut şifre hatalı.' });
    }
    if (next.length < 4) return sendJson(res, 400, { error: 'Yeni şifre en az 4 karakter olmalı.' });
    sess.user.passHash = hashPassword(next);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* ---------- Site bilgisi güncelleme ---------- */
  if (pathname === '/api/site' && method === 'PUT') {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const meta = body.meta || {};
    const clean = {};
    ['tagline', 'phone', 'phoneDisplay', 'address', 'whatsapp', 'heroBadge', 'heroSub', 'hours'].forEach((k) => {
      if (typeof meta[k] === 'string') clean[k] = meta[k].slice(0, 300);
    });
    if (meta.theme && typeof meta.theme === 'object') {
      clean.theme = {
        accent: String(meta.theme.accent || '').slice(0, 20),
        accentDark: String(meta.theme.accentDark || '').slice(0, 20)
      };
    }
    sess.site.meta = { ...sess.site.meta, ...clean };
    if (typeof body.name === 'string' && body.name.trim()) sess.site.name = body.name.trim().slice(0, 80);
    saveDb();
    return sendJson(res, 200, { ok: true, site: publicSiteMeta(sess.site) });
  }

  /* ---------- Toplu yazma (sayfa kapanırken) ---------- */
  if (pathname === '/api/data/batch' && (method === 'PUT' || method === 'POST')) {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const values = (body && body.values) || {};
    let count = 0;
    Object.keys(values).forEach((key) => {
      if (!key || key.includes('/')) return;
      const v = values[key];
      sess.site.data[key] = typeof v === 'string' ? v : JSON.stringify(v);
      count++;
    });
    saveDb();
    return sendJson(res, 200, { ok: true, count });
  }

  /* ---------- PIN (Mali İşlemler kilidi) ---------- */
  if (pathname === '/api/pin') {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });

    if (method === 'GET') {
      return sendJson(res, 200, {
        set: !!sess.site.pin,
        isDefault: !!(sess.site.pin && sess.site.pin.isDefault),
        length: sess.site.pin ? (sess.site.pin.len || 4) : 4,
        updatedAt: sess.site.pin ? sess.site.pin.updatedAt : null
      });
    }

    if (method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const pin = String(body.pin || '').trim();
      if (!/^\d{4,6}$/.test(pin)) {
        return sendJson(res, 400, { error: 'PIN 4-6 rakamdan oluşmalı.' });
      }
      sess.site.pin = { hash: hashPassword(pin), len: pin.length, updatedAt: new Date().toISOString(), isDefault: false };
      saveDb();
      return sendJson(res, 200, { ok: true, length: pin.length, updatedAt: sess.site.pin.updatedAt });
    }
  }

  if (pathname === '/api/pin/verify' && method === 'POST') {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });
    const ip = clientIp(req);
    const key = `pin:${sess.site.id}:${sess.user.username}:${ip}`;
    if (!rateLimit(key, 8, 5 * 60 * 1000)) {
      return sendJson(res, 429, { error: 'Çok fazla hatalı deneme. Birkaç dakika sonra tekrar deneyin.' });
    }
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const pin = String(body.pin || '').trim();
    if (!sess.site.pin) {
      sess.site.pin = { hash: hashPassword(DEFAULT_PIN), len: DEFAULT_PIN.length, updatedAt: new Date().toISOString(), isDefault: true };
      saveDb();
    }
    if (!/^\d{4,6}$/.test(pin) || !verifyPassword(pin, sess.site.pin.hash)) {
      return sendJson(res, 401, { error: 'Yanlış PIN.' });
    }
    return sendJson(res, 200, { ok: true });
  }

  /* ---------- Veri tablosu ---------- */
  if (pathname === '/api/data' && method === 'GET') {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });
    return sendJson(res, 200, { data: sess.site.data });
  }

  if (pathname.startsWith('/api/data/') && (method === 'PUT' || method === 'POST')) {
    const sess = getSession(req);
    if (!sess) return sendJson(res, 401, { error: 'Oturum yok' });
    const key = decodeURIComponent(pathname.slice('/api/data/'.length));
    if (!key || key.includes('/')) return sendJson(res, 400, { error: 'Geçersiz anahtar' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
    sess.site.data[key] = value;
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* ---------- Randevular (herkese açık) ---------- */
  if (pathname === '/api/appointments') {
    const method = req.method;

    if (method === 'POST') {
      const ip = clientIp(req);
      if (!rateLimit(`appt:${ip}`, 20, 60 * 60 * 1000)) {
        return sendJson(res, 429, { error: 'Çok fazla randevu isteği. Lütfen daha sonra tekrar deneyin.' });
      }
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }

      const siteId = String(body.site || url.searchParams.get('site') || '').trim();
      const site = db.sites[siteId];
      if (!site) return sendJson(res, 404, { error: 'Site bulunamadı.' });

      const name = String(body.name || '').trim().slice(0, 80);
      const phone = String(body.phone || '').trim().slice(0, 30);
      const service = String(body.service || '').trim().slice(0, 80);
      const date = String(body.date || '').trim();
      const time = String(body.time || '').trim();
      const note = String(body.note || '').trim().slice(0, 300);

      if (!name) return sendJson(res, 400, { error: 'Ad soyad zorunludur.' });
      if (phone.replace(/\D/g, '').length < 10) return sendJson(res, 400, { error: 'Geçerli bir telefon numarası girin.' });
      if (!service) return sendJson(res, 400, { error: 'Hizmet seçilmedi.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Geçersiz tarih.' });
      if (!/^\d{2}:\d{2}$/.test(time)) return sendJson(res, 400, { error: 'Geçersiz saat.' });

      const list = readAppointments(site);
      const taken = list.some((a) => a.date === date && a.time === time && a.status !== 'cancelled');
      if (taken) {
        return sendJson(res, 409, { error: 'Bu saat az önce doldu. Lütfen başka bir saat seçin.' });
      }

      const appt = {
        id: 'A' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 900 + 100),
        service, date, time, name, phone, note,
        status: 'confirmed',
        createdAt: new Date().toISOString()
      };
      list.push(appt);
      writeAppointments(site, list);
      return sendJson(res, 201, { appointment: appt });
    }

    const siteId = String(url.searchParams.get('site') || '').trim();
    const site = db.sites[siteId];
    if (!site) return sendJson(res, 404, { error: 'Site bulunamadı.' });

    if (method === 'GET') {
      const date = url.searchParams.get('date');
      const phone = url.searchParams.get('phone');
      const list = readAppointments(site);

      if (date) {
        const times = list
          .filter((a) => a.date === date && a.status !== 'cancelled')
          .map((a) => a.time)
          .filter(Boolean);
        return sendJson(res, 200, { times });
      }

      if (phone) {
        const needle = String(phone).replace(/\D/g, '');
        const mine = list.filter((a) => String(a.phone || '').replace(/\D/g, '').includes(needle));
        return sendJson(res, 200, { appointments: mine });
      }

      return sendJson(res, 400, { error: 'date veya phone parametresi gerekli' });
    }
  }

  /* ---------- Randevu iptali ---------- */
  if (pathname.startsWith('/api/appointments/') && method === 'PATCH') {
    const id = decodeURIComponent(pathname.slice('/api/appointments/'.length));
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const siteId = String(body.site || url.searchParams.get('site') || '').trim();
    const site = db.sites[siteId];
    if (!site) return sendJson(res, 404, { error: 'Site bulunamadı.' });
    const list = readAppointments(site);
    const appt = list.find((a) => a.id === id);
    if (!appt) return sendJson(res, 404, { error: 'Randevu bulunamadı.' });
    if (body.phone && String(appt.phone).replace(/\D/g, '') !== String(body.phone).replace(/\D/g, '')) {
      return sendJson(res, 403, { error: 'Randevu bu telefon numarasına ait değil.' });
    }
    appt.status = 'cancelled';
    writeAppointments(site, list);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Bilinmeyen uç nokta' });
}

/* ------------------------------------------------------------------
   Sunucu
------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  /* Alt klasöre monte edildiyse öneki kaldır (örn. /nodeapp/api/... → /api/...) */
  if (MOUNT && url.pathname.startsWith(MOUNT)) {
    const rest = url.pathname.slice(MOUNT.length);
    url.pathname = rest.startsWith('/') ? rest : (rest ? '/' + rest : '/');
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error('[api]', err);
      sendJson(res, 500, { error: 'Sunucu hatası' });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('405');
  }

  serveStatic(req, res, url.pathname);
});

discoverSites();
backupDb();
saveDb();

server.listen(PORT, HOST, () => {
  const sites = Object.values(db.sites).map((s) => `${s.id} (${s.name})`).join(', ');
  console.log('──────────────────────────────────────────────');
  console.log(`  Beyaz Kuaför sunucusu çalışıyor: http://localhost:${PORT}`);
  console.log(`  Siteler: ${sites || '(yok — site.json ekleyin)'}`);
  console.log(`  Veri dosyası: ${DB_FILE}`);
  console.log('──────────────────────────────────────────────');
});
