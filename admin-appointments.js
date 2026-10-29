/* ==========================================================================
   Beyaz Kuaför — Panel: Online Randevular
   --------------------------------------------------------------------------
   Müşteri randevu formundan gelen randevuları sunucudan okur, listeler ve
   iptal işlemini yapar. Veri aynı store katmanı üzerinden gelir; bu yüzden
   başka cihazda alınan randevular 10 sn'de bir otomatik yenilenir.
   ========================================================================== */
(() => {
  'use strict';

  const store = window.BerberStore;
  if (!store) return;

  const KEY = 'beyaz_kuafor_randevular';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso + 'T00:00:00').toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric', weekday: 'long' });
  };
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  let filterDate = '';
  let onlyActive = true;

  const allAppts = () => store.getJSON(KEY, []);

  function render() {
    const box = $('#apptAdminList');
    if (!box) return;

    let list = allAppts().slice();

    if (filterDate) list = list.filter((a) => a.date === filterDate);
    if (onlyActive) list = list.filter((a) => a.status !== 'cancelled');

    list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    /* Rozet: yaklaşan randevu sayısı */
    const pending = allAppts().filter((a) => a.status !== 'cancelled' && a.date >= todayISO()).length;
    document.querySelectorAll('.js-badge-appt').forEach((badge) => {
      badge.textContent = pending;
      badge.style.display = pending ? '' : 'none';
    });

    if (!list.length) {
      box.innerHTML = `<div class="adm-donelist__empty">
        <svg><use href="#i-cal"/></svg>
        <p>Randevu bulunamadı</p>
        <span>${filterDate ? 'Bu tarihe ait randevu yok.' : 'Müşteriler site üzerinden randevu aldığında burada görünür.'}</span>
      </div>`;
      return;
    }

    box.innerHTML = '';
    list.forEach((a) => {
      const cancelled = a.status === 'cancelled';
      const row = document.createElement('div');
      row.className = 'adm-apptrow' + (cancelled ? ' is-cancelled' : '');
      row.innerHTML = `
        <div class="adm-apptrow__time">
          <strong>${escapeHtml(a.time || '--:--')}</strong>
          <span>${escapeHtml(fmtDate(a.date))}</span>
        </div>
        <div class="adm-apptrow__body">
          <div class="adm-apptrow__top">
            <span class="adm-apptrow__name">${escapeHtml(a.name || '—')}</span>
            <span class="adm-apptrow__svc">${escapeHtml(a.service || '')}</span>
          </div>
          <div class="adm-apptrow__meta">
            <a href="tel:${escapeHtml(String(a.phone || '').replace(/\s/g, ''))}">${escapeHtml(a.phone || '—')}</a>
            ${a.note ? `<span>· ${escapeHtml(a.note)}</span>` : ''}
          </div>
        </div>
        <div class="adm-apptrow__actions">
          ${cancelled
            ? '<span class="adm-apptrow__badge adm-apptrow__badge--off">İptal</span>'
            : '<button type="button" class="adm-btn adm-btn--outline adm-btn--sm" data-cancel="' + escapeHtml(a.id) + '">İptal Et</button>'}
        </div>`;
      box.appendChild(row);
    });

    $$('[data-cancel]', box).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.cancel;
        if (!confirm('Bu randevu iptal edilsin mi?')) return;
        btn.disabled = true;
        try {
          await store.appts.cancel(id);
          toast('Randevu iptal edildi');
          render();
        } catch (err) {
          toast(err.message || 'İptal edilemedi', 'err');
          btn.disabled = false;
        }
      });
    });
  }

  function toast(msg, kind = 'ok') {
    if (window.BerberPanel && window.BerberPanel.toast) window.BerberPanel.toast(msg, kind);
  }

  /* ------------------------------------------------------------------
     Filtreler
  ------------------------------------------------------------------ */
  const dateInput = $('#apptDate');
  if (dateInput) {
    dateInput.addEventListener('change', () => { filterDate = dateInput.value; render(); });
  }
  const allBtn = $('#apptAllBtn');
  if (allBtn) {
    allBtn.addEventListener('click', () => {
      filterDate = '';
      if (dateInput) dateInput.value = '';
      render();
    });
  }

  /* ------------------------------------------------------------------
     Sekme açılışında listeyi yenile
  ------------------------------------------------------------------ */
  const navBtn = document.querySelector('.adm-navitem[data-view="appointments"]');
  if (navBtn) {
    navBtn.addEventListener('click', () => {
      store.pull().then(render).catch(() => render());
    });
  }

  /* Dış cihazdan gelen değişiklikler */
  store.onChange((keys) => {
    if (keys.includes(KEY)) render();
  });

  /* ------------------------------------------------------------------
     Başlat
  ------------------------------------------------------------------ */
  async function init() {
    await store.requireAuth();
    render();
  }

  window.BerberAppointments = { render };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
