/* ==========================================================================
   Beyaz Kuaför — Giriş Sayfası Script
   ========================================================================== */
(() => {
  'use strict';

  const store = window.BerberStore;
  const form = document.getElementById('lgForm');
  const siteSel = document.getElementById('lgSite');
  const userInp = document.getElementById('lgUser');
  const passInp = document.getElementById('lgPass');
  const errEl = document.getElementById('lgError');
  const submitBtn = document.getElementById('lgSubmit');
  const toggleBtn = document.getElementById('lgToggle');
  const siteNameEl = document.getElementById('lgSiteName');
  const markEl = document.getElementById('lgMark');
  const backLink = document.getElementById('lgBack');

  const params = new URLSearchParams(location.search);
  const wantedSite = params.get('site') || store.siteId || 'beyaz';
  const next = params.get('next') || 'admin.html';

  let sites = [];

  /* ------------------------------------------------------------------
     Yardımcılar
  ------------------------------------------------------------------ */
  const showError = (msg) => { errEl.textContent = msg || ''; };
  const setLoading = (on) => {
    submitBtn.disabled = on;
    submitBtn.classList.toggle('is-loading', on);
    submitBtn.querySelector('.lg-submit__text').textContent = on ? 'Giriş yapılıyor…' : 'Giriş Yap';
  };

  /* ------------------------------------------------------------------
     Site listesi
  ------------------------------------------------------------------ */
  async function loadSites() {
    try {
      const res = await fetch((window.BB_API_BASE || '/api') + '/sites', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        sites = data.sites || [];
      } else {
        throw new Error('Sunucu yanıt vermedi');
      }
    } catch {
      sites = [];
      showError('Sunucuya ulaşılamıyor. Proje klasöründe "node server.js" komutunu çalıştırın.');
    }

    if (!sites.length) sites = [{ id: wantedSite, name: wantedSite }];

    siteSel.innerHTML = '';
    sites.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === wantedSite) opt.selected = true;
      siteSel.appendChild(opt);
    });

    // Sadece tek site varsa seçimi gizle
    if (sites.length <= 1) {
      siteSel.closest('.lg-field').style.display = 'none';
      siteSel.value = sites[0].id;
    }

    applySiteMeta(sites.find((s) => s.id === siteSel.value) || sites[0]);
  }

  function applySiteMeta(site) {
    if (!site) return;
    siteNameEl.textContent = site.name || 'Beyaz Kuaför';
    markEl.textContent = (site.name || 'B').trim().charAt(0).toUpperCase();
    if (site.indexPath) backLink.href = site.indexPath;
  }

  siteSel.addEventListener('change', () => {
    const site = sites.find((s) => s.id === siteSel.value);
    applySiteMeta(site);
    store.loadSiteInfo?.().then((info) => { if (info) applySiteMeta(info); });
  });

  /* ------------------------------------------------------------------
     Şifre göster / gizle
  ------------------------------------------------------------------ */
  toggleBtn.addEventListener('click', () => {
    const show = passInp.type === 'password';
    passInp.type = show ? 'text' : 'password';
    toggleBtn.setAttribute('aria-label', show ? 'Şifreyi gizle' : 'Şifreyi göster');
    passInp.focus();
  });

  /* ------------------------------------------------------------------
     Giriş
  ------------------------------------------------------------------ */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');

    const username = userInp.value.trim();
    const password = passInp.value;
    const site = siteSel.value || wantedSite;

    if (!username) { showError('Kullanıcı adını girin.'); userInp.focus(); return; }
    if (!password) { showError('Şifrenizi girin.'); passInp.focus(); return; }

    setLoading(true);
    try {
      await store.login(site, username, password);
      const target = next && next !== 'admin.html'
        ? next
        : `admin.html?site=${encodeURIComponent(site)}`;
      location.href = target;
    } catch (err) {
      setLoading(false);
      showError(err.message || 'Giriş yapılamadı.');
      passInp.select();
    }
  });

  /* ------------------------------------------------------------------
     Başlangıç
  ------------------------------------------------------------------ */
  loadSites();

  // Zaten giriş yapılmışsa doğrudan panele
  store.me().then((info) => {
    if (info) {
      location.replace(next && next !== 'admin.html' ? next : `admin.html?site=${encodeURIComponent(info.site.id)}`);
    }
  }).catch(() => {});
})();
