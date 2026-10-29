/* ==========================================================================
   Beyaz Kuaför — Yönetim Paneli
   ========================================================================== */
(async () => {
  'use strict';

  const JOBS_KEY = 'beyaz_admin_jobs';
  const SVCS_KEY = 'beyaz_admin_services';
  const MASTERS_KEY = 'beyaz_admin_masters';
  const CLOSED_KEY = 'beyaz_admin_closed_days';

  const DEFAULT_SVCS = [
    { name: 'Erkek Saç Kesimi', price: 200 },
    { name: 'Sakal Tıraşı', price: 150 },
    { name: 'Saç & Sakal Paketi', price: 300 }
  ];
  const DEFAULT_MASTERS = ['Usta 1', 'Usta 2', 'Usta 3'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------------------------------------------
     Depolama — ortak sunucu (BerberStore) + yerel önbellek
     Veriler artık tarayıcıya özel değil; sunucuda saklanır ve tüm
     cihazlarda aynı görünür.
  ------------------------------------------------------------------ */
  const S = window.BerberStore;
  const safeGet = (k) => S.getRaw(k);
  const safeSet = (k, v) => S.setRaw(k, v);

  const getJobs = () => { try { return JSON.parse(safeGet(JOBS_KEY) || '[]'); } catch { return []; } };
  const saveJobs = (j) => safeSet(JOBS_KEY, JSON.stringify(j));
  const getSvcs = () => {
    try {
      const s = JSON.parse(safeGet(SVCS_KEY));
      if (Array.isArray(s) && s.length) return s;
    } catch {}
    return DEFAULT_SVCS.map((x) => ({ ...x }));
  };
  const saveSvcs = (s) => safeSet(SVCS_KEY, JSON.stringify(s));
  const getMasters = () => {
    try {
      const s = JSON.parse(safeGet(MASTERS_KEY));
      if (Array.isArray(s) && s.length) {
        const clean = s.filter((m) => typeof m === 'string' && m.trim() && !/^Usta \d+$/i.test(m.trim()));
        if (clean.length) return clean;
      }
    } catch {}
    if (S.user && S.user.role === 'usta') {
      const myName = S.user.name || S.user.username;
      if (myName) return [myName];
    }
    return [...DEFAULT_MASTERS];
  };
  const saveMasters = (m) => safeSet(MASTERS_KEY, JSON.stringify(m));

  function addMaster(name) {
    if (!name || typeof name !== 'string') return;
    const trimmed = name.trim();
    if (!trimmed) return;
    let current = getMasters().filter((m) => !/^Usta \d+$/i.test(m.trim()));
    if (!current.includes(trimmed)) {
      current.push(trimmed);
      saveMasters(current);
    }
  }

  function removeMaster(name) {
    if (!name) return;
    const current = getMasters();
    const updated = current.filter((m) => m !== name);
    saveMasters(updated);
  }

  function syncUstaUsers(users) {
    if (!Array.isArray(users)) return;
    const ustaNames = users
      .filter((u) => u && u.role === 'usta')
      .map((u) => (u.name || u.username || '').trim())
      .filter(Boolean);
    if (!ustaNames.length) return;

    const current = getMasters();
    const clean = current.filter((m) => !/^Usta \d+$/i.test(m.trim()));
    let changed = false;

    ustaNames.forEach((n) => {
      if (!clean.includes(n)) {
        clean.push(n);
        changed = true;
      }
    });

    if (current.some((m) => /^Usta \d+$/i.test(m.trim()))) changed = true;

    if (changed) {
      saveMasters(clean);
      renderMasters();
      renderSettings();
      if (window.BerberPay) {
        if (window.BerberPay.renderPaySettings) window.BerberPay.renderPaySettings();
        if (window.BerberPay.renderMasterAccounts) window.BerberPay.renderMasterAccounts();
      }
    }
  }
  const getClosedDays = () => { try { const s = JSON.parse(safeGet(CLOSED_KEY)); return Array.isArray(s) ? s : []; } catch { return []; } };
  const saveClosedDays = (d) => safeSet(CLOSED_KEY, JSON.stringify(d));

  /* ------------------------------------------------------------------
     Yardımcılar
  ------------------------------------------------------------------ */
  const fmtDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso + 'T00:00:00').toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };
  const fmtDateLong = (iso) => {
    if (!iso) return '—';
    return new Date(iso + 'T00:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
  };
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const nowTime = () => {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `${Math.round(Number(n) || 0).toLocaleString('tr-TR')} ₺`;
  const sum = (arr) => arr.reduce((a, b) => a + (b.amount || 0), 0);
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const svcPrice = (name) => { const s = getSvcs().find((x) => x.name === name); return s ? s.price : 0; };
  const servicesOf = (j) => (Array.isArray(j.services) && j.services.length ? j.services : [j.service].filter(Boolean));

  /* ------------------------------------------------------------------
     Durum
  ------------------------------------------------------------------ */
  const state = { selected: [], master: null, manualDelta: 0 };
  const autoSum = () => state.selected.reduce((a, n) => a + svcPrice(n), 0);
  const totalAmount = () => autoSum() + state.manualDelta;

  /* ------------------------------------------------------------------
     Toast
  ------------------------------------------------------------------ */
  function toast(msg, kind = 'ok') {
    const box = $('#admToasts');
    const el = document.createElement('div');
    el.className = `adm-toast adm-toast--${kind}`;
    const icon = kind === 'ok' ? '#i-check' : '#i-x';
    el.innerHTML = `<svg><use href="${icon}"/></svg><span>${escapeHtml(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }

  /* ==================================================================
     GÖRÜNÜMLER (view yönetimi)
  ================================================================== */
  const VIEW_META = {
    pos: { title: 'Yeni İşlem', sub: 'Hizmeti seçin, usta atayın ve işlemi tek adımda kaydedin.' },
    appointments: { title: 'Randevular', sub: 'Müşterilerin site üzerinden aldığı online randevular.' },
    history: { title: 'İş Geçmişi', sub: 'Kayıtlı tüm işlemleri filtreleyin, inceleyin ve raporlayın.' },
    finance: { title: 'Mali İşlemler', sub: 'Günlük ve aylık ciro takibi, kırılımlar ve dönemsel raporlar.' },
    masters: { title: 'Usta Hesapları', sub: 'Dönemsel hak ediş, usta ödemeleri ve kalan bakiye.' },
    kasa: { title: 'Kasa', sub: 'Nakit ve kart cirosu, gün sonu kapanışı ve fark takibi.' },
    pay: { title: 'Pay Ayarları', sub: 'Usta ve hizmet bazlı pay oranlarını yönetin.' },
    settings: { title: 'Ayarlar', sub: 'Hizmet fiyatlarını ve usta listesini yönetin.' }
  };

  let currentView = 'pos';

  /* PIN korumalı ekranlar — finansal veri gösteren bölümler */
  const PIN_GUARDED_VIEWS = ['finance', 'kasa'];

  function switchView(name, skipHash) {
    /* Usta rolü sadece Yeni İşlem (pos) sayfasına erişebilir */
    if (userRole === 'usta' && name !== 'pos') {
      toast('Bu sayfaya erişim izniniz yok.', 'err');
      return;
    }

    closeOwnerMore(true);

    const guarded = PIN_GUARDED_VIEWS.includes(name);

    if (guarded) {
      /* Finansal alana giriş: PIN kilidi her seferinde yeniden istenir */
      if (window.BerberPin && !window.BerberPin.isUnlocked()) {
        window.BerberPin.open(() => switchView(name), name === 'kasa' ? 'Kasa Kilidi' : 'Mali İşlemler Kilidi');
        return;
      }
    } else if (window.BerberPin) {
      /* Finansal alandan çıkıldı — kilit yeniden kurulur */
      window.BerberPin.lock();
    }

    currentView = name;
    $$('.adm-view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
    $$('.adm-navitem').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
    syncOwnerNav(name);
    const meta = VIEW_META[name] || VIEW_META.pos;
    $('#admPageTitle').textContent = meta.title;
    $('#admPageSub').textContent = meta.sub;
    $('.adm-content').scrollTop = 0;
    if (name === 'history') renderJobs();
    if (name === 'finance') renderFinance();
    if (name === 'settings') renderSettings();
    if (name === 'appointments' && window.BerberAppointments) window.BerberAppointments.render();
    if (name === 'kasa' && window.BerberPay) window.BerberPay.renderCash();
    if (name === 'masters' && window.BerberPay) window.BerberPay.renderMasterAccounts();
    if (name === 'pay' && window.BerberPay) window.BerberPay.renderPaySettings();
    if (name === 'pos') { renderMasters(); renderDoneList(); renderDayStatus(); renderOwnerSnap(); }
    if (!skipHash) {
      try { history.replaceState(null, '', '#' + name); } catch {}
    }
  }

  window.addEventListener('hashchange', () => {
    const v = location.hash.replace('#', '');
    if (VIEW_META[v] && v !== currentView) switchView(v, true);
  });

  $$('.adm-navitem').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  const MORE_VIEWS = ['finance', 'masters', 'pay', 'settings'];

  function syncOwnerNav(name) {
    const sheet = $('#ownerMoreMenu');
    const moreOpen = !!(sheet && sheet.classList.contains('is-open'));
    $$('.adm-tab').forEach((b) => {
      if (b.dataset.view === 'more') {
        b.classList.toggle('is-active', moreOpen || MORE_VIEWS.includes(name));
      } else {
        b.classList.toggle('is-active', !moreOpen && b.dataset.view === name);
      }
    });
    $$('.adm-more__item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  }

  function openOwnerMore() {
    const sheet = $('#ownerMoreMenu');
    if (!sheet) return;
    sheet.hidden = false;
    sheet.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    syncOwnerNav(currentView);
  }

  function closeOwnerMore(keepHash) {
    const sheet = $('#ownerMoreMenu');
    if (!sheet) return;
    sheet.hidden = true;
    sheet.classList.remove('is-open');
    document.body.style.overflow = '';
    if (!keepHash) syncOwnerNav(currentView);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOwnerMore();
  });

  $$('.adm-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'more') {
        const sheet = $('#ownerMoreMenu');
        if (sheet && sheet.classList.contains('is-open')) closeOwnerMore();
        else openOwnerMore();
        return;
      }
      switchView(btn.dataset.view);
    });
  });

  const moreMenu = $('#ownerMoreMenu');
  if (moreMenu) {
    moreMenu.addEventListener('click', (e) => {
      if (e.target === moreMenu) closeOwnerMore();
    });
  }
  const moreClose = $('#ownerMoreClose');
  if (moreClose) moreClose.addEventListener('click', () => closeOwnerMore());
  $$('.adm-more__item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  const moreLogout = $('#ownerMoreLogout');
  if (moreLogout) {
    moreLogout.addEventListener('click', () => {
      const side = $('#sideLogout');
      if (side) side.click();
    });
  }

  /* ==================================================================
     KPI / İstatistik
  ================================================================== */
  function renderStats() {
    const jobs = getJobs();
    const today = todayISO();

    if (userRole === 'usta') {
      const myName = S.user.name || S.user.username;
      const myJobs = jobs.filter((j) => j.master === myName);
      const todayJobs = myJobs.filter((j) => j.date === today);
      $('#sideToday').textContent = todayJobs.length;
      $('#navJobCount').textContent = myJobs.length;
      renderMyStats();
    } else {
      const todayJobs = jobs.filter((j) => j.date === today);
      $('#sideToday').textContent = todayJobs.length;
      $('#navJobCount').textContent = jobs.length;
      $$('.js-badge-jobs').forEach((el) => {
        el.textContent = jobs.length;
        if (el.classList.contains('adm-tab__badge')) el.style.display = jobs.length ? '' : 'none';
      });
      renderOwnerSnap();
    }
    renderFinance();
  }

  function renderOwnerSnap() {
    if (userRole === 'usta') return;
    const ciroEl = $('#snapTodayCiro');
    if (!ciroEl) return;
    const today = todayISO();
    const jobs = getJobs().filter((j) => j.date === today);
    const ciro = sum(jobs);
    const share = jobs.reduce((a, j) => {
      if (Number.isInteger(j.masterShareKurus)) return a + j.masterShareKurus / 100;
      const rate = Number.isInteger(j.commissionRate) ? j.commissionRate : 50;
      return a + ((j.amount || 0) * rate / 100);
    }, 0);
    const cash = jobs.filter((j) => j.paymentMethod !== 'card').reduce((a, j) => a + (j.amount || 0), 0);
    const card = jobs.filter((j) => j.paymentMethod === 'card').reduce((a, j) => a + (j.amount || 0), 0);
    const closed = window.BerberPay && window.BerberPay.isDayClosed
      ? window.BerberPay.isDayClosed(today)
      : getClosedDays().includes(today);
    ciroEl.textContent = money(ciro);
    $('#snapJobsMeta').textContent = `${jobs.length} işlem`;
    $('#snapMasterShare').textContent = money(share);
    $('#snapCash').textContent = money(cash);
    $('#snapCashMeta').textContent = `Kart ${money(card)}`;
    $('#snapKasaState').textContent = closed ? 'Kapalı' : 'Açık';
    $('#snapKasaMeta').textContent = closed ? 'Gün kapatıldı' : 'Gün henüz kapatılmadı';
  }

  /* ==================================================================
     Hizmetler
  ================================================================== */
  function renderServices() {
    const container = $('#svcBoxes');
    container.innerHTML = '';
    getSvcs().forEach((s) => {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'adm-svc';
      box.dataset.name = s.name;
      box.innerHTML = `
        <span class="adm-svc__name">${escapeHtml(s.name)}</span>
        <span class="adm-svc__meta">
          <span class="adm-svc__price">${money(s.price)}</span>
          <span class="adm-svc__tag">Hizmet</span>
        </span>`;
      box.addEventListener('click', () => {
        if (state.selected.includes(s.name)) {
          state.selected = state.selected.filter((x) => x !== s.name);
        } else {
          state.selected.push(s.name);
        }
        renderAll();
      });
      container.appendChild(box);
    });
    renderPresets();
    syncServiceUI();
  }

  /* Seçim görselini DOM'u yeniden kurmadan günceller */
  function syncServiceUI() {
    $$('#svcBoxes .adm-svc').forEach((box) => {
      const name = box.dataset.name;
      const idx = state.selected.indexOf(name);
      const selected = idx > -1;
      box.classList.toggle('is-selected', selected);

      let badge = box.querySelector('.adm-svc__idx');
      if (selected && !badge) {
        badge = document.createElement('span');
        badge.className = 'adm-svc__idx';
        box.insertBefore(badge, box.firstChild);
      } else if (!selected && badge) {
        badge.remove();
      }
      if (badge) badge.textContent = idx + 1;

      const tag = box.querySelector('.adm-svc__tag');
      if (tag) tag.textContent = selected ? 'Seçildi' : 'Hizmet';
    });
  }

  function renderPresets() {
    const container = $('#amtPresets');
    container.innerHTML = '';
    [50, 100, 150, 200, 250, 300, 400, 500].forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'adm-preset';
      b.textContent = money(v);
      b.addEventListener('click', () => {
        state.manualDelta = v - autoSum();
        renderAll();
      });
      container.appendChild(b);
    });
  }

  /* ==================================================================
     Ustalar
  ================================================================== */
  function renderMasters() {
    const container = $('#masterBoxes');
    if (!container) return;
    container.innerHTML = '';
    const masters = getMasters();
    if (!masters.length) {
      container.innerHTML = '<span class="adm-chips__empty" style="padding:10px;color:var(--text-muted);font-size:13px;">Kayıtlı usta yok</span>';
      return;
    }
    masters.forEach((m) => {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'adm-master';
      box.dataset.name = m;
      box.innerHTML = `<span class="adm-master__avatar">${escapeHtml(initials(m))}</span><span>${escapeHtml(m)}</span>`;
      box.addEventListener('click', () => {
        state.master = state.master === m ? null : m;
        renderAll();
      });
      container.appendChild(box);
    });
    syncMasterUI();
  }

  function syncMasterUI() {
    $$('#masterBoxes .adm-master').forEach((box) => {
      box.classList.toggle('is-selected', box.dataset.name === state.master);
    });
  }

  /* ==================================================================
     Ekstra hizmet
  ================================================================== */
  function renderExtras() {
    const container = $('#extraChips');
    container.innerHTML = '';
    const extras = state.selected.slice(1);
    if (!extras.length) {
      container.innerHTML = '<span class="adm-chips__empty">Ekstra hizmet eklenmedi</span>';
      return;
    }
    extras.forEach((name, i) => {
      const chip = document.createElement('span');
      chip.className = 'adm-chip';
      chip.innerHTML = `<span>${escapeHtml(name)}</span><button type="button" title="Kaldır">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        state.selected.splice(i + 1, 1);
        renderAll();
      });
      container.appendChild(chip);
    });
  }

  /* ==================================================================
     Özet
  ================================================================== */
  function renderSummary() {
    const container = $('#summaryList');
    container.innerHTML = '';
    if (!state.selected.length && !state.master) {
      container.innerHTML = '<div class="adm-summarylist__empty">Henüz seçim yapılmadı</div>';
    }
    state.selected.forEach((name) => {
      const div = document.createElement('div');
      div.className = 'adm-summarylist__row';
      div.innerHTML = `<span>${escapeHtml(name)}</span><span>${money(svcPrice(name))}</span>`;
      container.appendChild(div);
    });
    if (state.master && userRole !== 'usta') {
      const div = document.createElement('div');
      div.className = 'adm-summarylist__row adm-summarylist__row--master';
      div.innerHTML = `<span>Usta</span><span>${escapeHtml(state.master)}</span>`;
      container.appendChild(div);
    }
    $('#amountDisplay').textContent = money(totalAmount());
    $('#totalAmt').textContent = money(totalAmount());

    const deltaEl = $('#amountDelta');
    if (deltaEl) {
      const d = state.manualDelta;
      if (d > 0) {
        deltaEl.className = 'adm-amount__delta is-plus';
        deltaEl.textContent = `+${money(d)} düzeltme`;
      } else if (d < 0) {
        deltaEl.className = 'adm-amount__delta is-minus';
        deltaEl.textContent = `−${money(Math.abs(d))} düzeltme`;
      } else {
        deltaEl.className = 'adm-amount__delta is-zero';
        deltaEl.textContent = 'Otomatik hesap';
      }
    }
  }

  function renderAll() {
    syncServiceUI();
    syncMasterUI();
    renderExtras();
    renderSummary();
  }

  /* ==================================================================
     Tamamlanan işlemler (sağ panel)
  ================================================================== */
  function todayJobs() {
    const t = todayISO();
    return getJobs().filter((j) => j.date === t).sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  }

  function renderDoneList() {
    const allJobs = todayJobs();
    const box = $('#doneList');

    const displayJobs = userRole === 'usta'
      ? allJobs.filter((j) => j.master === (S.user.name || S.user.username))
      : allJobs;

    $('#doneCount').textContent = displayJobs.length;
    $('#doneDayCount').textContent = displayJobs.length;

    if (!displayJobs.length) {
      box.innerHTML = `
        <div class="adm-donelist__empty">
          <svg><use href="#i-receipt"/></svg>
          <p>Henüz işlem yok</p>
          <span>Tamamlanan işlemler burada listelenir</span>
        </div>`;
      return;
    }

    box.innerHTML = '';
    displayJobs.forEach((j) => {
      const row = document.createElement('div');
      row.className = 'adm-done';
      row.innerHTML = `
        <span class="adm-done__badge">${escapeHtml((j.time || '--:--'))}</span>
        <div class="adm-done__body">
          <div class="adm-done__top">
            <span class="adm-done__name">${escapeHtml(j.master || '—')}</span>
            <span class="adm-done__amt">${money(j.amount)}</span>
          </div>
          <div class="adm-done__meta">${escapeHtml(servicesOf(j).join(' · '))}</div>
        </div>
        <button type="button" class="adm-done__del" title="Kaydı sil">
          <svg><use href="#i-trash"/></svg>
        </button>`;
      row.querySelector('.adm-done__del').addEventListener('click', () => {
        if (window.BerberPay && !window.BerberPay.guardDelete(j)) return;
        if (!confirm('Bu kaydı silmek istediğinize emin misiniz?')) return;
        saveJobs(getJobs().filter((x) => x.id !== j.id));
        renderDoneList();
        renderStats();
        toast('Kayıt silindi');
      });
      box.appendChild(row);
    });
  }

  function renderDayStatus() {
    const el = $('#dayStatus');
    const today = todayISO();
    const closed = (window.BerberPay && window.BerberPay.isDayClosed)
      ? window.BerberPay.isDayClosed(today)
      : getClosedDays().includes(today);

    el.classList.toggle('is-closed', closed);
    el.innerHTML = closed
      ? `⚑ Bugün (${fmtDate(today)}) kapatıldı — yeni işlem alınamaz.
         <button type="button" class="adm-daystatus__btn" id="reopenDayBtn">Günü Yeniden Aç</button>`
      : '';
  }

  /* Kapatılan günü POS ekranından yeniden açma düğmesi */
  const dayStatusEl = $('#dayStatus');
  if (dayStatusEl) {
    dayStatusEl.addEventListener('click', (e) => {
      const btn = e.target.closest('#reopenDayBtn');
      if (!btn) return;
      if (!window.BerberPay || !window.BerberPay.reopenDay) return;
      btn.disabled = true;
      const ok = window.BerberPay.reopenDay(todayISO());
      btn.disabled = false;
      if (ok) { renderDayStatus(); renderDoneList(); }
    });
  }

  /* ==================================================================
     İşlemi Tamamla
  ================================================================== */
  $$('.adm-amtbtn, .adm-stepbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.manualDelta += parseInt(btn.dataset.delta, 10);
      renderSummary();
    });
  });

  $('#completeBtn').addEventListener('click', () => {
    if (!state.selected.length) { toast('Hizmet seçin.', 'err'); return; }

    /* Usta rolünde master zaten otomatik atanmıştır; owner için seçim zorunlu */
    if (userRole !== 'usta' && !state.master) { toast('Usta seçin.', 'err'); return; }
    const masterName = userRole === 'usta' ? (S.user.name || S.user.username) : state.master;

    /* Kasa kapanışı yapılmış günlerde yeni işlem alınamaz (admin-pay modülü) */
    const guard = (window.BerberPay && window.BerberPay.checkTransactionAllowed)
      ? window.BerberPay.checkTransactionAllowed()
      : { ok: true };
    if (!guard.ok) { toast(guard.reason, 'err'); return; }

    /* Pay oranı + ödeme yöntemi snapshot'ı (admin-pay modülü) */
    const extra = (window.BerberPay && window.BerberPay.buildJobFields)
      ? window.BerberPay.buildJobFields({
        master: masterName,
        services: [...state.selected],
        amount: totalAmount()
      })
      : {};

    const job = {
      id: 'J' + Date.now() + Math.floor(Math.random() * 1000),
      date: todayISO(),
      time: nowTime(),
      master: masterName,
      services: [...state.selected],
      service: state.selected.join(' + '),
      amount: totalAmount(),
      paymentMethod: $('#payMethod') ? ($('#payMethod').querySelector('.adm-segment__btn.is-active')?.dataset.method || 'cash') : 'cash',
      createdAt: new Date().toISOString(),
      ...extra
    };
    const jobs = getJobs();
    jobs.push(job);
    saveJobs(jobs);

    state.selected = [];
    state.master = null;
    state.manualDelta = 0;

    renderAll();
    renderStats();
    renderDoneList();
    toast(`İşlem kaydedildi · ${money(job.amount)}`);
  });

  /* ==================================================================
     Modal yönetimi
  ================================================================== */
  const openModal = (id) => {
    const m = $('#' + id);
    if (!m) return;
    m.classList.add('is-open');
    const f = m.querySelector('input, button');
    if (f) setTimeout(() => f.focus(), 60);
  };
  const closeModal = (id) => { const m = $('#' + id); if (m) m.classList.remove('is-open'); };
  const closeAllModals = () => $$('.adm-modal').forEach((m) => m.classList.remove('is-open'));

  $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  $$('.adm-modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('is-open'); });
  });

  /* Gün Sonu raporu kapanınca finansal kilit yeniden kurulur */
  const dayEndModal = $('#dayEndModal');
  if (dayEndModal) {
    dayEndModal.addEventListener('click', () => {
      setTimeout(() => {
        if (!dayEndModal.classList.contains('is-open') && window.BerberPin) window.BerberPin.lock();
      }, 0);
    });
  }

  /* ==================================================================
     Ekstra hizmet seçimi
  ================================================================== */
  $('#extraPickBtn').addEventListener('click', () => {
    const list = $('#extraPickList');
    list.innerHTML = '';
    getSvcs().forEach((s) => {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'adm-svc';
      box.innerHTML = `<span class="adm-svc__name">${escapeHtml(s.name)}</span><span class="adm-svc__price">${money(s.price)}</span>`;
      box.addEventListener('click', () => {
        if (!state.selected.includes(s.name)) state.selected.push(s.name);
        closeModal('extraModal');
        renderAll();
        toast(`${s.name} eklendi`);
      });
      list.appendChild(box);
    });
    openModal('extraModal');
  });

  /* ==================================================================
     Hızlı ekleme
  ================================================================== */
  $('#addSvcQuick').addEventListener('click', () => { $('#qsName').value = ''; $('#qsPrice').value = ''; openModal('addSvcModal'); });
  $('#qsSave').addEventListener('click', () => {
    const name = $('#qsName').value.trim();
    const price = parseFloat($('#qsPrice').value);
    if (!name) { toast('Hizmet adı girin.', 'err'); return; }
    if (isNaN(price)) { toast('Fiyat girin.', 'err'); return; }
    const svcs = getSvcs();
    svcs.push({ name, price });
    saveSvcs(svcs);
    closeModal('addSvcModal');
    renderServices();
    toast('Hizmet eklendi');
  });

  $('#addMasterQuick').addEventListener('click', () => { $('#qmName').value = ''; openModal('addMasterModal'); });
  $('#qmSave').addEventListener('click', () => {
    const name = $('#qmName').value.trim();
    if (!name) { toast('Ad girin.', 'err'); return; }
    let ms = getMasters().filter((m) => !/^Usta \d+$/i.test(m.trim()));
    if (!ms.includes(name)) ms.push(name);
    saveMasters(ms);
    closeModal('addMasterModal');
    $('#qmName').value = '';
    renderMasters();
    renderAll();
    renderSettings();
    if (window.BerberPay) {
      window.BerberPay.renderPaySettings();
      window.BerberPay.renderMasterAccounts();
    }
    toast(`"${name}" eklendi.`);
  });

  /* ==================================================================
     Ayarlar
  ================================================================== */
  function renderSettings() {
    const svcContainer = $('#svcList');
    svcContainer.innerHTML = '';
    const svcs = getSvcs();
    $('#svcCount').textContent = svcs.length;
    svcs.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = 'adm-svcrow';
      row.innerHTML = `
        <input type="text" class="adm-svcrow__name" value="${escapeHtml(s.name)}" data-name="${idx}" aria-label="Hizmet adı" />
        <input type="number" value="${s.price}" data-price="${idx}" min="0" inputmode="decimal" aria-label="Fiyat" />
        <span class="adm-svcrow__unit">₺</span>
        <button type="button" class="adm-del" data-del="${idx}" title="Sil"><svg><use href="#i-trash"/></svg></button>`;
      svcContainer.appendChild(row);
    });
    svcContainer.querySelectorAll('[data-price]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const list = getSvcs();
        list[inp.dataset.price].price = parseFloat(inp.value) || 0;
        saveSvcs(list);
        renderServices();
        renderSummary();
        toast('Fiyat güncellendi');
      });
    });
    svcContainer.querySelectorAll('[data-name]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const list = getSvcs();
        const idx = Number(inp.dataset.name);
        const v = inp.value.trim();
        const old = list[idx].name;
        if (!v) { inp.value = old; return; }
        list[idx].name = v;
        saveSvcs(list);
        state.selected = state.selected.map((n) => (n === old ? v : n));
        renderServices();
        renderSummary();
        toast('Hizmet adı güncellendi');
      });
    });
    svcContainer.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const list = getSvcs();
        if (list.length <= 1) { toast('En az bir hizmet kalmalı.', 'err'); return; }
        list.splice(btn.dataset.del, 1);
        saveSvcs(list);
        renderSettings();
        renderServices();
        toast('Hizmet silindi');
      });
    });

    const mContainer = $('#masterList');
    mContainer.innerHTML = '';
    const masters = getMasters();
    $('#masterCount').textContent = masters.length;
    masters.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'adm-svcrow';
      row.innerHTML = `
        <span class="adm-master__avatar">${escapeHtml(initials(m))}</span>
        <span class="adm-svcrow__name">${escapeHtml(m)}</span>
        <button type="button" class="adm-del" data-del="${idx}" title="Sil"><svg><use href="#i-trash"/></svg></button>`;
      mContainer.appendChild(row);
    });
    mContainer.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ms = getMasters();
        if (ms.length <= 1) { toast('En az bir usta kalmalı.', 'err'); return; }
        const removed = ms.splice(btn.dataset.del, 1)[0];
        saveMasters(ms);
        renderSettings();
        renderMasters();
        if (window.BerberPay) {
          window.BerberPay.renderPaySettings();
          window.BerberPay.renderMasterAccounts();
        }
        toast(`"${removed}" silindi`);
      });
    });
  }

  $('#addSvcBtn').addEventListener('click', () => {
    const name = $('#newSvcName').value.trim();
    const price = parseFloat($('#newSvcPrice').value);
    if (!name) { toast('Hizmet adı girin.', 'err'); return; }
    if (isNaN(price)) { toast('Fiyat girin.', 'err'); return; }
    const svcs = getSvcs();
    svcs.push({ name, price });
    saveSvcs(svcs);
    $('#newSvcName').value = '';
    $('#newSvcPrice').value = '';
    renderSettings();
    renderServices();
    toast('Hizmet eklendi');
  });

  $('#addMasterBtn').addEventListener('click', () => {
    const name = $('#newMasterName').value.trim();
    if (!name) { toast('Usta adı girin.', 'err'); return; }
    let ms = getMasters().filter((m) => !/^Usta \d+$/i.test(m.trim()));
    if (!ms.includes(name)) ms.push(name);
    saveMasters(ms);
    $('#newMasterName').value = '';
    renderSettings();
    renderMasters();
    if (window.BerberPay) {
      window.BerberPay.renderPaySettings();
      window.BerberPay.renderMasterAccounts();
    }
    toast(`"${name}" eklendi`);
  });

  $('#clearJobsBtn').addEventListener('click', () => {
    if (!confirm('TÜM işlem geçmişi kalıcı olarak silinecek. Emin misiniz?')) return;
    saveJobs([]);
    renderStats();
    renderDoneList();
    toast('Tüm geçmiş silindi');
  });

  /* ==================================================================
     Geçmiş / filtreler
  ================================================================== */
  let filteredJobs = [];

  function currentFilter() {
    const from = $('#fFrom').value;
    const to = $('#fTo').value;
    const q = $('#fSearch').value.trim().toLowerCase();
    let jobs = getJobs();
    if (from) jobs = jobs.filter((j) => j.date >= from);
    if (to) jobs = jobs.filter((j) => j.date <= to);
    if (q) jobs = jobs.filter((j) => (servicesOf(j).join(' ') + ' ' + (j.master || '')).toLowerCase().includes(q));
    return jobs.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  }

  /** Filtreye göre ciro kartının başlığı ve dönem açıklaması */
  function filterPeriod() {
    const active = document.querySelector('.adm-chipbtn.is-active');
    const quick = active ? active.dataset.quick : 'all';
    const from = $('#fFrom').value;
    const to = $('#fTo').value;
    const today = todayISO();
    const d = new Date();
    const isoOf = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const monday = new Date(d); monday.setDate(d.getDate() - d.getDay() + 1);

    const monthName = (iso) => {
      if (!iso) return '';
      const dt = new Date(iso + 'T00:00:00');
      return dt.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
    };

    /* Hızlı filtre butonu, tarih alanlarıyla da tutarlıysa ona göre adlandır */
    if (quick === 'today' && from === today && to === today) {
      return { label: 'Günlük Ciro', meta: fmtDate(today) };
    }
    if (quick === 'week' && from === isoOf(monday) && to === today) {
      return { label: 'Haftalık Ciro', meta: `${fmtDate(from)} – ${fmtDate(to)}` };
    }
    if (quick === 'month' && from === today.slice(0, 8) + '01' && to === today) {
      return { label: 'Aylık Ciro', meta: monthName(from) };
    }
    if (from || to) {
      return {
        label: 'Toplam Ciro',
        meta: `${from ? fmtDate(from) : 'Başlangıç'} – ${to ? fmtDate(to) : 'Bugün'}`
      };
    }
    return { label: 'Toplam Ciro', meta: 'Tüm zamanlar' };
  }

  function renderJobs() {
    filteredJobs = currentFilter();
    const tbody = $('#jobBody');
    tbody.innerHTML = '';
    const empty = $('#jobEmpty');

    $('#histCount').textContent = filteredJobs.length;
    $('#histAvg').textContent = `Ort. ${money(filteredJobs.length ? sum(filteredJobs) / filteredJobs.length : 0)}`;

    /* Bugünün ciro — filtreten bağımsız */
    const today = todayISO();
    const todayJobs = getJobs().filter((j) => j.date === today);
    $('#histToday').textContent = money(sum(todayJobs));
    $('#histTodayMeta').textContent = todayJobs.length ? `${todayJobs.length} işlem · ${fmtDate(today)}` : fmtDate(today);

    /* Filtreye göre ciro — başlık ve dönem filtrele birlikte değişir */
    const period = filterPeriod();
    $('#histTotalLabel').textContent = period.label;
    $('#histTotalMeta').textContent = period.meta;
    $('#histTotal').textContent = money(sum(filteredJobs));

    if (filteredJobs.length) {
      const last = filteredJobs[0];
      $('#histLast').textContent = fmtDate(last.date);
      $('#histLastMeta').textContent = `${last.time || ''} · ${last.master || '—'}`;
    } else {
      $('#histLast').textContent = '—';
      $('#histLastMeta').textContent = '—';
    }

    if (!filteredJobs.length) { empty.classList.add('is-visible'); return; }
    empty.classList.remove('is-visible');

    filteredJobs.forEach((j) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="adm-table__date" data-label="Tarih">${fmtDate(j.date)}</td>
        <td class="adm-table__time" data-label="Saat">${j.time || '—'}</td>
        <td data-label="Usta"><span class="adm-table__master"><i>${escapeHtml(initials(j.master))}</i>${escapeHtml(j.master || '—')}</span></td>
        <td class="adm-table__svc" data-label="Hizmetler">${escapeHtml(servicesOf(j).join(' · '))}</td>
        <td class="ta-right" data-label="Ücret"><strong>${money(j.amount)}</strong></td>
        <td class="ta-center" data-label="İşlem"><button type="button" class="adm-del" title="Sil"><svg><use href="#i-trash"/></svg></button></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.adm-del').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        const job = filteredJobs[i];
        if (window.BerberPay && !window.BerberPay.guardDelete(job)) return;
        if (!confirm('Bu kaydı silmek istediğinize emin misiniz?')) return;
        saveJobs(getJobs().filter((x) => x.id !== job.id));
        renderJobs();
        renderStats();
        renderDoneList();
        toast('Kayıt silindi');
      });
    });
  }

  $('#applyFilter').addEventListener('click', renderJobs);
  $('#fSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderJobs(); });
  $('#clearFilter').addEventListener('click', () => {
    $('#fFrom').value = '';
    $('#fTo').value = '';
    $('#fSearch').value = '';
    $$('.adm-chipbtn').forEach((b) => b.classList.toggle('is-active', b.dataset.quick === 'all'));
    renderJobs();
  });

  $$('.adm-chipbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.adm-chipbtn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const today = todayISO();
      const d = new Date();
      if (btn.dataset.quick === 'today') {
        $('#fFrom').value = today; $('#fTo').value = today;
      } else if (btn.dataset.quick === 'week') {
        const start = new Date(d); start.setDate(d.getDate() - d.getDay() + 1);
        const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
        $('#fFrom').value = iso(start); $('#fTo').value = today;
      } else if (btn.dataset.quick === 'month') {
        $('#fFrom').value = today.slice(0, 8) + '01'; $('#fTo').value = today;
      } else {
        $('#fFrom').value = ''; $('#fTo').value = '';
      }
      renderJobs();
    });
  });

  /* ---------------------------- CSV ---------------------------- */
  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function jobsToCsv(jobs) {
    const header = ['Tarih', 'Saat', 'Usta', 'Hizmetler', 'Ücret'];
    const rows = jobs.map((j) => [j.date, j.time || '', j.master || '', servicesOf(j).join(' + '), j.amount]);
    return [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  }

  $('#exportBtn').addEventListener('click', () => {
    const jobs = filteredJobs.length ? filteredJobs : getJobs();
    if (!jobs.length) { toast('Dışa aktarılacak kayıt yok.', 'err'); return; }
    downloadBlob('\uFEFF' + jobsToCsv(jobs), 'beyaz-kuafor-is-gecmisi.csv', 'text/csv;charset=utf-8;');
    toast('CSV indirildi');
  });

  /* ==================================================================
     GÜN SONU RAPORU
  ================================================================== */
  function jobsOfDate(date) {
    return getJobs().filter((j) => j.date === date).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  }

  function groupBy(items) {
    const map = new Map();
    items.forEach((it) => {
      const cur = map.get(it.name) || { name: it.name, count: 0, amount: 0 };
      cur.count += 1; cur.amount += it.amount;
      map.set(it.name, cur);
    });
    return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
  }

  function reportData(jobs) {
    const masters = [];
    const services = [];
    jobs.forEach((j) => {
      masters.push({ name: j.master || '—', amount: j.amount || 0 });
      servicesOf(j).forEach((s) => services.push({ name: s, amount: svcPrice(s) || 0 }));
    });
    return {
      total: sum(jobs),
      count: jobs.length,
      avg: jobs.length ? sum(jobs) / jobs.length : 0,
      masters: groupBy(masters),
      services: groupBy(services)
    };
  }

  function renderDayEnd() {
    const date = $('#dayEndDate').value || todayISO();
    const jobs = jobsOfDate(date);
    const d = reportData(jobs);
    const closed = (window.BerberPay && window.BerberPay.isDayClosed)
      ? window.BerberPay.isDayClosed(date)
      : getClosedDays().includes(date);

    let html = '';

    html += `<div class="adm-report__kpis">
      <div class="adm-rkpi adm-rkpi--gold"><span>Toplam Ciro</span><strong>${money(d.total)}</strong></div>
      <div class="adm-rkpi"><span>İşlem Sayısı</span><strong>${d.count}</strong></div>
      <div class="adm-rkpi"><span>Ortalama Tut</span><strong>${money(d.avg)}</strong></div>
      <div class="adm-rkpi"><span>Durum</span><strong style="font-size:15px">${closed ? 'Gün Sonu Yapıldı' : 'Açık'}</strong></div>
    </div>`;

    html += `<div class="adm-report__cols">
      <div class="adm-report__block">
        <h4>Usta Bazlı Ciro</h4>
        ${breakdownHtml(d.masters, d.total)}
      </div>
      <div class="adm-report__block">
        <h4>Hizmet Bazlı Ciro</h4>
        ${breakdownHtml(d.services, d.total)}
      </div>
    </div>`;

    html += `<div class="adm-report__block">
      <h4>İşlem Detayları</h4>
      <div class="adm-tablewrap">
        <table class="adm-table">
          <thead><tr><th>Saat</th><th>Usta</th><th>Hizmetler</th><th class="ta-right">Ücret</th></tr></thead>
          <tbody>
            ${jobs.length ? jobs.map((j) => `<tr>
              <td class="adm-table__time" data-label="Saat">${j.time || '—'}</td>
              <td data-label="Usta">${escapeHtml(j.master || '—')}</td>
              <td class="adm-table__svc" data-label="Hizmetler">${escapeHtml(servicesOf(j).join(' · '))}</td>
              <td class="ta-right" data-label="Ücret"><strong>${money(j.amount)}</strong></td>
            </tr>`).join('') : `<tr class="adm-table__emptyrow"><td colspan="4" style="text-align:center;padding:26px;color:var(--faint)">Bu tarihte kayıtlı işlem bulunmuyor.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

    $('#dayEndBody').innerHTML = html;
    $('#dayEndToggle').querySelector('span').textContent = closed ? 'Günü Yeniden Aç' : 'Günü Kapat';
    $('#dayEndToggle').classList.toggle('adm-btn--outline', closed);
    $('#dayEndToggle').classList.toggle('adm-btn--dark', !closed);
  }

  function breakdownHtml(rows, total) {
    if (!rows.length) return '<div class="adm-break__empty">Veri yok</div>';
    const max = Math.max(...rows.map((r) => r.amount), 1);
    return `<div class="adm-break">${rows.map((r) => `
      <div class="adm-break__row">
        <div class="adm-break__top">
          <span class="adm-break__name">${escapeHtml(r.name)}</span>
          <span class="adm-break__val">${r.count} işlem · ${money(r.amount)}</span>
        </div>
        <div class="adm-break__track"><div class="adm-break__fill" style="width:${Math.round((r.amount / max) * 100)}%"></div></div>
      </div>`).join('')}</div>`;
  }

  $('#dayEndBtn').addEventListener('click', () => {
    const openDayEnd = () => {
      $('#dayEndDate').value = todayISO();
      renderDayEnd();
      openModal('dayEndModal');
    };
    if (window.BerberPin) window.BerberPin.require(openDayEnd, 'Gün Sonu Kilidi');
    else openDayEnd();
  });
  $('#dayEndRefresh').addEventListener('click', renderDayEnd);
  $('#dayEndDate').addEventListener('change', renderDayEnd);

  $('#dayEndToggle').addEventListener('click', () => {
    const date = $('#dayEndDate').value || todayISO();
    if (window.BerberPay && window.BerberPay.toggleDay) {
      window.BerberPay.toggleDay(date);
    } else {
      const list = getClosedDays();
      const i = list.indexOf(date);
      if (i > -1) list.splice(i, 1); else list.push(date);
      saveClosedDays(list);
      toast(i > -1 ? 'Gün yeniden açıldı' : 'Gün sonu yapıldı');
    }
    renderDayEnd();
    renderDayStatus();
  });

  $('#dayEndCsv').addEventListener('click', () => {
    const date = $('#dayEndDate').value || todayISO();
    const jobs = jobsOfDate(date);
    if (!jobs.length) { toast('Dışa aktarılacak kayıt yok.', 'err'); return; }
    downloadBlob('\uFEFF' + jobsToCsv(jobs), `beyaz-kuafor-gun-sonu-${date}.csv`, 'text/csv;charset=utf-8;');
    toast('CSV indirildi');
  });

  $('#dayEndPdf').addEventListener('click', async () => {
    const date = $('#dayEndDate').value || todayISO();
    const jobs = jobsOfDate(date);
    await exportReportPDF(jobs, {
      title: 'GÜN SONU RAPORU',
      subtitle: 'Günlük ciro ve işlem dökümü',
      dateLabel: fmtDateLong(date),
      file: `beyaz-kuafor-gun-sonu-${date}.pdf`
    });
  });

  $('#exportPdfBtn').addEventListener('click', async () => {
    const jobs = filteredJobs.length ? filteredJobs : getJobs();
    if (!jobs.length) { toast('Raporlanacak kayıt yok.', 'err'); return; }
    const from = $('#fFrom').value ? fmtDate($('#fFrom').value) : 'Başlangıç';
    const to = $('#fTo').value ? fmtDate($('#fTo').value) : 'Bugün';
    await exportReportPDF(jobs, {
      title: 'İŞ GEÇMİŞİ RAPORU',
      subtitle: 'Filtrelenmiş işlem listesi',
      dateLabel: `${from} — ${to}`,
      file: 'beyaz-kuafor-is-gecmisi-raporu.pdf'
    });
  });

  /* ==================================================================
     MALİ İŞLEMLER (finans)
  ================================================================== */
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function monthJobsOf(key) {
    return getJobs()
      .filter((j) => (j.date || '').startsWith(key))
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  }

  function dailyBreakdown(jobs) {
    const map = new Map();
    jobs.forEach((j) => {
      const cur = map.get(j.date) || { date: j.date, count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += (j.amount || 0);
      map.set(j.date, cur);
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /* Ayın tüm günleri (grafikte boş günler de görünsün) */
  function monthDayList(key) {
    const [yy, mm] = key.split('-').map(Number);
    const last = new Date(yy, mm, 0).getDate();
    const out = [];
    for (let i = 1; i <= last; i++) out.push(`${key}-${String(i).padStart(2, '0')}`);
    return out;
  }

  function renderChart(el, items) {
    const max = Math.max(...items.map((i) => i.amount), 1);
    el.innerHTML = items.map((it) => `
      <div class="adm-chart__col" title="${escapeHtml(it.label)} — ${money(it.amount)} · ${it.count} işlem">
        <span class="adm-chart__val${it.amount ? '' : ' is-zero'}">${money(it.amount)}</span>
        <div class="adm-chart__track">
          <span class="adm-chart__bar${it.amount ? '' : ' is-zero'}" style="height:${it.amount ? Math.max((it.amount / max) * 100, 3) : 2}%"></span>
        </div>
        <span class="adm-chart__label">${escapeHtml(it.label)}</span>
      </div>`).join('');
  }

  function renderFinance() {
    const jobs = getJobs();
    const today = todayISO();
    const monthKey = today.slice(0, 7);

    const dayJobs = jobs.filter((j) => j.date === today);
    const monthJobs = jobs.filter((j) => (j.date || '').startsWith(monthKey));

    $('#finDayAmount').textContent = money(sum(dayJobs));
    $('#finDayMeta').textContent = `${dayJobs.length} işlem`;
    $('#finMonthAmount').textContent = money(sum(monthJobs));
    $('#finMonthMeta').textContent = `${monthJobs.length} işlem`;
    $('#finTotalAmount').textContent = money(sum(jobs));
    $('#finTotalMeta').textContent = `${jobs.length} işlem`;

    /* Son 30 gün — işlem yapılan günlerin ortalaması */
    const last30 = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const dj = jobs.filter((j) => j.date === isoDate(d));
      last30.push({ amount: sum(dj), count: dj.length });
    }
    const activeDays = last30.filter((x) => x.count > 0);
    $('#finAvgAmount').textContent = money(activeDays.length ? sum(last30) / activeDays.length : 0);
    $('#finAvgMeta').textContent = activeDays.length
      ? `Son 30 gün · ${activeDays.length} işlem günü`
      : 'Son 30 gün';

    /* Günlük grafik — son 14 gün */
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const dj = jobs.filter((j) => j.date === isoDate(d));
      days.push({
        label: d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }),
        amount: sum(dj),
        count: dj.length
      });
    }
    renderChart($('#finDayChart'), days);
    $('#finDayTotal').textContent = money(sum(days));

    /* Aylık grafik — son 12 ay */
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const mj = jobs.filter((j) => (j.date || '').startsWith(key));
      months.push({
        label: d.toLocaleDateString('tr-TR', { month: 'short' }),
        amount: sum(mj),
        count: mj.length
      });
    }
    renderChart($('#finMonthChart'), months);
    $('#finMonthTotal').textContent = money(sum(months));

    /* Bu ay kırılımları */
    const d = reportData(monthJobs);
    $('#finSvcBreak').innerHTML = breakdownHtml(d.services, d.total);
    $('#finMasterBreak').innerHTML = breakdownHtml(d.masters, d.total);

    /* En çok tercih edilen hizmet */
    const counts = {};
    jobs.forEach((j) => servicesOf(j).forEach((s) => { counts[s] = (counts[s] || 0) + 1; }));
    let topSvc = '—', maxSvc = 0;
    for (const k in counts) if (counts[k] > maxSvc) { maxSvc = counts[k]; topSvc = k; }
    $('#finTopService').textContent = topSvc;
    $('#finTopServiceMeta').textContent = `${maxSvc} kez seçildi`;

    /* En çok işlem yapan usta (bu ay) */
    let topMaster = '—', maxM = 0;
    d.masters.forEach((m) => { if (m.count > maxM) { maxM = m.count; topMaster = m.name; } });
    $('#finTopMaster').textContent = topMaster;
    $('#finTopMasterMeta').textContent = `${maxM} işlem · bu ay`;

    /* En yüksek günlük ciro */
    const dayTotals = {};
    jobs.forEach((j) => { dayTotals[j.date] = (dayTotals[j.date] || 0) + (j.amount || 0); });
    let bestDate = null, bestAmt = 0;
    for (const k in dayTotals) if (dayTotals[k] > bestAmt) { bestAmt = dayTotals[k]; bestDate = k; }
    $('#finBestDay').textContent = bestDate ? fmtDate(bestDate) : '—';
    $('#finBestDayMeta').textContent = bestDate ? `${money(bestAmt)} ciro` : 'Kayıt yok';
  }

  $('#finDayEnd').addEventListener('click', () => {
    const openDayEnd = () => {
      $('#dayEndDate').value = todayISO();
      renderDayEnd();
      openModal('dayEndModal');
    };
    if (window.BerberPin) window.BerberPin.require(openDayEnd, 'Gün Sonu Kilidi');
    else openDayEnd();
  });

  $('#finMonthCsv').addEventListener('click', () => {
    const key = todayISO().slice(0, 7);
    const days = dailyBreakdown(monthJobsOf(key));
    if (!days.length) { toast('Bu aya ait kayıt yok.', 'err'); return; }
    const header = ['Tarih', 'İşlem Sayısı', 'Ortalama', 'Ciro'];
    const rows = days.map((dd) => [dd.date, dd.count, money(Math.round(dd.amount / dd.count)), dd.amount]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadBlob('\uFEFF' + csv, `beyaz-kuafor-aylik-${key}.csv`, 'text/csv;charset=utf-8;');
    toast('Aylık CSV indirildi');
  });

  $('#finMonthPdf').addEventListener('click', async () => {
    const key = todayISO().slice(0, 7);
    const jobs = monthJobsOf(key);
    if (!jobs.length) { toast('Bu aya ait kayıt yok.', 'err'); return; }
    const [yy, mm] = key.split('-').map(Number);
    const monthLabel = new Date(yy, mm - 1, 1).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
    await exportMonthlyPDF(jobs, {
      title: 'AYLIK FİNANS RAPORU',
      subtitle: 'Aylık ciro ve işlem dökümü',
      dateLabel: monthLabel,
      monthKey: key,
      file: `beyaz-kuafor-aylik-rapor-${key}.pdf`
    });
  });

  /* ==================================================================
     PDF MOTORU (bağımlılıksız — canvas → JPEG → PDF)
  ================================================================== */
  const R = {
    W: 1240, H: 1754, M: 64,
    ink: '#14161a', ink2: '#4a5160', muted: '#8b93a1', line: '#e5e7ec',
    gold: '#b1892b', gold2: '#d8b04a', goldDeep: '#8f6c1c',
    goldSoft: '#fdf7e9', surface2: '#f7f8fa', danger: '#d92d20'
  };
  const FONT = (w, s) => `${w} ${s}px Inter, "Segoe UI", sans-serif`;
  const SERIF = (w, s) => `${w} ${s}px "Playfair Display", Georgia, serif`;

  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }
  }

  function fitText(ctx, text, maxW) {
    const t = String(text ?? '');
    if (ctx.measureText(t).width <= maxW) return t;
    let s = t;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  function drawHeader(ctx, meta) {
    const { W, M } = R;
    ctx.fillStyle = R.gold2;
    rrect(ctx, M, 50, 54, 54, 15); ctx.fill();
    ctx.fillStyle = '#17181c';
    ctx.font = SERIF(700, 27);
    ctx.textAlign = 'center';
    ctx.fillText('B', M + 27, 86);
    ctx.textAlign = 'left';

    ctx.fillStyle = R.ink;
    ctx.font = SERIF(600, 26);
    ctx.fillText('Beyaz Kuaför', M + 72, 76);
    ctx.fillStyle = R.muted;
    ctx.font = FONT(400, 14);
    ctx.fillText(meta.subtitle, M + 72, 98);

    ctx.textAlign = 'right';
    ctx.fillStyle = R.ink;
    ctx.font = FONT(700, 21);
    ctx.fillText(meta.title, W - M, 76);
    ctx.fillStyle = R.muted;
    ctx.font = FONT(400, 14);
    ctx.fillText(meta.dateLabel, W - M, 98);
    ctx.textAlign = 'left';

    ctx.fillStyle = R.line; ctx.fillRect(M, 126, W - 2 * M, 1);
    ctx.fillStyle = R.gold2; ctx.fillRect(M, 125, 130, 3);
    return 158;
  }

  function drawFooter(ctx, meta, pageNo, pageCount) {
    const { W, M, H } = R;
    ctx.fillStyle = R.line; ctx.fillRect(M, H - 76, W - 2 * M, 1);
    ctx.fillStyle = R.muted; ctx.font = FONT(400, 12);
    ctx.fillText('Beyaz Kuaför · Yönetim Paneli', M, H - 48);
    ctx.textAlign = 'right';
    ctx.fillText(`${meta.generatedAt}  ·  Sayfa ${pageNo}/${pageCount}`, W - M, H - 48);
    ctx.textAlign = 'left';
  }

  function drawKpiRow(ctx, x, y, width, items) {
    const gap = 16;
    const w = (width - gap * (items.length - 1)) / items.length;
    const h = 96;
    items.forEach((it, i) => {
      const bx = x + i * (w + gap);
      ctx.fillStyle = it.gold ? R.goldSoft : R.surface2;
      rrect(ctx, bx, y, w, h, 12); ctx.fill();
      ctx.strokeStyle = it.gold ? '#efdfb6' : R.line;
      ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = R.muted; ctx.font = FONT(700, 11);
      ctx.fillText(String(it.label).toLocaleUpperCase('tr-TR'), bx + 18, y + 30);
      ctx.fillStyle = it.gold ? R.goldDeep : R.ink;
      ctx.font = FONT(700, 30);
      ctx.fillText(fitText(ctx, it.value, w - 36), bx + 18, y + 70);
    });
    return y + h;
  }

  function drawBreakdown(ctx, x, y, w, title, rows, total) {
    const headH = 44;
    const rowH = 34;
    const h = headH + (rows.length ? rows.length * rowH + 10 : 40);
    ctx.fillStyle = '#fff';
    rrect(ctx, x, y, w, h, 12); ctx.fill();
    ctx.strokeStyle = R.line; ctx.lineWidth = 1; ctx.stroke();

    ctx.save();
    rrect(ctx, x, y, w, h, 12); ctx.clip();
    ctx.fillStyle = R.surface2; ctx.fillRect(x, y, w, headH);
    ctx.restore();

    ctx.fillStyle = R.muted; ctx.font = FONT(700, 12);
    ctx.fillText(title.toLocaleUpperCase('tr-TR'), x + 16, y + 27);

    if (!rows.length) {
      ctx.fillStyle = R.muted; ctx.font = FONT(400, 14);
      ctx.fillText('Veri yok', x + 16, y + headH + 28);
      return h;
    }

    const max = Math.max(...rows.map((r) => r.amount), 1);
    rows.forEach((r, i) => {
      const ry = y + headH + 8 + i * rowH;
      ctx.fillStyle = R.ink; ctx.font = FONT(600, 14);
      ctx.fillText(fitText(ctx, r.name, w * 0.45), x + 16, ry + 13);
      ctx.fillStyle = R.muted; ctx.font = FONT(400, 12);
      ctx.textAlign = 'right';
      ctx.fillText(`${r.count} işlem · ${money(r.amount)}`, x + w - 16, ry + 13);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#eef0f4';
      rrect(ctx, x + 16, ry + 21, w - 32, 5, 3); ctx.fill();
      ctx.fillStyle = R.gold2;
      rrect(ctx, x + 16, ry + 21, Math.max((w - 32) * (r.amount / max), 3), 5, 3); ctx.fill();
    });
    return h;
  }

  function drawTableHead(ctx, y, columns) {
    const { W, M } = R;
    ctx.fillStyle = R.surface2;
    ctx.fillRect(M, y, W - 2 * M, 42);
    let cx = M;
    columns.forEach((col) => {
      ctx.fillStyle = R.muted; ctx.font = FONT(700, 12);
      ctx.textAlign = col.align === 'right' ? 'right' : 'left';
      ctx.fillText(col.label.toLocaleUpperCase('tr-TR'), col.align === 'right' ? cx + col.w - 16 : cx + 16, y + 26);
      cx += col.w;
    });
    ctx.textAlign = 'left';
    return y + 42;
  }

  function renderReportPages(jobs, meta) {
    const { W, H, M } = R;
    const pages = [];
    let ctx = null, y = 0;
    const LIMIT = H - 110;

    const newPage = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const cx = c.getContext('2d');
      cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, W, H);
      cx.textBaseline = 'alphabetic';
      pages.push({ canvas: c, ctx: cx });
      ctx = cx;
      y = drawHeader(cx, meta);
    };
    newPage();

    const d = reportData(jobs);
    const topService = d.services[0] ? `${d.services[0].name} (${d.services[0].count})` : '—';

    y = drawKpiRow(ctx, M, y, W - 2 * M, [
      { label: 'Toplam Ciro', value: money(d.total), gold: true },
      { label: 'İşlem Sayısı', value: String(d.count) },
      { label: 'Ortalama Tut', value: money(d.avg) },
      { label: 'En Çok Hizmet', value: topService }
    ]) + 26;

    const colW = (W - 2 * M - 20) / 2;
    const rowsCount = Math.max(d.masters.length, d.services.length);
    const blockH = 44 + (rowsCount ? rowsCount * 34 + 10 : 40);
    if (y + blockH > LIMIT) newPage();
    drawBreakdown(ctx, M, y, colW, 'Usta Bazlı Ciro', d.masters, d.total);
    drawBreakdown(ctx, M + colW + 20, y, colW, 'Hizmet Bazlı Ciro', d.services, d.total);
    y += blockH + 26;

    const columns = [
      { key: 'date', label: 'Tarih', w: 175 },
      { key: 'time', label: 'Saat', w: 105 },
      { key: 'master', label: 'Usta', w: 195 },
      { key: 'services', label: 'Hizmetler', w: W - 2 * M - 175 - 105 - 195 - 165 },
      { key: 'amount', label: 'Tutar', w: 165, align: 'right', strong: true }
    ];

    if (!jobs.length) {
      ctx.fillStyle = R.muted; ctx.font = FONT(400, 16);
      ctx.fillText('Bu tarihte kayıtlı işlem bulunmuyor.', M, y + 40);
      y += 70;
    } else {
      y = drawTableHead(ctx, y, columns);
      jobs.forEach((j, i) => {
        if (y + 46 > LIMIT) { newPage(); y = drawTableHead(ctx, y, columns); }
        if (i % 2 === 1) { ctx.fillStyle = '#fbfbfc'; ctx.fillRect(M, y, W - 2 * M, 46); }
        const row = {
          date: fmtDate(j.date), time: j.time || '—', master: j.master || '—',
          services: servicesOf(j).join(' · '), amount: money(j.amount)
        };
        let cx = M;
        columns.forEach((col) => {
          ctx.fillStyle = col.strong ? R.ink : R.ink2;
          ctx.font = col.strong ? FONT(700, 14) : FONT(400, 14);
          ctx.textAlign = col.align === 'right' ? 'right' : 'left';
          const tx = col.align === 'right' ? cx + col.w - 16 : cx + 16;
          ctx.fillText(fitText(ctx, row[col.key], col.w - 24), tx, y + 29);
          cx += col.w;
        });
        ctx.textAlign = 'left';
        ctx.fillStyle = R.line; ctx.fillRect(M, y + 46, W - 2 * M, 1);
        y += 46;
      });

      if (y + 64 > LIMIT) newPage();
      ctx.fillStyle = R.goldSoft;
      rrect(ctx, M, y + 10, W - 2 * M, 54, 10); ctx.fill();
      ctx.strokeStyle = '#efdfb6'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = R.ink2; ctx.font = FONT(600, 15);
      ctx.fillText(`TOPLAM  ·  ${jobs.length} işlem`, M + 20, y + 43);
      ctx.fillStyle = R.goldDeep; ctx.font = SERIF(700, 26);
      ctx.textAlign = 'right';
      ctx.fillText(money(d.total), W - M - 20, y + 44);
      ctx.textAlign = 'left';
      y += 64;
    }

    pages.forEach((p, i) => drawFooter(p.ctx, meta, i + 1, pages.length));
    return pages;
  }

  async function loadReportFonts() {
    if (!document.fonts || !document.fonts.load) return;
    await Promise.all([
      document.fonts.load('400 14px Inter'),
      document.fonts.load('600 14px Inter'),
      document.fonts.load('700 14px Inter'),
      document.fonts.load('400 11px Inter'),
      document.fonts.load('600 26px "Playfair Display"'),
      document.fonts.load('700 26px "Playfair Display"')
    ]).catch(() => {});
  }

  function canvasToJpegBytes(canvas) {
    const url = canvas.toDataURL('image/jpeg', 0.92);
    const b64 = url.slice(url.indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function buildPdf(images) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let len = 0;
    const pushStr = (s) => { const b = enc.encode(s); chunks.push(b); len += b.length; };
    const pushBytes = (b) => { chunks.push(b); len += b.length; };
    const startObj = () => { offsets.push(len); };

    pushStr('%PDF-1.4\n');
    pushBytes(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    startObj();
    pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    const n = images.length;
    const kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    startObj();
    pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

    for (let i = 0; i < n; i++) {
      const p = 3 + i * 3, c = p + 1, im = p + 2;

      startObj();
      pushStr(`${p} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${c} 0 R >>\nendobj\n`);

      const content = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
      startObj();
      pushStr(`${c} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

      startObj();
      pushStr(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${images[i].w} /Height ${images[i].h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${images[i].data.length} >>\nstream\n`);
      pushBytes(images[i].data);
      pushStr('\nendstream\nendobj\n');
    }

    const xrefPos = len;
    let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((off) => { xref += `${String(off).padStart(10, '0')} 00000 n \n`; });
    xref += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    pushStr(xref);

    const out = new Uint8Array(len);
    let o = 0;
    for (const ch of chunks) { out.set(ch, o); o += ch.length; }
    return out;
  }

  function drawBars(ctx, x, y, w, h, items, showValues = true) {
    const max = Math.max(...items.map((i) => i.amount), 1);
    const gap = 8;
    const n = Math.max(items.length, 1);
    const bw = (w - gap * (n - 1)) / n;
    const areaH = h - 46;
    const valuesFit = bw >= 46;

    items.forEach((it, i) => {
      const bx = x + i * (bw + gap);
      ctx.fillStyle = '#eef0f4';
      rrect(ctx, bx, y + 26, bw, areaH, 5); ctx.fill();
      const bh = it.amount ? Math.max((it.amount / max) * areaH, 4) : 2;
      ctx.fillStyle = it.amount ? R.gold2 : '#dfe3e9';
      rrect(ctx, bx, y + 26 + areaH - bh, bw, bh, 5); ctx.fill();

      ctx.textAlign = 'center';
      if (showValues && valuesFit) {
        ctx.fillStyle = R.ink2; ctx.font = FONT(600, 11);
        ctx.fillText(fitText(ctx, money(it.amount), bw), bx + bw / 2, y + 18);
      }
      ctx.fillStyle = R.muted; ctx.font = FONT(400, 11);
      ctx.fillText(fitText(ctx, it.label, bw), bx + bw / 2, y + h - 6);
      ctx.textAlign = 'left';
    });
  }

  function renderMonthlyPages(jobs, meta) {
    const { W, H, M } = R;
    const pages = [];
    let ctx = null, y = 0;
    const LIMIT = H - 110;

    const newPage = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const cx = c.getContext('2d');
      cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, W, H);
      cx.textBaseline = 'alphabetic';
      pages.push({ canvas: c, ctx: cx });
      ctx = cx;
      y = drawHeader(cx, meta);
    };
    newPage();

    const days = dailyBreakdown(jobs);
    const d = reportData(jobs);
    const avgDay = days.length ? d.total / days.length : 0;
    const best = days.slice().sort((a, b) => b.amount - a.amount)[0];

    y = drawKpiRow(ctx, M, y, W - 2 * M, [
      { label: 'Toplam Ciro', value: money(d.total), gold: true },
      { label: 'İşlem Sayısı', value: String(d.count) },
      { label: 'İşlem Günü', value: String(days.length) },
      { label: 'Günlük Ortalama', value: money(avgDay) }
    ]) + 28;

    /* Günlük ciro dağılımı — ayın tüm günleri */
    const chartH = 216;
    const monthKey = meta.monthKey || (jobs[0] ? jobs[0].date.slice(0, 7) : todayISO().slice(0, 7));
    const dayMap = new Map(days.map((dd) => [dd.date, dd.amount]));
    const chartItems = monthDayList(monthKey).map((iso) => ({
      label: fmtDate(iso),
      amount: dayMap.get(iso) || 0
    }));

    if (y + chartH + 40 > LIMIT) newPage();
    ctx.fillStyle = R.ink; ctx.font = FONT(700, 14);
    ctx.fillText('GÜNLÜK CİRO DAĞILIMI', M, y + 14);
    drawBars(ctx, M, y + 24, W - 2 * M, chartH, chartItems);
    y += chartH + 48;

    /* Kırılımlar */
    const colW = (W - 2 * M - 20) / 2;
    const rowsCount = Math.max(d.masters.length, d.services.length);
    const blockH = 44 + (rowsCount ? rowsCount * 34 + 10 : 40);
    if (y + blockH > LIMIT) newPage();
    drawBreakdown(ctx, M, y, colW, 'Usta Bazlı Ciro', d.masters, d.total);
    drawBreakdown(ctx, M + colW + 20, y, colW, 'Hizmet Bazlı Ciro', d.services, d.total);
    y += blockH + 28;

    /* Gün dökümü tablosu */
    const columns = [
      { key: 'date', label: 'Tarih', w: 260 },
      { key: 'count', label: 'İşlem', w: 160 },
      { key: 'avg', label: 'Ortalama', w: 330 },
      { key: 'amount', label: 'Ciro', w: 362, align: 'right', strong: true }
    ];

    const drawHead = () => { y = drawTableHead(ctx, y, columns); };

    if (!days.length) {
      ctx.fillStyle = R.muted; ctx.font = FONT(400, 16);
      ctx.fillText('Bu ayda kayıtlı işlem bulunmuyor.', M, y + 40);
      y += 70;
    } else {
      drawHead();
      days.forEach((dd, i) => {
        if (y + 46 > LIMIT) { newPage(); drawHead(); }
        if (i % 2 === 1) { ctx.fillStyle = '#fbfbfc'; ctx.fillRect(M, y, W - 2 * M, 46); }
        const row = {
          date: fmtDate(dd.date),
          count: String(dd.count),
          avg: money(Math.round(dd.amount / dd.count)),
          amount: money(dd.amount)
        };
        let cx = M;
        columns.forEach((col) => {
          ctx.fillStyle = col.strong ? R.ink : R.ink2;
          ctx.font = col.strong ? FONT(700, 14) : FONT(400, 14);
          ctx.textAlign = col.align === 'right' ? 'right' : 'left';
          const tx = col.align === 'right' ? cx + col.w - 16 : cx + 16;
          ctx.fillText(fitText(ctx, row[col.key], col.w - 24), tx, y + 29);
          cx += col.w;
        });
        ctx.textAlign = 'left';
        ctx.fillStyle = R.line; ctx.fillRect(M, y + 46, W - 2 * M, 1);
        y += 46;
      });

      if (y + 64 > LIMIT) newPage();
      ctx.fillStyle = R.goldSoft;
      rrect(ctx, M, y + 10, W - 2 * M, 54, 10); ctx.fill();
      ctx.strokeStyle = '#efdfb6'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = R.ink2; ctx.font = FONT(600, 15);
      ctx.fillText(`TOPLAM  ·  ${d.count} işlem  ·  ${days.length} gün`, M + 20, y + 43);
      ctx.fillStyle = R.goldDeep; ctx.font = SERIF(700, 26);
      ctx.textAlign = 'right';
      ctx.fillText(money(d.total), W - M - 20, y + 44);
      ctx.textAlign = 'left';
      y += 64;

      if (best) {
        ctx.fillStyle = R.muted; ctx.font = FONT(400, 13);
        ctx.fillText(`En yüksek gün: ${fmtDate(best.date)} — ${money(best.amount)} (${best.count} işlem)`, M, y + 20);
        y += 30;
      }
    }

    pages.forEach((p, i) => drawFooter(p.ctx, meta, i + 1, pages.length));
    return pages;
  }

  async function exportMonthlyPDF(jobs, meta) {
    const btn = $('#finMonthPdf');
    const label = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span>Rapor hazırlanıyor…</span>'; }
    try {
      await loadReportFonts();
      const fullMeta = {
        ...meta,
        generatedAt: `Rapor: ${new Date().toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })}`
      };
      const pages = renderMonthlyPages(jobs, fullMeta);
      const images = pages.map((p) => ({ data: canvasToJpegBytes(p.canvas), w: p.canvas.width, h: p.canvas.height }));
      downloadBlob(buildPdf(images), meta.file, 'application/pdf');
      toast('Aylık PDF rapor indirildi');
    } catch (err) {
      console.error(err);
      toast('PDF oluşturulamadı.', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }

  async function exportReportPDF(jobs, meta) {
    const btn = $('#dayEndPdf');
    const label = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span>Rapor hazırlanıyor…</span>'; }
    try {
      await loadReportFonts();
      const fullMeta = {
        ...meta,
        generatedAt: `Rapor: ${new Date().toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })}`
      };
      const pages = renderReportPages(jobs, fullMeta);
      const images = pages.map((p) => ({ data: canvasToJpegBytes(p.canvas), w: p.canvas.width, h: p.canvas.height }));
      const pdf = buildPdf(images);
      downloadBlob(pdf, meta.file, 'application/pdf');
      toast('PDF rapor indirildi');
    } catch (err) {
      console.error(err);
      toast('PDF oluşturulamadı.', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }

  /* ==================================================================
     Saat / Klavye
  ================================================================== */
  function tickClock() {
    const now = new Date();
    $('#admClock').textContent = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    $('#admDate').textContent = now.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeAllModals(); return; }
    if (e.key === 'F2') { e.preventDefault(); switchView('pos'); }
    if (e.key === 'F4' && e.shiftKey) { e.preventDefault(); switchView('history'); }
  });

  /* ------------------------------------------------------------------
     Köprü — admin-pay modülünün kullandığı mevcut yardımcılar.
     Yeni modül mevcut fonksiyonları değiştirmez, yalnızca okur.
  ------------------------------------------------------------------ */
  function renderMyStats() {
    if (userRole !== 'usta') return;
    const myName = S.user.name || S.user.username;
    const jobs = getJobs().filter((j) => j.master === myName);
    const today = todayISO();
    const todayJobs = jobs.filter((j) => j.date === today);

    const totalCiro = jobs.reduce((a, j) => a + (j.amount || 0), 0);
    const todayCiro = todayJobs.reduce((a, j) => a + (j.amount || 0), 0);

    const calcShare = (list) => list.reduce((a, j) => {
      if (Number.isInteger(j.masterShareKurus)) return a + (j.masterShareKurus / 100);
      const rate = Number.isInteger(j.commissionRate) ? j.commissionRate : 50;
      return a + ((j.amount || 0) * rate / 100);
    }, 0);

    const todayShare = calcShare(todayJobs);
    const totalShare = calcShare(jobs);

    const elTodayJobs = $('#myTodayJobs');
    const elTodayShare = $('#myTodayShare');
    const elTotalJobs = $('#myTotalJobs');
    const elTotalCiro = $('#myTotalCiro');
    const elTotalShare = $('#myTotalShare');

    if (elTodayJobs) elTodayJobs.textContent = todayJobs.length;
    if (elTodayShare) elTodayShare.textContent = money(todayShare);
    if (elTotalJobs) elTotalJobs.textContent = jobs.length;
    if (elTotalCiro) elTotalCiro.textContent = money(totalCiro);
    if (elTotalShare) elTotalShare.textContent = money(totalShare);
  }

  window.BerberPanel = {
    getJobs, saveJobs, getSvcs, getMasters, saveMasters,
    addMaster, removeMaster, syncUstaUsers,
    renderMasters, renderSettings, renderFinance, renderJobs, renderStats, renderDoneList, renderSummary, renderAll,
    getClosedDays, saveClosedDays,
    money, toast, escapeHtml, todayISO, fmtDate, fmtDateLong,
    svcPrice, servicesOf, switchView, initials
  };

  /* ==================================================================
     Başlat
  ================================================================== */
  /* Oturum kontrolü — giriş yapılmamışsa login.html'e yönlendirilir.
     Sunucuya ulaşılamıyorsa panel çevrimdışı (yalnızca bu tarayıcı) çalışır. */
  const session = await S.requireAuth();
  if (!session) return;

  /* ==================================================================
     Rol tabanlı UI kısıtlamaları
     - usta: sadece Yeni İşlem (pos) görünür; hizmet, fiyat, Onayla
     - owner: tam erişim (mevcut davranış)
   ================================================================== */
  const userRole = S.user && S.user.role;

  function applyRoleUI() {
    if (!userRole) return;
    document.body.classList.add(`adm-role-${userRole}`);

    if (userRole === 'usta') {
      ['ownerBottomNav', 'ownerMoreMenu', 'ownerMobileSnap'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });
    }
      /* Sadece Yeni İşlem (pos) nav item'ı görünür; diğerleri gizli */
      $$('.adm-navitem').forEach((btn) => {
        if (btn.dataset.view !== 'pos') btn.style.display = 'none';
      });
      /* Sayfa başlığını ve alt başlığı usta için düzenle */
      $('#admPageTitle').textContent = 'Yeni İşlem';
      $('#admPageSub').textContent = 'Hizmeti seçin, fiyatı onaylayın ve işlemi kaydedin.';

      /* Usta kendi adıyla işlem yapar — usta seçimini gizle, otomatik ata */
      state.master = S.user.name || S.user.username;
      /* Sadece Usta kartını gizle; Ücret kartı (fiyat +/− butonları) görünür kalsın */
      const masterCard = document.querySelector('.adm-pos__col:nth-child(2) .adm-card:first-child');
      if (masterCard) masterCard.style.display = 'none';

      /* Ekstra hizmet, tutar düzeltme, ödeme yöntemi, gün sonu — gizli */
      const hideSel = [
        '#extraPickBtn', '#extraChips', '#amtPresets',
        '#dayEndBtn', '#addSvcQuick', '#addMasterQuick'
      ];
      hideSel.forEach((sel) => {
        $$(sel).forEach((el) => { el.style.display = 'none'; });
      });

      /* Buton metni: "İşlemi Tamamla" → "Onayla" */
      const completeBtn = $('#completeBtn');
      if (completeBtn) {
        completeBtn.innerHTML = '<svg><use href="#i-check"/></svg> Onayla';
      }

      /* Özette "Usta" satırını gizle — zaten otomatik atanır */
      /* renderSummary içinde usta satırını bastıralım */

      /* Kendi Özetim kartı (Bugünkü işlem, bugünkü pay, toplam işlem, toplam pay) */
      const rightCol = document.querySelector('.adm-pos__col:last-child');
      if (rightCol && !$('#myStatsCard')) {
        const card = document.createElement('section');
        card.className = 'adm-card';
        card.id = 'myStatsCard';
        card.innerHTML = `
          <header class="adm-card__head">
            <div>
              <h2>Kendi Özetim</h2>
              <span class="adm-card__sub">İşlem ve günlük hak ediş (pay) bilgileriniz</span>
            </div>
          </header>
          <div class="adm-card__body adm-card__body--col">
            <div class="adm-kpis" style="grid-template-columns: 1fr 1fr; gap: 8px;">
              <div class="adm-kpi">
                <div class="adm-kpi__body">
                  <span class="adm-kpi__label">Bugünkü İşlem</span>
                  <strong class="adm-kpi__value" id="myTodayJobs">0</strong>
                </div>
              </div>
              <div class="adm-kpi">
                <div class="adm-kpi__body">
                  <span class="adm-kpi__label" style="color:var(--gold);">Bugünkü Payım</span>
                  <strong class="adm-kpi__value" id="myTodayShare" style="color:var(--gold);">0 ₺</strong>
                </div>
              </div>
              <div class="adm-kpi">
                <div class="adm-kpi__body">
                  <span class="adm-kpi__label">Toplam İşlem</span>
                  <strong class="adm-kpi__value" id="myTotalJobs">0</strong>
                </div>
              </div>
              <div class="adm-kpi">
                <div class="adm-kpi__body">
                  <span class="adm-kpi__label">Toplam Hak Ediş</span>
                  <strong class="adm-kpi__value" id="myTotalShare">0 ₺</strong>
                </div>
              </div>
            </div>
          </div>
        `;
        rightCol.appendChild(card);
      }
    }
  }

  applyRoleUI();

  const siteInfo = S.site;
  if (siteInfo && siteInfo.name) {
    const brandName = document.querySelector('.adm-side__brandtext strong');
    if (brandName) brandName.textContent = siteInfo.name;
    const verEl = document.querySelector('.adm-side__ver');
    if (verEl) verEl.textContent = `${siteInfo.name} · Yönetim Paneli v2.0`;
  }
  document.title = `${siteInfo ? siteInfo.name : 'Beyaz Kuaför'} — Yönetim Paneli`;

  renderStats();
  renderServices();
  renderMasters();
  renderExtras();
  renderSummary();
  renderDoneList();
  renderDayStatus();
  tickClock();
  setInterval(tickClock, 15000);

  const initialView = location.hash.replace('#', '');
  if (VIEW_META[initialView]) switchView(initialView, true);

  /* --- Başka cihazda yapılan değişiklikler --- */
  S.onChange((keys) => {
    if (!keys || !keys.length) return;
    renderStats();
    if (currentView === 'pos') { renderMasters(); renderDoneList(); renderDayStatus(); renderSummary(); }
    if (currentView === 'history') renderJobs();
    if (currentView === 'finance') renderFinance();
    if (currentView === 'settings') renderSettings();
    if (window.BerberPay) {
      window.BerberPay.renderPaySettings();
      window.BerberPay.renderMasterAccounts();
      window.BerberPay.renderCash();
    }
  });
})();
