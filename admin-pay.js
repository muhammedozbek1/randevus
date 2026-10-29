/* ==========================================================================
   Beyaz Kuaför — Yönetim Paneli · Ek Modüller
   --------------------------------------------------------------------------
   1) Pay Ayarları   — usta / hizmet bazlı pay oranları + oran geçmişi
   2) Usta Hesapları  — dönemsel hak ediş, ödeme ve bakiye
   3) Kasa            — nakit/kart, gün sonu kapanışı, fark ve düzeltme kaydı

   Tüm parasal değerler KURUŞ cinsinden tam sayı olarak saklanır.
   Mevcut işlem kayıtlarına yalnızca ek alanlar eklenir (geriye dönük uyumlu).
   ========================================================================== */
(() => {
  'use strict';

  const api = window.BerberPanel;
  if (!api) {
    console.warn('[admin-pay] BerberPanel API bulunamadı, modül yüklenmedi.');
    return;
  }

  const { toast } = api;

  /* ------------------------------------------------------------------
     Yeni tablolar (mevcut tablolara dokunulmadan)
  ------------------------------------------------------------------ */
  const KEY = {
    settings: 'beyaz_admin_commission',   // { defaultRate, masterRates, serviceRates }
    history: 'beyaz_admin_rate_history',  // oran değişiklik geçmişi
    payments: 'beyaz_admin_master_payments', // usta ödemeleri
    closings: 'beyaz_admin_cash_closings',   // kasa gün sonu kapanışları
    schema: 'beyaz_admin_schema'         // migration sürümü
  };
  const SCHEMA_VERSION = 2;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const S = window.BerberStore;
  const safeGet = (k) => { try { return S.getRaw(k); } catch { return null; } };
  const safeSet = (k, v) => { try { S.setRaw(k, v); } catch {} };

  const readJSON = (key, fallback) => {
    try {
      const v = JSON.parse(safeGet(key));
      return (v === null || v === undefined) ? fallback : v;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => safeSet(key, JSON.stringify(value));

  /* ------------------------------------------------------------------
     Para — kuruş cinsinden tam sayı
  ------------------------------------------------------------------ */
  const toKurus = (tl) => Math.round((Number(tl) || 0) * 100);
  const fromKurus = (kurus) => Math.round(Number(kurus) || 0) / 100;
  const fmtKurus = (kurus) => {
    const v = fromKurus(kurus);
    const s = Number.isInteger(v)
      ? v.toLocaleString('tr-TR')
      : v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${s} ₺`;
  };
  /** Kuruş üzerinden oranlı pay — tam sayı, floating point hatası yok. */
  const shareOf = (kurus, rate) => Math.round(Math.round(Number(kurus) || 0) * (Number(rate) || 0) / 100);
  const clampRate = (r) => Math.min(100, Math.max(0, Math.round(Number(r) || 0)));

  const uid = (prefix) => `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;

  /* ------------------------------------------------------------------
     Tablo erişimleri
  ------------------------------------------------------------------ */
  const getSettings = () => {
    const s = readJSON(KEY.settings, null);
    return {
      defaultRate: Number.isInteger(s && s.defaultRate) ? s.defaultRate : 50,
      masterRates: (s && typeof s.masterRates === 'object' && s.masterRates) ? s.masterRates : {},
      serviceRates: (s && typeof s.serviceRates === 'object' && s.serviceRates) ? s.serviceRates : {}
    };
  };
  const saveSettings = (s) => writeJSON(KEY.settings, s);

  const getRateHistory = () => readJSON(KEY.history, []);
  const getPayments = () => readJSON(KEY.payments, []);
  const getClosings = () => readJSON(KEY.closings, []);

  const saveRateHistory = (h) => writeJSON(KEY.history, h);
  const savePayments = (p) => writeJSON(KEY.payments, p);
  const saveClosings = (c) => writeJSON(KEY.closings, c);

  /* ------------------------------------------------------------------
     Migration — yeni tablolar + eski işlemlere ek alanlar
     (Mevcut alanların değerleri DEĞİŞTİRİLMEZ, sadece yeni alan eklenir)
  ------------------------------------------------------------------ */
  function migrate() {
    const current = parseInt(safeGet(KEY.schema) || '0', 10);
    if (current >= SCHEMA_VERSION) return;

    /* 1) Yeni tabloları oluştur */
    if (!safeGet(KEY.settings)) {
      writeJSON(KEY.settings, { defaultRate: 50, masterRates: {}, serviceRates: {} });
    }
    if (!safeGet(KEY.history)) writeJSON(KEY.history, []);
    if (!safeGet(KEY.payments)) writeJSON(KEY.payments, []);
    if (!safeGet(KEY.closings)) writeJSON(KEY.closings, []);

    /* 2) Eski işlem kayıtlarına yalnızca yeni (nullable) alanlar ekle */
    const settings = getSettings();
    const jobs = api.getJobs();
    let changed = false;

    const migrated = jobs.map((j) => {
      if (j && typeof j.commissionRate === 'number') return j; // zaten snapshot'lanmış
      changed = true;
      const amountKurus = toKurus(j && j.amount);
      const rate = settings.defaultRate;
      const masterShareKurus = shareOf(amountKurus, rate);
      return {
        ...j,
        amountKurus,
        paymentMethod: j && j.paymentMethod === 'card' ? 'card' : 'cash',
        commissionRate: rate,
        masterShareKurus,
        shopShareKurus: amountKurus - masterShareKurus,
        migrated: true
      };
    });
    if (changed) api.saveJobs(migrated);

    /* 3) Sürüm damgası */
    safeSet(KEY.schema, String(SCHEMA_VERSION));
  }

  /* ------------------------------------------------------------------
     Oran çözümleme — hizmet bazlı > usta bazlı > varsayılan
  ------------------------------------------------------------------ */
  function resolveRate(master, serviceName) {
    const s = getSettings();
    const perMaster = s.serviceRates[master];
    if (perMaster && Number.isInteger(perMaster[serviceName])) return perMaster[serviceName];
    if (Number.isInteger(s.masterRates[master])) return s.masterRates[master];
    return s.defaultRate;
  }

  /* ------------------------------------------------------------------
     İşlem görünümü — eski kayıtlar için geriye dönük uyumlu normalizasyon
  ------------------------------------------------------------------ */
  function jobView(j) {
    const amountKurus = Number.isInteger(j.amountKurus) ? j.amountKurus : toKurus(j.amount);
    const rate = Number.isInteger(j.commissionRate) ? j.commissionRate : getSettings().defaultRate;
    const masterShareKurus = Number.isInteger(j.masterShareKurus) ? j.masterShareKurus : shareOf(amountKurus, rate);
    const shopShareKurus = Number.isInteger(j.shopShareKurus) ? j.shopShareKurus : amountKurus - masterShareKurus;
    return {
      ...j,
      services: api.servicesOf(j),
      amountKurus,
      commissionRate: rate,
      masterShareKurus,
      shopShareKurus,
      paymentMethod: j.paymentMethod === 'card' ? 'card' : 'cash'
    };
  }

  const allJobs = () => api.getJobs().map(jobView);

  /* ==================================================================
     1) PAY AYARLARI
  ================================================================== */
  function logRateChange(scope, master, service, oldRate, newRate) {
    const history = getRateHistory();
    history.unshift({
      id: uid('R'),
      ts: new Date().toISOString(),
      scope,                                   // 'default' | 'master' | 'service'
      master: master || null,
      service: service || null,
      oldRate: oldRate ?? null,
      newRate: newRate ?? null,
      by: 'Yönetici'
    });
    saveRateHistory(history.slice(0, 200));
  }

  function renderPaySettings() {
    const s = getSettings();

    /* Varsayılan oran */
    const defInput = $('#defaultRate');
    if (defInput && document.activeElement !== defInput) defInput.value = s.defaultRate;

    /* Usta oranları */
    const list = $('#masterRateList');
    if (list) {
      list.innerHTML = '';
      const masters = api.getMasters();
      if (!masters.length) {
        list.innerHTML = '<div class="adm-chips__empty">Kayıtlı usta yok</div>';
      }
      masters.forEach((m) => {
        const custom = s.masterRates[m] !== undefined;
        const svcOverrides = s.serviceRates[m] ? Object.keys(s.serviceRates[m]).length : 0;
        const row = document.createElement('div');
        row.className = 'adm-raterow' + (custom ? ' adm-raterow--custom' : '');
        row.innerHTML = `
          <span class="adm-raterow__name">
            ${api.escapeHtml(m)}
            <small>${svcOverrides ? `${svcOverrides} hizmet istisnası` : 'Varsayılan oranı kullanıyor'}</small>
          </span>
          ${svcOverrides ? '<span class="adm-tag adm-tag--gold">Özel</span>' : '<span class="adm-tag adm-tag--gray">Varsayılan</span>'}
          <input class="adm-raterow__input" type="number" min="0" max="100" step="1" inputmode="numeric"
                 value="${custom ? s.masterRates[m] : s.defaultRate}" aria-label="${api.escapeHtml(m)} pay oranı" />
          <span class="adm-raterow__unit">%</span>
          <button type="button" class="adm-iconbtn adm-masterrate-reset" title="Varsayılana dön" ${custom ? '' : 'disabled'}>
            <svg><use href="#i-history"/></svg>
          </button>`;

        const input = row.querySelector('.adm-raterow__input');
        input.addEventListener('change', () => {
          const val = clampRate(input.value);
          input.value = val;
          const st = getSettings();
          const old = st.masterRates[m] !== undefined ? st.masterRates[m] : st.defaultRate;
          if (old === val && st.masterRates[m] === val) { renderPaySettings(); return; }
          st.masterRates[m] = val;
          saveSettings(st);
          logRateChange('master', m, null, old, val);
          toast(`${m} pay oranı %${val} olarak güncellendi`);
          renderPaySettings();
        });

        row.querySelector('.adm-masterrate-reset').addEventListener('click', () => {
          const st = getSettings();
          const old = st.masterRates[m];
          if (old === undefined) return;
          delete st.masterRates[m];
          saveSettings(st);
          logRateChange('master', m, null, old, null);
          toast(`${m} varsayılan orana döndü`);
          renderPaySettings();
        });

        list.appendChild(row);
      });
    }

    /* Hizmet bazlı istisneler */
    const svcList = $('#serviceRateList');
    if (svcList) {
      svcList.innerHTML = '';
      const rows = [];
      Object.keys(s.serviceRates).forEach((m) => {
        Object.keys(s.serviceRates[m]).forEach((svc) => {
          rows.push({ master: m, service: svc, rate: s.serviceRates[m][svc] });
        });
      });
      if (!rows.length) {
        svcList.innerHTML = '<div class="adm-chips__empty">Hizmet bazlı istisna tanımlanmamış</div>';
      }
      rows.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'adm-raterow';
        row.innerHTML = `
          <span class="adm-master__avatar">${api.escapeHtml(api.initials(r.master))}</span>
          <span class="adm-raterow__name">${api.escapeHtml(r.master)}<small>${api.escapeHtml(r.service)}</small></span>
          <span class="adm-raterow__input" style="text-align:right;font-weight:700">%${r.rate}</span>
          <button type="button" class="adm-iconbtn adm-svcrate-del" title="İstisnayı sil">
            <svg><use href="#i-trash"/></svg>
          </button>`;
        row.querySelector('.adm-svcrate-del').addEventListener('click', () => {
          const st = getSettings();
          const old = st.serviceRates[r.master][r.service];
          delete st.serviceRates[r.master][r.service];
          if (!Object.keys(st.serviceRates[r.master]).length) delete st.serviceRates[r.master];
          saveSettings(st);
          logRateChange('service', r.master, r.service, old, null);
          toast('Hizmet istisnası silindi');
          renderPaySettings();
        });
        svcList.appendChild(row);
      });
    }

    /* Master / servis seçenekleri */
    fillSelect('#srMaster', api.getMasters());
    fillSelect('#srService', api.getSvcs().map((x) => x.name));

    /* Oran geçmişi */
    const hBody = $('#rateHistoryBody');
    if (hBody) {
      hBody.innerHTML = '';
      const history = getRateHistory();
      if (!history.length) {
        hBody.innerHTML = '<tr class="adm-table__emptyrow"><td colspan="5" style="text-align:center;padding:24px;color:var(--faint)">Henüz oran değişikliği yapılmadı</td></tr>';
      }
      history.forEach((h) => {
        const scope = h.scope === 'default'
          ? 'Varsayılan'
          : h.scope === 'master'
            ? `${h.master} (usta)`
            : `${h.master} · ${h.service}`;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="adm-nowrap" data-label="Kapsam"><strong>${api.escapeHtml(scope)}</strong></td>
          <td class="adm-nowrap" data-label="Eski">${h.oldRate === null ? '—' : '%' + h.oldRate}</td>
          <td class="adm-nowrap" data-label="Yeni">${h.newRate === null ? '—' : '%' + h.newRate}</td>
          <td class="adm-nowrap" data-label="Değiştiren">${api.escapeHtml(h.by || '—')}</td>
          <td class="adm-nowrap adm-muted" data-label="Tarih">${formatTs(h.ts)}</td>`;
        hBody.appendChild(tr);
      });
    }
  }

  function fillSelect(sel, values) {
    const el = $(sel);
    if (!el) return;
    const current = el.value;
    el.innerHTML = '';
    (values || []).forEach((v) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      el.appendChild(o);
    });
    if (current && (values || []).includes(current)) el.value = current;
  }

  const formatTs = (ts) => {
    try {
      return new Date(ts).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
    } catch { return '—'; }
  };

  /* ==================================================================
     2) USTA HESAPLARI
  ================================================================== */
  const periodState = { key: 'day', from: '', to: '' };

  function resolvePeriod() {
    const today = api.todayISO();
    const d = new Date();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;

    if (periodState.key === 'custom') {
      return {
        from: periodState.from || today,
        to: periodState.to || today
      };
    }
    if (periodState.key === 'day') return { from: today, to: today };
    if (periodState.key === 'week') {
      const start = new Date(d);
      start.setDate(d.getDate() - d.getDay() + 1);
      return { from: iso(start), to: today };
    }
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    return { from: iso(start), to: today };
  }

  const inRange = (date, from, to) => !!date && date >= from && date <= to;

  function paymentsInRange(master, from, to) {
    return getPayments().filter((p) => (!master || p.master === master) && inRange(p.date, from, to));
  }

  function masterAccounts(from, to) {
    const jobs = allJobs().filter((j) => inRange(j.date, from, to));
    const activeMasters = api.getMasters();
    const jobsMasters = jobs.map((j) => j.master).filter(Boolean);
    const masters = Array.from(new Set([...activeMasters, ...jobsMasters]));
    const list = masters.map((m) => {
      const mj = jobs.filter((j) => j.master === m);
      const ciro = mj.reduce((a, j) => a + j.amountKurus, 0);
      const share = mj.reduce((a, j) => a + j.masterShareKurus, 0);
      const shop = mj.reduce((a, j) => a + j.shopShareKurus, 0);
      const paid = paymentsInRange(m, from, to).reduce((a, p) => a + p.amountKurus, 0);
      return {
        master: m,
        count: mj.length,
        ciro,
        share,
        shop,
        paid,
        balance: share - paid,
        jobs: mj
      };
    });
    return list.sort((a, b) => b.share - a.share);
  }

  function renderMasterAccounts() {
    const { from, to } = resolvePeriod();

    const fromInput = $('#maFrom');
    const toInput = $('#maTo');
    if (fromInput && document.activeElement !== fromInput) fromInput.value = from;
    if (toInput && document.activeElement !== toInput) toInput.value = to;

    const accounts = masterAccounts(from, to);
    const totals = accounts.reduce((acc, a) => ({
      count: acc.count + a.count,
      ciro: acc.ciro + a.ciro,
      share: acc.share + a.share,
      shop: acc.shop + a.shop,
      paid: acc.paid + a.paid
    }), { count: 0, ciro: 0, share: 0, shop: 0, paid: 0 });

    setText('#maCount', totals.count);
    setText('#maCiro', fmtKurus(totals.ciro));
    setText('#maShare', fmtKurus(totals.share));
    setText('#maPaid', fmtKurus(totals.paid));
    setText('#maBalance', fmtKurus(totals.share - totals.paid));

    /* Karşılaştırmalı özet tablosu */
    const tbody = $('#masterSummaryBody');
    if (tbody) {
      tbody.innerHTML = '';
      if (!accounts.length || !accounts.some((a) => a.count)) {
        tbody.innerHTML = '<tr class="adm-table__emptyrow"><td colspan="7" style="text-align:center;padding:26px;color:var(--faint)">Bu dönemde kayıt bulunmuyor</td></tr>';
      }
      accounts.forEach((a) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="Usta">
            <span class="adm-table__master"><i>${api.escapeHtml(api.initials(a.master))}</i>${api.escapeHtml(a.master)}</span>
          </td>
          <td class="adm-nowrap" data-label="İşlem Sayısı">${a.count}</td>
          <td class="ta-right adm-nowrap" data-label="Ciro"><strong>${fmtKurus(a.ciro)}</strong></td>
          <td class="ta-right adm-nowrap" data-label="Usta Payı"><strong>${fmtKurus(a.share)}</strong></td>
          <td class="ta-right adm-nowrap adm-muted" data-label="Dükkan Payı">${fmtKurus(a.shop)}</td>
          <td class="ta-right adm-nowrap" data-label="Ödenen">${fmtKurus(a.paid)}</td>
          <td class="ta-right adm-nowrap" data-label="Kalan">
            <strong style="color:${a.balance > 0 ? 'var(--danger)' : a.balance < 0 ? 'var(--ok)' : 'var(--text)'}">${fmtKurus(a.balance)}</strong>
          </td>`;
        tbody.appendChild(tr);
      });
    }

    /* Detay: seçili usta */
    const select = $('#masterSelect');
    if (select) {
      const current = select.value;
      fillSelect('#masterSelect', accounts.map((a) => a.master));
      if (current && accounts.some((a) => a.master === current)) select.value = current;
    }
    const selected = (select && select.value) || (accounts[0] && accounts[0].master) || '';
    renderMasterDetail(selected, from, to);
  }

  function renderMasterDetail(master, from, to) {
    const jobs = allJobs()
      .filter((j) => j.master === master && inRange(j.date, from, to))
      .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
    const payments = paymentsInRange(master, from, to).sort((a, b) => b.date.localeCompare(a.date));

    const ciro = jobs.reduce((a, j) => a + j.amountKurus, 0);
    const share = jobs.reduce((a, j) => a + j.masterShareKurus, 0);
    const shop = jobs.reduce((a, j) => a + j.shopShareKurus, 0);
    const paid = payments.reduce((a, p) => a + p.amountKurus, 0);
    const balance = share - paid;

    setText('#mdSub', master ? `${master} · ${api.fmtDate(from)} — ${api.fmtDate(to)}` : 'Usta seçilmedi');

    const stats = $('#masterStats');
    if (stats) {
      stats.innerHTML = `
        <div class="adm-mstat"><span>İşlem</span><strong>${jobs.length}</strong></div>
        <div class="adm-mstat"><span>Toplam Ciro</span><strong>${fmtKurus(ciro)}</strong></div>
        <div class="adm-mstat adm-mstat--gold"><span>Hak Ediş</span><strong>${fmtKurus(share)}</strong></div>
        <div class="adm-mstat"><span>Dükkan Payı</span><strong>${fmtKurus(shop)}</strong></div>
        <div class="adm-mstat adm-mstat--ok"><span>Ödenen</span><strong>${fmtKurus(paid)}</strong></div>
        <div class="adm-mstat ${balance > 0 ? 'adm-mstat--danger' : 'adm-mstat--ok'}"><span>Kalan</span><strong>${fmtKurus(balance)}</strong></div>`;
    }

    /* İşlem listesi */
    const tbody = $('#masterJobsBody');
    if (tbody) {
      tbody.innerHTML = '';
      if (!jobs.length) {
        tbody.innerHTML = '<tr class="adm-table__emptyrow"><td colspan="5" style="text-align:center;padding:24px;color:var(--faint)">Bu dönemde işlem yok</td></tr>';
      }
      jobs.forEach((j) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="adm-nowrap adm-table__date" data-label="Tarih">${api.fmtDate(j.date)}</td>
          <td class="adm-table__svc" data-label="Hizmetler">${api.escapeHtml(j.services.join(' · '))}</td>
          <td class="ta-right adm-nowrap" data-label="Ücret"><strong>${fmtKurus(j.amountKurus)}</strong></td>
          <td class="ta-right adm-nowrap" data-label="Oran"><span class="adm-tag adm-tag--gold">%${j.commissionRate}</span></td>
          <td class="ta-right adm-nowrap" data-label="Usta Payı"><strong>${fmtKurus(j.masterShareKurus)}</strong></td>`;
        tbody.appendChild(tr);
      });
    }

    /* Ödeme listesi */
    const payList = $('#masterPayments');
    if (payList) {
      payList.innerHTML = '';
      if (!payments.length) {
        payList.innerHTML = '<div class="adm-chips__empty">Bu dönemde ödeme kaydı yok</div>';
      }
      payments.forEach((p) => {
        const item = document.createElement('div');
        item.className = 'adm-payitem';
        item.innerHTML = `
          <span class="adm-master__avatar">${api.escapeHtml(api.initials(p.master))}</span>
          <div class="adm-payitem__body">
            <strong>${fmtKurus(p.amountKurus)}</strong>
            <span>${api.fmtDate(p.date)}${p.note ? ' · ' + api.escapeHtml(p.note) : ''}</span>
          </div>
          <button type="button" class="adm-payitem__del" title="Ödemeyi sil">
            <svg><use href="#i-trash"/></svg>
          </button>`;
        item.querySelector('.adm-payitem__del').addEventListener('click', () => {
          if (!confirm('Bu ödeme kaydı silinsin mi?')) return;
          savePayments(getPayments().filter((x) => x.id !== p.id));
          toast('Ödeme kaydı silindi');
          renderMasterAccounts();
        });
        payList.appendChild(item);
      });
    }
  }

  function setText(sel, text) {
    const el = $(sel);
    if (el) el.textContent = text;
  }

  /* ==================================================================
     3) KASA
  ================================================================== */
  function cashOf(date) {
    const jobs = allJobs().filter((j) => j.date === date);
    const cash = jobs.filter((j) => j.paymentMethod === 'cash').reduce((a, j) => a + j.amountKurus, 0);
    const card = jobs.filter((j) => j.paymentMethod === 'card').reduce((a, j) => a + j.amountKurus, 0);
    const paid = getPayments().filter((p) => p.date === date).reduce((a, p) => a + p.amountKurus, 0);
    return { jobs, cash, card, total: cash + card, paid };
  }

  /** Kapanış kaydı — yeniden açılmış olanlar hariç (gün kilitli mi?) */
  const closingFor = (date) => getClosings().find((c) => c.date === date && !c.reopened);
  const isLocked = (date) => !!closingFor(date);

  /** Tarihin kapanış kaydı (yeniden açılmış olsa bile) */
  const closingRecord = (date) => getClosings().find((c) => c.date === date);

  /** Eski "kapatılan günler" listesi ile uyum */
  const syncLegacyClosed = (date, closed) => {
    if (!api.getClosedDays || !api.saveClosedDays) return;
    const list = api.getClosedDays().filter((d) => d !== date);
    if (closed) list.push(date);
    api.saveClosedDays(list);
  };

  /**
   * Kapatılmış günü yeniden açar — yeni işlem alınabilir hale gelir.
   * Kapanış kaydı geçmiş olarak saklanır, "yeniden açıldı" düzeltmesi eklenir.
   */
  function reopenDay(date) {
    const closing = closingRecord(date);
    if (!closing || closing.reopened) return false;

    const reason = prompt(
      `${api.fmtDate(date)} günü yeniden açılacak.\n` +
      'Bu güne ait kapanış kaydı geçmişte kalır, gün tekrar işlem almaya açılır.\n\n' +
      'Gerekçe:',
      ''
    );
    if (!reason || !reason.trim()) {
      toast('Gerekçe girilmedi, işlem iptal edildi.', 'err');
      return false;
    }

    const closings = getClosings();
    const idx = closings.findIndex((c) => c.id === closing.id);
    closings[idx] = {
      ...closings[idx],
      reopened: true,
      reopenedAt: new Date().toISOString(),
      reopenReason: reason.trim(),
      corrections: closings[idx].corrections || []
    };
    closings[idx].corrections.push({
      ts: new Date().toISOString(),
      action: 'Gün yeniden açıldı',
      detail: 'Gün tekrar işlem almaya açıldı',
      reason: reason.trim(),
      by: 'Yönetici'
    });
    saveClosings(closings);
    syncLegacyClosed(date, false);
    toast(`${api.fmtDate(date)} yeniden açıldı`);
    return true;
  }

  /** Günü kapatır (Gün Sonu raporundan) */
  function closeDay(date) {
    const data = cashOf(date);
    const closings = getClosings();
    const existing = closingRecord(date);
    const payload = {
      id: existing ? existing.id : uid('C'),
      date,
      expectedCashKurus: data.cash,
      expectedCardKurus: data.card,
      expectedTotalKurus: data.total,
      actualCashKurus: existing && !existing.reopened ? existing.actualCashKurus : data.cash,
      actualCardKurus: 0,
      differenceKurus: 0,
      paidToMastersKurus: data.paid,
      note: existing ? (existing.note || '') : '',
      closedAt: new Date().toISOString(),
      corrections: existing ? (existing.corrections || []) : []
    };
    if (existing) {
      payload.corrections.push({
        ts: new Date().toISOString(),
        action: 'Gün kapatıldı',
        detail: `Sistemdeki nakit ${fmtKurus(data.cash)}`,
        reason: 'Gün sonu raporundan kapatıldı',
        by: 'Yönetici'
      });
      const idx = closings.findIndex((c) => c.id === existing.id);
      closings[idx] = payload;
    } else {
      closings.push(payload);
    }
    saveClosings(closings);
    syncLegacyClosed(date, true);
    toast(`${api.fmtDate(date)} kapatıldı`);
    return true;
  }

  /** Kapat / aç arasında geçiş yapar */
  function toggleDay(date) {
    if (isLocked(date)) return reopenDay(date);
    return closeDay(date);
  }

  function renderCash() {
    const today = api.todayISO();
    const dateInput = $('#cashDate');
    if (dateInput && document.activeElement !== dateInput) dateInput.value = cashState.date;

    const data = cashOf(cashState.date);
    const closing = closingFor(cashState.date);

    /* Özet kartları */
    setText('#cashTotalAmount', fmtKurus(data.total));
    setText('#cashCashAmount', fmtKurus(data.cash));
    setText('#cashCardAmount', fmtKurus(data.card));
    setText('#cashPaidAmount', fmtKurus(data.paid));
    setText('#cashJobCount', `${data.jobs.length} işlem · ${api.fmtDate(cashState.date)}`);
    setText('#cashDayLabel', api.fmtDate(cashState.date));

    /* Günün işlem dökümü */
    const jobsBody = $('#cashJobsBody');
    if (jobsBody) {
      jobsBody.innerHTML = '';
      if (!data.jobs.length) {
        jobsBody.innerHTML = '<tr class="adm-table__emptyrow"><td colspan="5" style="text-align:center;padding:26px;color:var(--faint)">Bu gün kayıtlı işlem yok</td></tr>';
      }
      data.jobs
        .slice()
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
        .forEach((j) => {
          const tr = document.createElement('tr');
          const isCard = j.paymentMethod === 'card';
          tr.innerHTML = `
            <td class="adm-table__time" data-label="Saat">${j.time || '—'}</td>
            <td class="adm-nowrap" data-label="Usta">${api.escapeHtml(j.master || '—')}</td>
            <td class="adm-table__svc" data-label="Hizmetler">${api.escapeHtml(j.services.join(' · '))}</td>
            <td data-label="Tahsilat"><span class="adm-tag ${isCard ? 'adm-tag--gold' : 'adm-tag--ok'}">${isCard ? 'Kart' : 'Nakit'}</span></td>
            <td class="ta-right adm-nowrap" data-label="Tutar"><strong>${fmtKurus(j.amountKurus)}</strong></td>`;
          jobsBody.appendChild(tr);
        });
    }

    /* Sayılan nakit ↔ sistemdeki nakit */
    setText('#cashSystemCash', fmtKurus(data.cash));

    const actualCashInput = $('#cashActualCash');
    const noteInput = $('#cashNote');
    if (actualCashInput) {
      if (!cashState.actualTouched) {
        /* Kullanıcı alana dokunmadıysa kayıtlı kapanıştan doldur */
        actualCashInput.value = closing ? fromKurus(closing.actualCashKurus) : '';
        if (noteInput) noteInput.value = closing ? (closing.note || '') : '';
      }
    }

    const actualCash = toKurus(actualCashInput ? actualCashInput.value : 0);
    const diffCash = actualCash - data.cash;

    const diffBox = $('#cashDiff');
    if (diffBox) {
      const filled = actualCashInput && String(actualCashInput.value).trim() !== '';
      if (!filled) {
        diffBox.className = 'adm-diffbox adm-diffbox--idle';
        diffBox.innerHTML = '<span>Kasayı sayın</span><strong>—</strong>';
      } else {
        const cls = diffCash === 0 ? 'adm-diffbox--ok' : diffCash < 0 ? 'adm-diffbox--short' : 'adm-diffbox--over';
        const label = diffCash === 0 ? 'Fark yok' : diffCash < 0 ? 'Kasada eksik' : 'Kasada fazla';
        diffBox.className = `adm-diffbox ${cls}`;
        diffBox.innerHTML = `<span>${label}</span><strong>${fmtKurus(Math.abs(diffCash))}</strong>`;
      }
    }

    /* Kapanış durumu */
    const status = $('#cashStatus');
    if (status) {
      if (closing) {
        status.innerHTML = `<div class="adm-info"><svg><use href="#i-check"/></svg>
          <span><strong>${api.fmtDate(cashState.date)}</strong> günü kapatıldı. Bu gün için yeni işlem alınamaz.
          Aşağıdaki <em>Günü Yeniden Aç</em> düğmesiyle günü tekrar işlem almaya açabilirsiniz.</span></div>`;
      } else {
        status.innerHTML = `<div class="adm-info"><svg><use href="#i-flag"/></svg>
          <span><strong>${api.fmtDate(cashState.date)}</strong> günü henüz kapatılmadı.
          Kasadaki nakit sayılıp girildiğinde gün kapatılabilir.</span></div>`;
      }
    }

    /* Kapat / yeniden aç düğmesi */
    const closeBtn = $('#cashCloseBtn');
    const closeLabel = $('#cashCloseLabel');
    if (closeBtn && closeLabel) {
      closeLabel.textContent = closing ? 'Günü Yeniden Aç' : 'Günü Kapat';
      closeBtn.classList.toggle('adm-btn--primary', !closing);
      closeBtn.classList.toggle('adm-btn--outline', !!closing);
    }

    /* Düzeltme listesi */
    const corrBox = $('#cashCorrections');
    if (corrBox) {
      corrBox.innerHTML = '';
      if (!closing || !closing.corrections || !closing.corrections.length) {
        corrBox.innerHTML = '';
      } else {
        closing.corrections.forEach((c) => {
          const div = document.createElement('div');
          div.className = 'adm-correction';
          div.innerHTML = `
            <div class="adm-correction__body">
              <strong>${api.escapeHtml(c.action)}</strong>
              <span>${api.escapeHtml(c.detail || '')}</span>
              <span>Gerekçe: ${api.escapeHtml(c.reason || '—')}</span>
            </div>
            <span class="adm-correction__time">${formatTs(c.ts)}</span>`;
          corrBox.appendChild(div);
        });
      }
    }

    /* Geçmiş kapanışlar */
    const list = $('#cashClosings');
    if (list) {
      list.innerHTML = '';
      const closings = getClosings().sort((a, b) => b.date.localeCompare(a.date));
      if (!closings.length) {
        list.innerHTML = '<div class="adm-chips__empty" style="padding:24px">Henüz kasa kapanışı yapılmadı</div>';
      }
      closings.forEach((c) => {
        const diff = c.actualCashKurus - c.expectedCashKurus;
        const cls = diff === 0 ? 'adm-tag--ok' : diff < 0 ? 'adm-tag--danger' : 'adm-tag--gold';
        const label = diff === 0 ? 'Dengede' : diff < 0 ? 'Eksik' : 'Fazla';
        const div = document.createElement('div');
        div.className = 'adm-closing';
        div.innerHTML = `
          <span class="adm-closing__date">${api.fmtDate(c.date)}</span>
          <span class="adm-navitem__badge" style="margin-left:0">${label}</span>
          <div class="adm-closing__nums">
            <span class="adm-closing__num"><span>Sistem</span><strong>${fmtKurus(c.expectedCashKurus)}</strong></span>
            <span class="adm-closing__num"><span>Kasada</span><strong>${fmtKurus(c.actualCashKurus)}</strong></span>
            <span class="adm-closing__num"><span>Fark</span><strong>${fmtKurus(Math.abs(diff))}</strong></span>
            <span class="adm-closing__num"><span>Ustalara</span><strong>${fmtKurus(c.paidToMastersKurus)}</strong></span>
          </div>
          ${c.note ? `<span class="adm-muted" style="font-size:12px">${api.escapeHtml(c.note)}</span>` : ''}
          ${c.corrections && c.corrections.length ? `<span class="adm-tag adm-tag--danger">${c.corrections.length} düzeltme</span>` : ''}`;
        list.appendChild(div);
      });
    }
  }

  const cashState = { date: api.todayISO(), actualTouched: false };

  /* ---- Kapanış / düzeltme işlemleri ---- */
  function saveClosing() {
    const date = cashState.date;

    /* Gün zaten kapatılmışsa düğme "Günü Yeniden Aç" olarak çalışır */
    if (isLocked(date)) {
      if (reopenDay(date)) {
        cashState.actualTouched = false;
        renderCash();
      }
      return;
    }

    const data = cashOf(date);
    const actualCash = toKurus($('#cashActualCash').value);
    const note = ($('#cashNote').value || '').trim();
    const existing = closingRecord(date);

    if (!String($('#cashActualCash').value || '').trim()) {
      toast('Kasadaki nakit girilmeden gün kapatılamaz.', 'err');
      return;
    }

    const payload = {
      id: existing ? existing.id : uid('C'),
      date,
      expectedCashKurus: data.cash,
      expectedCardKurus: data.card,
      expectedTotalKurus: data.total,
      actualCashKurus: actualCash,
      actualCardKurus: 0,
      differenceKurus: actualCash - data.cash,
      paidToMastersKurus: data.paid,
      note,
      closedAt: new Date().toISOString(),
      reopened: false,
      corrections: existing ? (existing.corrections || []) : []
    };

    const closings = getClosings();
    if (existing) {
      /* Daha önce kapatılıp yeniden açılmış bir gün — tekrar kapanıyor */
      payload.corrections.push({
        ts: new Date().toISOString(),
        action: 'Kapanış kaydı güncellendi',
        detail: `Sistemdeki nakit ${fmtKurus(data.cash)} → Kasadaki nakit ${fmtKurus(actualCash)}`,
        reason: 'Kasa bölümünden yeniden kapatıldı',
        by: 'Yönetici'
      });
      const idx = closings.findIndex((c) => c.id === existing.id);
      closings[idx] = payload;
      toast('Kapanış kaydı güncellendi');
    } else {
      closings.push(payload);
      toast('Gün kapatıldı');
    }
    saveClosings(closings);
    syncLegacyClosed(date, true);
    cashState.actualTouched = true;
    renderCash();
  }

  function recordCorrection(action, detail) {
    const reason = prompt(
      `Bu gün kasa kapanışı yapılmış (${api.fmtDate(cashState.date)}).\n` +
      'Değişiklik sessizce yapılmayacak; düzeltme kaydı tutulacak.\n\nGerekçe:',
      ''
    );
    if (!reason || !reason.trim()) {
      toast('Düzeltme gerekçesi girilmedi, işlem iptal edildi.', 'err');
      return false;
    }
    const closings = getClosings();
    const closing = closings.find((c) => c.date === cashState.date);
    if (closing) {
      closing.corrections = closing.corrections || [];
      closing.corrections.push({
        ts: new Date().toISOString(),
        action,
        detail,
        reason: reason.trim(),
        by: 'Yönetici'
      });
      saveClosings(closings);
      toast('Düzeltme kaydı oluşturuldu');
    }
    return true;
  }

  /* ------------------------------------------------------------------
     Köprü — admin.js'in çağırabileceği minimum API
  ------------------------------------------------------------------ */
  const buildJobFields = ({ master, services, amount }) => {
    const lines = (services || []).map((name) => {
      const priceKurus = toKurus(api.svcPrice(name));
      const rate = resolveRate(master, name);
      const masterShareKurus = shareOf(priceKurus, rate);
      return {
        service: name,
        priceKurus,
        rate,
        masterShareKurus,
        shopShareKurus: priceKurus - masterShareKurus
      };
    });

    const totalKurus = toKurus(amount);
    const linesTotal = lines.reduce((a, l) => a + l.priceKurus, 0);
    const adjustmentKurus = totalKurus - linesTotal;

    let masterShareKurus = lines.reduce((a, l) => a + l.masterShareKurus, 0);
    let shopShareKurus = lines.reduce((a, l) => a + l.shopShareKurus, 0);

    /* Manuel tutar düzeltmesi snapshot'a da yansıtılır */
    if (adjustmentKurus !== 0 && lines.length) {
      const r = lines[0].rate;
      const extra = shareOf(adjustmentKurus, r);
      masterShareKurus += extra;
      shopShareKurus += adjustmentKurus - extra;
    }

    return {
      amountKurus: totalKurus,
      paymentMethod: payState.method,
      commissionRate: lines.length ? lines[0].rate : getSettings().defaultRate,
      masterShareKurus,
      shopShareKurus,
      commissionLines: lines,
      adjustmentKurus
    };
  };

  const payState = { method: 'cash' };

  /* ------------------------------------------------------------------
     Uygulama — event bağlantıları
  ------------------------------------------------------------------ */
  async function init() {
    /* Oturum + sunucu verisi hazır olmadan tablolara dokunma */
    const ok = await S.requireAuth();
    if (!ok) return;

    migrate();

    /* --- Ödeme yöntemi (mevcut işlem akışına ek alan) --- */
    const seg = $('#payMethod');
    if (seg) {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('.adm-segment__btn');
        if (!btn) return;
        payState.method = btn.dataset.method;
        $$('.adm-segment__btn', seg).forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    }

    /* --- Pay Ayarları --- */
    const defInput = $('#defaultRate');
    if (defInput) {
      defInput.addEventListener('change', () => {
        const val = clampRate(defInput.value);
        defInput.value = val;
        const s = getSettings();
        const old = s.defaultRate;
        if (old === val) return;
        s.defaultRate = val;
        saveSettings(s);
        logRateChange('default', null, null, old, val);
        toast(`Varsayılan pay oranı %${val} olarak güncellendi`);
        renderPaySettings();
      });
    }

    const addRate = $('#addServiceRate');
    if (addRate) {
      addRate.addEventListener('click', () => {
        const m = $('#srMaster').value;
        const svc = $('#srService').value;
        const val = clampRate($('#srRate').value);
        if (!m || !svc) { toast('Usta ve hizmet seçin.', 'err'); return; }
        const s = getSettings();
        s.serviceRates[m] = s.serviceRates[m] || {};
        const old = s.serviceRates[m][svc];
        s.serviceRates[m][svc] = val;
        saveSettings(s);
        logRateChange('service', m, svc, old === undefined ? null : old, val);
        $('#srRate').value = '';
        toast(`${m} · ${svc} için %${val} istisnası eklendi`);
        renderPaySettings();
      });
    }

    /* --- Usta Hesapları --- */
    $$('.adm-period-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.adm-period-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        periodState.key = btn.dataset.period;
        renderMasterAccounts();
      });
    });
    const maFrom = $('#maFrom');
    const maTo = $('#maTo');
    if (maFrom) maFrom.addEventListener('change', () => { periodState.from = maFrom.value; renderMasterAccounts(); });
    if (maTo) maTo.addEventListener('change', () => { periodState.to = maTo.value; renderMasterAccounts(); });

    const masterSelect = $('#masterSelect');
    if (masterSelect) masterSelect.addEventListener('change', () => renderMasterAccounts());

    const payBtn = $('#addPaymentBtn');
    if (payBtn) {
      payBtn.addEventListener('click', () => {
        const master = $('#masterSelect').value;
        if (!master) { toast('Usta seçin.', 'err'); return; }
        const amount = parseFloat($('#paymentAmount').value);
        if (!amount || amount <= 0) { toast('Ödeme tutarı girin.', 'err'); return; }
        const date = $('#paymentDate').value || api.todayISO();
        const note = ($('#paymentNote').value || '').trim();
        const payments = getPayments();
        payments.push({
          id: uid('P'),
          date,
          master,
          amountKurus: toKurus(amount),
          note,
          ts: new Date().toISOString()
        });
        savePayments(payments);
        $('#paymentAmount').value = '';
        $('#paymentNote').value = '';
        toast(`${master} için ${fmtKurus(toKurus(amount))} ödeme kaydedildi`);
        renderMasterAccounts();
      });
    }

    /* --- Kasa --- */
    const cashDate = $('#cashDate');
    if (cashDate) cashDate.addEventListener('change', () => {
      cashState.date = cashDate.value || api.todayISO();
      cashState.actualTouched = false;
      renderCash();
    });

    const actualCash = $('#cashActualCash');
    if (actualCash) actualCash.addEventListener('input', () => { cashState.actualTouched = true; renderCash(); });

    const closeBtn = $('#cashCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', saveClosing);

    /* --- Menü: yeni sekmeler --- */
    $$('.adm-navitem[data-view="pay"], .adm-navitem[data-view="masters"], .adm-navitem[data-view="kasa"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === 'pay') renderPaySettings();
        if (view === 'masters') renderMasterAccounts();
        /* Kasa ekranı PIN arkasında — kilitliyken veriyi çizme */
        if (view === 'kasa' && window.BerberPin && !window.BerberPin.isUnlocked()) return;
        if (view === 'kasa') renderCash();
      });
    });

    /* --- İlk render (gizliyken de hesaplanabilsin) --- */
    renderPaySettings();
    renderMasterAccounts();
    /* Kasa verisi yalnızca PIN açıldıktan sonra çizilir */
    if (!window.BerberPin || window.BerberPin.isUnlocked()) renderCash();

    const today = api.todayISO();
    const payDate = $('#paymentDate');
    if (payDate && !payDate.value) payDate.value = today;
  }

  /* ------------------------------------------------------------------
     Dışa açılan köprü (admin.js tarafından kullanılır)
  ------------------------------------------------------------------ */
  window.BerberPay = {
    isLockedDate: (date) => isLocked(date),
    isDayClosed: (date) => isLocked(date),
    reopenDay,
    closeDay,
    toggleDay,
    checkTransactionAllowed: () => {
      const today = api.todayISO();
      if (isLocked(today)) {
        return {
          ok: false,
          reason: `${api.fmtDate(today)} günü kapatıldığı için yeni işlem alınamaz. Aşağıdaki "Günü Yeniden Aç" düğmesiyle günü tekrar açabilirsiniz.`
        };
      }
      return { ok: true };
    },
    guardDelete: (job) => {
      const date = job && job.date;
      if (!date || !isLocked(date)) return true;
      cashState.date = date;
      const ok = recordCorrection(
        'Kapatılmış güne ait işlem silindi',
        `${job.master || '—'} · ${api.fmtDate(date)} · ${job.service || ''} · ${api.money(job.amount || 0)}`
      );
      return ok;
    },
    buildJobFields,
    setPaymentMethod: (m) => {
      payState.method = m === 'card' ? 'card' : 'cash';
      $$('.adm-segment__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.method === payState.method));
    },
    renderCash,
    renderMasterAccounts,
    renderPaySettings,
    migrate
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
