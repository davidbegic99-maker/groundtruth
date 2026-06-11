/* GroundTruth Reporter — Step 4: submit + offline-first queue.
 *
 * OFFLINE-FIRST GUARANTEE: every report is written to IndexedDB (via localForage)
 * BEFORE any network attempt. If online, it uploads immediately and shows a green
 * confirmation. If offline or the upload fails, it stays queued, shows an orange
 * "saved — will upload later" confirmation with a pending count, and is retried
 * automatically on reconnect, via a manual "Sync now" button, and via the
 * Background Sync API where the browser supports it.
 *
 * Defines window.GT_submitReport, which flow.js calls from the Review screen.
 */
(function () {
  const t = (k, o) => window.i18next.t(k, o);
  const D = () => window.GT_DATA;

  const store = window.localforage.createInstance({ name: 'groundtruth', storeName: 'queue' });
  // Full-resolution originals live in a SEPARATE store from the upload queue, so they
  // are retained on the device even after the compressed copy has synced and the queue
  // item is removed (briefing §16: "full resolution retained locally").
  const originals = window.localforage.createInstance({ name: 'groundtruth', storeName: 'originals' });

  let confirmMap = null;
  let confirmMarker = null;
  let lastConfirm = null; // { status, report, result, count } — for re-render on language change

  // -------------------------------------------------------------------------
  function deviceToken() {
    let id = localStorage.getItem('gt_device');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : 'd-' + Date.now() + '-' + Math.random().toString(16).slice(2));
      localStorage.setItem('gt_device', id);
    }
    return id;
  }
  function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : 's-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  // =========================================================================
  // Boot
  // =========================================================================
  document.addEventListener('gt:shellready', () => {
    document.getElementById('btn-confirm-another')?.addEventListener('click', startAnother);
    document.getElementById('btn-sync-now')?.addEventListener('click', () => flushQueue(true));

    window.addEventListener('online', () => flushQueue(false));
    if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'gt-flush') flushQueue(false);
      });
    }

    document.addEventListener('gt:languagechanged', () => {
      updateQueueBadge();
      if (lastConfirm) renderConfirm(lastConfirm.status, lastConfirm.report, lastConfirm.result, lastConfirm.count);
    });

    updateQueueBadge();
    if (navigator.onLine) flushQueue(false); // clear anything left from a previous session
  });

  // Called by flow.js onSubmit.
  window.GT_submitReport = submitReport;

  // =========================================================================
  // Submit
  // =========================================================================
  async function submitReport() {
    const report = window.GT_buildReport ? window.GT_buildReport() : null;
    if (!report) return;

    const submission_id = newId();
    const item = {
      submission_id,
      device_token: deviceToken(),
      channel: 'PWA',
      timestamp: report.timestamp || new Date().toISOString(), // capture time
      lat: report.lat, lon: report.lon,
      location_method: report.location_method,
      landmark_text: report.landmark_text,
      hazard_type: report.hazard_type,
      infrastructure_type: report.infrastructure_type,
      damage_classification: report.damage_classification,
      ai_suggested_damage: report.ai_suggested_damage,
      ai_confidence: report.ai_confidence,
      ai_damage_percentage: report.ai_damage_percentage,
      people_in_danger: report.people_in_danger,
      dynamic_q1_answer: report.dynamic_q1_answer,
      dynamic_q2_answer: report.dynamic_q2_answer,
      description_text: report.description_text,
      language_detected: window.GT_I18N ? window.GT_I18N.current() : 'en',
      // Store blobs in IndexedDB; convert to base64 only at upload time.
      photos: (report.photos || []).filter(Boolean).map((p) => ({
        blob: p.blob, mime: p.mime || 'image/jpeg', width: p.width, height: p.height, hash: p.hash,
      })),
      queued_at: new Date().toISOString(),
    };

    // OFFLINE-FIRST: persist before any network attempt.
    await store.setItem(submission_id, item);
    // Retain the full-resolution originals locally (§16). Best-effort — never blocks
    // the submit/queue path; the compressed copies in `item` are what get uploaded.
    await retainOriginals(report.photos, submission_id, item.timestamp);
    updateQueueBadge();

    let result = null;
    if (navigator.onLine) {
      result = await uploadItem(item).catch(() => null);
    }
    const online = !!result;
    if (!online) await registerBackgroundSync();

    const count = await queueCount();
    window.GT_showScreen('screen-confirm');
    renderConfirm(online ? 'online' : 'offline', report, result, count);
    if (window.GT_refreshCount) window.GT_refreshCount();
  }

  async function uploadItem(item) {
    const body = {
      submission_id: item.submission_id,
      device_token: item.device_token,
      channel: 'PWA',
      timestamp: item.timestamp,
      lat: item.lat, lon: item.lon,
      location_method: item.location_method,
      landmark_text: item.landmark_text,
      hazard_type: item.hazard_type,
      infrastructure_type: item.infrastructure_type,
      damage_classification: item.damage_classification,
      ai_suggested_damage: item.ai_suggested_damage,
      ai_confidence: item.ai_confidence,
      ai_damage_percentage: item.ai_damage_percentage,
      people_in_danger: item.people_in_danger,
      dynamic_q1_answer: item.dynamic_q1_answer,
      dynamic_q2_answer: item.dynamic_q2_answer,
      description_text: item.description_text,
      language_detected: item.language_detected,
      photos: await Promise.all((item.photos || []).map(async (p) => ({
        data: await blobToBase64(p.blob), mime: p.mime, width: p.width, height: p.height,
      }))),
    };
    const r = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('submit HTTP ' + r.status);
    const result = await r.json();
    await store.removeItem(item.submission_id); // success -> dequeue
    updateQueueBadge();
    if (window.GT_refreshCount) window.GT_refreshCount();
    return result;
  }

  // =========================================================================
  // Queue flushing
  // =========================================================================
  async function flushQueue(manual) {
    const btn = document.getElementById('btn-sync-now');
    if (!navigator.onLine) { updateQueueBadge(); return 0; }
    if (manual && btn) { btn.disabled = true; btn.textContent = t('queue.syncing'); }
    let uploaded = 0;
    try {
      const keys = await store.keys();
      for (const k of keys) {
        const item = await store.getItem(k);
        if (!item) continue;
        try { await uploadItem(item); uploaded++; } catch (_) { /* keep queued for next time */ }
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = t('queue.syncNow'); }
      updateQueueBadge();
    }
    return uploaded;
  }

  async function queueCount() {
    try { return (await store.keys()).length; } catch (_) { return 0; }
  }

  async function updateQueueBadge() {
    const banner = document.getElementById('queue-banner');
    const text = document.getElementById('queue-text');
    if (!banner || !text) return;
    const n = await queueCount();
    if (n > 0) {
      banner.hidden = false;
      text.textContent = t('queue.pending', { count: n });
    } else {
      banner.hidden = true;
    }
  }

  async function registerBackgroundSync() {
    try {
      const reg = navigator.serviceWorker && (await navigator.serviceWorker.ready);
      if (reg && 'sync' in reg) await reg.sync.register('gt-sync-queue');
    } catch (_) { /* not supported — online/manual flush still cover it */ }
  }

  // =========================================================================
  // Confirmation screen
  // =========================================================================
  function renderConfirm(status, report, result, count) {
    lastConfirm = { status, report, result, count };
    const online = status === 'online';

    const banner = document.getElementById('confirm-banner');
    if (banner) {
      banner.className = 'confirm-banner ' + (online ? 'ok' : 'queued');
      banner.textContent = online ? t('confirm.bannerOnline') : t('confirm.bannerOffline');
    }
    const title = document.getElementById('confirm-title');
    if (title) title.textContent = online ? t('confirm.titleOnline') : t('confirm.titleOffline');

    // Details list
    const details = document.getElementById('confirm-details');
    if (details) {
      const rows = [
        [t('confirm.damage'), report.damage_classification ? D().damageLabel(report.damage_classification) : '—', D().damageClass(report.damage_classification)],
        [t('confirm.infra'), report.infrastructure_type ? D().infraLabel(report.infrastructure_type) : '—', ''],
        [t('confirm.time'), formatTime(report.timestamp || (result && result.timestamp)), ''],
      ];
      details.innerHTML = rows.map(([k, v, cls]) =>
        `<dt>${esc(k)}</dt><dd class="${cls}">${esc(String(v))}</dd>`).join('');
    }

    // Priority note
    const prio = document.getElementById('confirm-priority');
    if (prio) {
      const isPriority = report.people_in_danger === 'Yes';
      prio.hidden = !isPriority;
      if (isPriority) prio.textContent = '⚑ ' + t('confirm.priority');
    }

    // Queued note (offline, or other items still pending)
    const queue = document.getElementById('confirm-queue');
    if (queue) {
      if (!online || count > 0) {
        queue.hidden = false;
        queue.textContent = t('confirm.queuedNote', { count: Math.max(count, online ? 0 : 1) });
      } else {
        queue.hidden = true;
      }
    }

    renderConfirmMap(report);
  }

  function renderConfirmMap(report) {
    const el = document.getElementById('confirm-map');
    if (!el) return;
    if (report.lat == null || typeof L === 'undefined') {
      el.hidden = true;
      const note = document.getElementById('confirm-noloc');
      if (note) { note.hidden = false; note.textContent = t('confirm.noLocation'); }
      return;
    }
    const note = document.getElementById('confirm-noloc');
    if (note) note.hidden = true;
    el.hidden = false;
    const ll = [report.lat, report.lon];
    if (!confirmMap) {
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: '/vendor/images/marker-icon-2x.png',
        iconUrl: '/vendor/images/marker-icon.png',
        shadowUrl: '/vendor/images/marker-shadow.png',
      });
      confirmMap = L.map('confirm-map', {
        zoomControl: false, attributionControl: true, dragging: false,
        scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false,
      }).setView(ll, 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap contributors',
      }).addTo(confirmMap);
    } else {
      confirmMap.setView(ll, 16);
    }
    if (confirmMarker) confirmMap.removeLayer(confirmMarker);
    confirmMarker = L.marker(ll).addTo(confirmMap);
    setTimeout(() => confirmMap && confirmMap.invalidateSize(), 80);
  }

  function startAnother() {
    window.GT_showScreen('screen-welcome');
    updateQueueBadge();
    if (window.GT_refreshCount) window.GT_refreshCount();
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  // Persist each photo's full-resolution original, keyed by its content hash, in a
  // store that is NOT cleared when the queue item syncs — so the device keeps the
  // original even after only the compressed copy was uploaded (briefing §16).
  async function retainOriginals(photos, submission_id, capturedAt) {
    for (const p of (photos || []).filter(Boolean)) {
      if (!p.fullBlob || !p.hash) continue;
      try {
        await originals.setItem(p.hash, {
          blob: p.fullBlob,
          mime: p.fullMime || p.mime || 'image/jpeg',
          width: p.width,
          height: p.height,
          sizeKB: p.fullSizeKB,
          submission_id,
          capturedAt: capturedAt || new Date().toISOString(),
        });
      } catch (_) { /* device storage full / blob unreadable — non-fatal */ }
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  function formatTime(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) return '—';
    try { return d.toLocaleString(window.GT_I18N ? window.GT_I18N.current() : undefined); }
    catch (_) { return d.toISOString(); }
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
