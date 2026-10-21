/* ==========================================================================
   Beyaz Kuaför — Panel: Oturum, Kullanıcılar ve Site Bilgileri
   --------------------------------------------------------------------------
   Yönetim panelinin görünümünü değiştirmez; yalnızca:
     • kim giriş yapmış gösterir / çıkış yapar,
     • panel kullanıcılarını yönetir (kullanıcı adı + şifre),
     • index sitesinin görünen bilgilerini günceller.
   ========================================================================== */
(() => {
  'use strict';

  const store = window.BerberStore;
  if (!store) return;

  const $ = (sel, root = document) => root.querySelector(sel);

  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', headers: { 'Accept': 'application/json' }, ...options };
    if (opts.body !== undefined && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch((window.BB_API_BASE || '/api') + path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* boş gövde */ }
    return { status: res.status, ok: res.ok, data };
  }

  const toast = (msg, kind = 'ok') => {
    if (window.BerberPanel && window.BerberPanel.toast) window.BerberPanel.toast(msg, kind);
    else console.log(msg);
  };

  /* ------------------------------------------------------------------
     Kim giriş yapmış
  ------------------------------------------------------------------ */
  function paintUser() {
    const u = store.user;
    if (!u) return;
    const nameEl = $('#admUserName');
    const initialEl = $('#admUserInitial');
    if (nameEl) nameEl.textContent = u.name || u.username;
    if (initialEl) initialEl.textContent = (u.name || u.username || '?').trim().charAt(0).toUpperCase();
  }

  /* ------------------------------------------------------------------
     Çıkış
  ------------------------------------------------------------------ */
  const logoutBtn = $('#sideLogout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (!confirm('Çıkış yapmak istediğinize emin misiniz?')) return;
      await store.logout();
      if (window.BerberPin) window.BerberPin.lock();
      location.href = store.loginUrl();
    });
  }

  /* ------------------------------------------------------------------
     Kullanıcı listesi
  ------------------------------------------------------------------ */
  async function loadUsers() {
    const res = await api('/users');
    const list = $('#userList');
    if (!list) return;
    if (!res.ok) { list.innerHTML = '<p class="adm-svclist__empty">Kullanıcılar alınamadı.</p>'; return; }

    const users = res.data.users || [];
    const countEl = $('#userCount');
    if (countEl) countEl.textContent = users.length;
    if (!users.length) { list.innerHTML = '<p class="adm-svclist__empty">Henüz kullanıcı yok.</p>'; return; }

    list.innerHTML = '';
    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'adm-svcrow';
      const isMe = store.user && u.username === store.user.username;
      row.innerHTML = `
        <span class="adm-svcrow__name" style="font-weight:600;">${escape(u.username)}</span>
        <span class="adm-svcrow__tag">${escape(u.role === 'owner' ? 'Sahip' : 'Kullanıcı')}</span>
        ${isMe ? '' : `<button type="button" class="adm-del" data-user="${escape(u.username)}" title="Sil"><svg><use href="#i-trash"/></svg></button>`}`;
      list.appendChild(row);
    });

    list.querySelectorAll('[data-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const username = btn.dataset.user;
        if (!confirm(`"${username}" kullanıcısı silinsin mi?`)) return;
        const res2 = await api('/users?username=' + encodeURIComponent(username), { method: 'DELETE' });
        if (res2.ok) { toast('Kullanıcı silindi'); loadUsers(); }
        else toast((res2.data && res2.data.error) || 'Silinemedi', 'err');
      });
    });
  }

  const addUserBtn = $('#addUserBtn');
  if (addUserBtn) {
    addUserBtn.addEventListener('click', async () => {
      const username = $('#newUserName').value.trim();
      const password = $('#newUserPass').value;
      if (!username || !password) { toast('Kullanıcı adı ve şifre gerekli', 'err'); return; }
      const res = await api('/users', { method: 'POST', body: { username, password } });
      if (res.ok) {
        toast('Kullanıcı eklendi');
        $('#newUserName').value = '';
        $('#newUserPass').value = '';
        loadUsers();
      } else {
        toast((res.data && res.data.error) || 'Kullanıcı eklenemedi', 'err');
      }
    });
  }

  /* ------------------------------------------------------------------
     Şifre değiştirme
  ------------------------------------------------------------------ */
  const passBtn = $('#changePassBtn');
  if (passBtn) {
    passBtn.addEventListener('click', async () => {
      const current = $('#curPass').value;
      const next = $('#newPass').value;
      if (!current || !next) { toast('Mevcut ve yeni şifre gerekli', 'err'); return; }
      const res = await api('/password', { method: 'POST', body: { current, next } });
      if (res.ok) {
        toast('Şifreniz güncellendi');
        $('#curPass').value = '';
        $('#newPass').value = '';
      } else {
        toast((res.data && res.data.error) || 'Şifre değiştirilemedi', 'err');
      }
    });
  }

  /* ------------------------------------------------------------------
     Site bilgileri
  ------------------------------------------------------------------ */
  function paintSite(site) {
    if (!site) return;
    const idLabel = $('#siteIdLabel');
    if (idLabel) idLabel.textContent = site.id;
    const set = (sel, val) => { const el = $(sel); if (el && typeof val === 'string') el.value = val; };
    set('#siteName', site.name);
    set('#siteTagline', site.tagline);
    set('#sitePhone', site.phoneDisplay || site.phone);
    set('#siteAddress', site.address);

    /* Paneldeki site bağlantıları doğru siteye gitsin */
    const indexPath = site.indexPath || 'index.html';
    const siteLink = document.querySelector('.adm-side__link[href*="index.html"]');
    if (siteLink) siteLink.setAttribute('href', indexPath);
    const apptLink = document.querySelector('.adm-side__link[href*="randevu.html"]');
    if (apptLink) apptLink.setAttribute('href', `randevu.html?site=${encodeURIComponent(site.id)}`);
  }

  const siteSave = $('#siteSave');
  if (siteSave) {
    siteSave.addEventListener('click', async () => {
      const payload = {
        name: $('#siteName').value.trim(),
        meta: {
          tagline: $('#siteTagline').value.trim(),
          phone: $('#sitePhone').value.trim(),
          phoneDisplay: $('#sitePhone').value.trim(),
          address: $('#siteAddress').value.trim()
        }
      };
      const res = await api('/site', { method: 'PUT', body: payload });
      if (res.ok) { toast('Site bilgileri güncellendi'); paintSite(res.data.site); }
      else toast((res.data && res.data.error) || 'Kaydedilemedi', 'err');
    });
  }

  /* ------------------------------------------------------------------
     PIN kodu (Mali İşlemler kilidi)
  ------------------------------------------------------------------ */
  const pinStatus = async () => {
    const st = await store.pin.status();
    const stateEl = $('#pinState');
    const hintEl = $('#pinHint');
    if (stateEl) stateEl.textContent = st && st.isDefault ? 'Varsayılan' : 'Özel';
    if (hintEl) {
      const len = (st && st.length) || 4;
      hintEl.textContent = st && st.isDefault
        ? `Mali İşlemler ekranı ${len} rakamlık varsayılan PIN ile korunuyor. Güvenliği artırmak için kendi kodunuzu belirleyin.`
        : `Mali İşlemler ekranı ${len} rakamlık PIN kodunuz ile korunuyor.`;
    }
    if (window.BerberPin && window.BerberPin.refreshLength) window.BerberPin.refreshLength();
  };

  const savePinBtn = $('#savePinBtn');
  if (savePinBtn) {
    savePinBtn.addEventListener('click', async () => {
      const pin = $('#newPin').value.trim();
      const pin2 = $('#newPin2').value.trim();
      if (!/^\d{4,6}$/.test(pin)) { toast('PIN 4-6 rakamdan oluşmalı', 'err'); $('#newPin').focus(); return; }
      if (pin !== pin2) { toast('PIN kodları eşleşmiyor', 'err'); $('#newPin2').focus(); return; }
      try {
        await store.pin.set(pin);
        /* Yeni PIN ile yeniden kilitle */
        if (window.BerberPin) window.BerberPin.lock();
        $('#newPin').value = '';
        $('#newPin2').value = '';
        toast('PIN kodunuz güncellendi');
        pinStatus();
      } catch (err) {
        toast(err.message || 'PIN kaydedilemedi', 'err');
      }
    });
  }

  /* ------------------------------------------------------------------
     Eski tarayıcı verisini içe aktarma
     (sunucudaki veri boşsa eski localStorage kayıtları aktarılır)
  ------------------------------------------------------------------ */
  const importBtn = $('#importLegacyBtn');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      const legacyKeys = [
        'beyaz_admin_jobs', 'beyaz_admin_services', 'beyaz_admin_masters',
        'beyaz_admin_closed_days', 'beyaz_admin_commission', 'beyaz_admin_rate_history',
        'beyaz_admin_master_payments', 'beyaz_admin_cash_closings', 'beyaz_kuafor_randevular'
      ];
      const found = [];
      legacyKeys.forEach((k) => {
        let v = null;
        try { v = localStorage.getItem(k); } catch { /* yoksay */ }
        if (v !== null && v !== '' && v !== '[]' && v !== '{}') found.push([k, v]);
      });

      if (!found.length) { toast('Bu tarayıcıda eski kayıt bulunamadı', 'err'); return; }
      if (!confirm(`${found.length} eski kayıt sunucuya aktarılsın mı?`)) return;

      let imported = 0;
      for (const [key, value] of found) {
        const current = store.getRaw(key);
        const isEmpty = current === null || current === '' || current === '[]' || current === '{}';
        if (!isEmpty) continue;                 // sunucuda veri varsa dokunma
        store.setRaw(key, value);
        imported++;
      }
      toast(imported ? `${imported} kayıt içe aktarıldı` : 'Sunucuda zaten veri var, aktarılmadı');
      setTimeout(() => location.reload(), 800);
    });
  }

  /* ------------------------------------------------------------------
     Yardımcı
  ------------------------------------------------------------------ */
  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------------
     Başlat
  ------------------------------------------------------------------ */
  async function init() {
    await store.requireAuth();
    paintUser();
    paintSite(store.site);
    loadUsers();
    pinStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
