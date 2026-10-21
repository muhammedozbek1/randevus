/* ==========================================================================
   Beyaz Kuaför — Ortak Veri Katmanı
   --------------------------------------------------------------------------
   Tüm sayfalar (yönetim paneli, randevu formu, index) bu dosyayı kullanır.

   • Değerler bellekte tutulur, yazılanlar sunucuya (PUT /api/data/<key>)
     anında gönderilir — böylece veri her cihazdan aynı görünür.
   • Sunucu erişilemezse localStorage'a düşer (çevrimdışı / statik barındırma).
   • Başka cihazda yapılan değişiklikler 10 sn'de bir çekilir (polling).
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------
     API kökü
     ------------------------------------------------------------------
     Uygulama bir alt klasöre monte edilmişse (örn. Hostinger Passenger:
     https://site.com/nodeapp/store.js) API adresleri de o öneki içermeli.
     store.js'in kendi konumundan önek otomatik olarak bulunur; domain
     kökünde çalışıyorsa sonuç "/api" olur (değişiklik yok).
     ------------------------------------------------------------------ */
  const API_BASE = (() => {
    try {
      const src = document.currentScript && document.currentScript.src;
      if (src) {
        const dir = new URL(src).pathname.replace(/\/[^/]*$/, '');
        if (dir && dir !== '/') return dir + '/api';
      }
    } catch { /* yoksay */ }
    return '/api';
  })();
  window.BB_API_BASE = API_BASE;

  const API = API_BASE;
  const SYNC_INTERVAL = 10000;   // dış değişiklik çekme aralığı (ms)
  const PUSH_DEBOUNCE = 300;     // yazma gecikmesi (ms)

  /* ------------------------------------------------------------------
     Site kimliği — ?site=... > <meta name="site-id"> > varsayılan
     Not: Oturum açıldığında sunucudaki site kimliği esas alınır; yerel
     önbellek de site'e göre ayrılır, böylece siteler birbirine karışmaz.
  ------------------------------------------------------------------ */
  const params = new URLSearchParams(location.search);
  const metaTag = document.querySelector('meta[name="site-id"]');
  let siteId = params.get('site') || (metaTag && metaTag.content) || 'beyaz';

  const memory = new Map();          // key -> string
  const pending = new Map();         // key -> string (sunucuya gönderilecek)
  const listeners = new Set();

  let pushTimer = null;
  let syncTimer = null;
  let online = false;                // sunucuya ulaşılabiliyor mu
  let authed = false;                // oturum açık mı
  let site = null;                   // { id, name, ... }
  let user = null;                   // { username, name, role }

  /* ------------------------------------------------------------------
     Yardımcılar
  ------------------------------------------------------------------ */
  const safeLocal = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* kota dolu */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* yoksay */ } }
  };

  /** Yerel önbellek anahtarı — site'e göre ayrılır. */
  const cacheKey = (key) => `bb_${siteId}_${key}`;

  /** Site değişirse bellek temizlenir (önbellek anahtarları zaten ayrı). */
  function setSite(id) {
    if (!id || id === siteId) return;
    siteId = id;
    memory.clear();
  }

  async function apiFetch(path, options = {}) {
    const opts = {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', ...(options.headers || {}) },
      ...options
    };
    if (opts.body !== undefined && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(API + path, opts);
    let payload = null;
    try { payload = await res.json(); } catch { /* boş gövde */ }
    return { status: res.status, ok: res.ok, data: payload };
  }

  /* ------------------------------------------------------------------
     Ham (string) okuma / yazma
  ------------------------------------------------------------------ */
  function getRaw(key) {
    if (memory.has(key)) return memory.get(key);
    const v = safeLocal.get(cacheKey(key));
    memory.set(key, v);
    return v;
  }

  function setRaw(key, value) {
    const str = value === null || value === undefined ? '' : String(value);
    memory.set(key, str);
    safeLocal.set(cacheKey(key), str);
    if (authed) {
      pending.set(key, str);
      schedulePush();
    }
    return str;
  }

  function removeKey(key) {
    memory.delete(key);
    safeLocal.remove(cacheKey(key));
    if (authed) {
      pending.set(key, '');
      schedulePush();
    }
  }

  function getJSON(key, fallback) {
    try {
      const parsed = JSON.parse(getRaw(key) || 'null');
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function setJSON(key, value) {
    return setRaw(key, JSON.stringify(value));
  }

  /* ------------------------------------------------------------------
     Sunucuya yazma (debounce + sıralı)
  ------------------------------------------------------------------ */
  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      flushPush();
    }, PUSH_DEBOUNCE);
  }

  async function flushPush() {
    if (!pending.size || !authed) return;
    const batch = Array.from(pending.entries());
    pending.clear();
    for (const [key, value] of batch) {
      try {
        const res = await apiFetch('/data/' + encodeURIComponent(key), {
          method: 'PUT',
          body: { value }
        });
        if (res.status === 401) { pending.set(key, value); authed = false; break; }
      } catch {
        /* bağlantı yoksa değer localStorage'da kalır, sonraki denemede tekrar gönderilir */
        pending.set(key, value);
        online = false;
        break;
      }
    }
  }

  /* ------------------------------------------------------------------
     Sunucudan çekme — dış cihazlardaki değişiklikleri uygula
  ------------------------------------------------------------------ */
  async function pull() {
    if (!authed) return;
    let res;
    try {
      res = await apiFetch('/data');
    } catch {
      online = false;
      return;
    }
    online = true;
    if (!res.ok) {
      if (res.status === 401) authed = false;
      return;
    }
    const remote = (res.data && res.data.data) || {};
    const changed = [];
    Object.keys(remote).forEach((key) => {
      /* Yerelde sunucuya gönderilmeyi bekleyen bir değer varsa onu ezme */
      if (pending.has(key)) return;
      if (memory.get(key) !== remote[key]) {
        memory.set(key, remote[key]);
        safeLocal.set(cacheKey(key), remote[key]);
        changed.push(key);
      }
    });
    if (changed.length) notify(changed);
  }

  function notify(keys) {
    listeners.forEach((cb) => {
      try { cb(keys); } catch (err) { console.warn('[store] dinleyici hatası', err); }
    });
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  /* ------------------------------------------------------------------
     Kimlik doğrulama
  ------------------------------------------------------------------ */
  async function login(siteName, username, password) {
    let res;
    try {
      res = await apiFetch('/login', {
        method: 'POST',
        body: { site: siteName, username, password }
      });
    } catch {
      const err = new Error('Sunucuya ulaşılamıyor. Proje klasöründe "node server.js" komutunu çalıştırıp tekrar deneyin.');
      err.status = 0;
      throw err;
    }
    if (!res.ok) {
      const err = new Error((res.data && res.data.error) || 'Giriş yapılamadı.');
      err.status = res.status;
      throw err;
    }
    site = res.data.site;
    user = res.data.user;
    setSite(site.id);
    authed = true;
    online = true;
    await pull();
    startSync();
    return { site, user };
  }

  async function logout() {
    try { await apiFetch('/logout', { method: 'POST' }); } catch { /* çevrimdışı */ }
    authed = false;
    site = null;
    user = null;
    stopSync();
  }

  async function me() {
    const res = await apiFetch('/me');
    if (res.ok && res.data) {
      site = res.data.site;
      user = res.data.user;
      setSite(site.id);
      authed = true;
      online = true;
      return { site, user };
    }
    authed = false;
    return null;
  }

  function loginUrl() {
    const next = encodeURIComponent(location.pathname + location.search);
    return `login.html?site=${encodeURIComponent(siteId)}&next=${next}`;
  }

  function redirectToLogin() {
    if (/login\.html$/i.test(location.pathname)) return;
    location.replace(loginUrl());
  }

  /**
   * Yönetim paneli koruması.
   * @returns {Promise<boolean>} true → devam et, false → giriş sayfasına yönlendirildi
   */
  let authPromise = null;
  function requireAuth() {
    if (!authPromise) authPromise = doRequireAuth();
    return authPromise;
  }

  async function doRequireAuth() {
    try {
      const res = await apiFetch('/me');
      if (res.ok && res.data) {
        site = res.data.site;
        user = res.data.user;
        setSite(site.id);          // sunucudaki site kimliği esas alınır
        authed = true;
        online = true;
        await pull();
        startSync();
        return true;
      }
      if (res.status === 401) {
        authed = false;
        redirectToLogin();
        return false;
      }
    } catch {
      /* Sunucuya ulaşılamıyor → çevrimdışı çalışma (yalnızca bu tarayıcı) */
      online = false;
      return true;
    }
    authed = false;
    redirectToLogin();
    return false;
  }

  /* ------------------------------------------------------------------
     Otomatik senkron
  ------------------------------------------------------------------ */
  function startSync() {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
      if (document.visibilityState === 'visible') pull();
    }, SYNC_INTERVAL);
  }

  function stopSync() {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && authed) pull();
  });

  window.addEventListener('beforeunload', () => {
    if (pending.size) {
      const payload = JSON.stringify({ values: Object.fromEntries(pending) });
      try {
        navigator.sendBeacon?.(`${API}/data/batch`, new Blob([payload], { type: 'application/json' }));
      } catch { /* yok sayılır */ }
    }
  });

  /* ------------------------------------------------------------------
     Genel randevu işlemleri (herkese açık)
  ------------------------------------------------------------------ */
  const apptKey = 'beyaz_kuafor_randevular';

  const appts = {
    /** Belirli günün dolu saatleri (kişisel bilgi içermez). */
    async takenTimes(date) {
      try {
        const res = await apiFetch('/appointments?site=' + encodeURIComponent(siteId) + '&date=' + encodeURIComponent(date));
        if (res.ok && res.data) return res.data.times || [];
      } catch { /* çevrimdışı */ }
      return getJSON(apptKey, [])
        .filter((a) => a.date === date && a.status !== 'cancelled')
        .map((a) => a.time);
    },

    /** Yeni randevu oluştur. */
    async create(appt) {
      const res = await apiFetch('/appointments', {
        method: 'POST',
        body: { site: siteId, ...appt }
      });
      if (!res.ok) {
        const err = new Error((res.data && res.data.error) || 'Randevu oluşturulamadı.');
        err.status = res.status;
        throw err;
      }
      // Yerel önbelleği de güncelle
      const list = getJSON(apptKey, []);
      list.push(res.data.appointment);
      setJSON(apptKey, list);
      return res.data.appointment;
    },

    /** Randevu iptal. */
    async cancel(id, phone) {
      const res = await apiFetch('/appointments/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: { site: siteId, phone: phone || '' }
      });
      if (!res.ok) {
        const err = new Error((res.data && res.data.error) || 'Randevu iptal edilemedi.');
        err.status = res.status;
        throw err;
      }
      const list = getJSON(apptKey, []).map((a) => (a.id === id ? { ...a, status: 'cancelled' } : a));
      setJSON(apptKey, list);
      return true;
    },

    /** Telefon numarasına göre randevular. */
    async byPhone(phone) {
      try {
        const res = await apiFetch('/appointments?site=' + encodeURIComponent(siteId) + '&phone=' + encodeURIComponent(phone));
        if (res.ok && res.data) {
          setJSON(apptKey, res.data.appointments || []);
          return res.data.appointments || [];
        }
      } catch { /* çevrimdışı */ }
      const needle = String(phone).replace(/\D/g, '');
      return getJSON(apptKey, []).filter((a) => String(a.phone || '').replace(/\D/g, '').includes(needle));
    }
  };

  /* ------------------------------------------------------------------
     PIN (Mali İşlemler kilidi)
  ------------------------------------------------------------------ */
  const pin = {
    /** PIN tanımlı mı / varsayılan mı. */
    async status() {
      try {
        const res = await apiFetch('/pin');
        return res.ok ? res.data : { set: true, isDefault: true };
      } catch {
        return { set: true, isDefault: true };
      }
    },

    /** PIN doğrula. */
    async verify(code) {
      const res = await apiFetch('/pin/verify', {
        method: 'POST',
        body: { pin: String(code || '') }
      });
      if (!res.ok) {
        const err = new Error((res.data && res.data.error) || 'PIN doğrulanamadı.');
        err.status = res.status;
        throw err;
      }
      return true;
    },

    /** Yeni PIN belirle. */
    async set(code) {
      const res = await apiFetch('/pin', {
        method: 'PUT',
        body: { pin: String(code || '') }
      });
      if (!res.ok) {
        const err = new Error((res.data && res.data.error) || 'PIN kaydedilemedi.');
        err.status = res.status;
        throw err;
      }
      return true;
    }
  };

  /* ------------------------------------------------------------------
     Dışa aç
  ------------------------------------------------------------------ */
  const ready = Promise.resolve();

  window.BerberStore = {
    siteId,
    get site() { return site; },
    get user() { return user; },
    get authed() { return authed; },
    get online() { return online; },
    ready,
    getRaw, setRaw, removeKey, getJSON, setJSON,
    onChange, pull, flushPush,
    login, logout, me, requireAuth, loginUrl,
    pin,
    appts
  };

  // Sayfa yüklenirken sunucudaki site bilgisini çek (index sayfası özelleştirme)
  window.BerberStore.loadSiteInfo = async function loadSiteInfo() {
    try {
      const res = await apiFetch('/site/' + encodeURIComponent(siteId));
      if (res.ok && res.data) {
        site = res.data.site;
        return site;
      }
    } catch { /* çevrimdışı */ }
    return null;
  };
})();
