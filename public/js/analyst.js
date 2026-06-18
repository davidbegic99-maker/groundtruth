/* GroundTruth Analyst page — Step 5: two-tier dashboard.
 *
 *   PUBLIC tab:  aggregate grid cells only (no individual data), heatmap toggle,
 *                coverage-gap (underserved) highlighting, reports-in-view counter.
 *   ANALYST tab: authenticated. Full individual records as map markers (damage
 *                colour + red priority / yellow conflict badges), filters,
 *                a records list, a detail panel with version history and the
 *                decrypted photos, and the analyst-only AI damage estimate.
 */
(function () {
  const t = (k, o) => window.i18next.t(k, o);
  const D = () => window.GT_DATA;
  const KEY_STORE = 'gt_analyst_key';

  const TIER_COLOR = { Minimal: '#2e7d32', Partial: '#f9a825', Complete: '#d32f2f' };
  const tierCls = (v) => (v === 'Minimal' ? 'min' : v === 'Partial' ? 'par' : v === 'Complete' ? 'com' : 'na');

  let map, baseTiles;
  let publicLayer, heatLayer, coverageLayer, analystLayer;
  let cellsData = [];
  let recordsData = [];
  let tab = 'public';
  let analystKey = localStorage.getItem(KEY_STORE) || null;
  let selectedId = null;
  let selectedRecord = null; // full record currently shown in the detail panel (may be a version not in the filtered list)
  let refreshTimer = null;
  let liveSeconds = 60;
  const photoUrlCache = new Map();
  const markerById = new Map();

  // =========================================================================
  // Boot
  // =========================================================================
  document.addEventListener('gt:shellready', async () => {
    buildMap();
    buildFilterOptions();
    wireEvents();
    await loadLiveInterval();

    document.addEventListener('gt:languagechanged', onLanguageChanged);

    setTab('public');
    startLiveRefresh();
    window.addEventListener('online', startLiveRefresh);
    window.addEventListener('offline', stopLiveRefresh);
  });

  // =========================================================================
  // Map
  // =========================================================================
  function buildMap() {
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: '/vendor/images/marker-icon-2x.png',
      iconUrl: '/vendor/images/marker-icon.png',
      shadowUrl: '/vendor/images/marker-shadow.png',
    });
    map = L.map('analyst-map', { zoomControl: true }).setView([41.01, 29.0], 11);
    baseTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    loadFootprints(); // static demo building polygons, drawn under the markers
    publicLayer = L.layerGroup().addTo(map);
    coverageLayer = L.layerGroup();
    analystLayer = L.layerGroup();
    map.on('moveend', updateViewCounter);
  }

  // Load the STATIC demo building footprints (sourced once at dev time; cached by
  // the service worker for offline use). One demo area only — never fetched live.
  // Drawn in the default overlay pane, which sits below the marker pane.
  async function loadFootprints() {
    try {
      const fc = await (await fetch('/data/buildings-demo.geojson')).json();
      L.geoJSON(fc, {
        interactive: false,
        style: { color: '#1565c0', weight: 1, fillColor: '#1565c0', fillOpacity: 0.1 },
      }).addTo(map);
    } catch (_) { /* offline before first cache, or file missing — skip overlay */ }
  }

  // =========================================================================
  // Tab switching
  // =========================================================================
  function setTab(next) {
    tab = next;
    document.getElementById('tab-public').classList.toggle('active', next === 'public');
    document.getElementById('tab-analyst').classList.toggle('active', next === 'analyst');
    const coverageToggle = document.getElementById('toggle-coverage').closest('.chk');

    if (next === 'public') {
      show('public-info', true); show('analyst-login', false); show('analyst-panel', false);
      if (coverageToggle) coverageToggle.style.display = '';
      map.removeLayer(analystLayer);
      map.addLayer(publicLayer);
      if (document.getElementById('toggle-coverage').checked) map.addLayer(coverageLayer);
      loadPublic();
    } else {
      show('public-info', false);
      map.removeLayer(publicLayer);
      map.removeLayer(coverageLayer);
      if (coverageToggle) coverageToggle.style.display = 'none';
      if (analystKey) { show('analyst-login', false); show('analyst-panel', true); map.addLayer(analystLayer); loadAnalyst(); }
      else { show('analyst-login', true); show('analyst-panel', false); }
    }
  }

  // =========================================================================
  // PUBLIC tier
  // =========================================================================
  async function loadPublic() {
    let data;
    try { data = await (await fetch('/api/public/cells')).json(); }
    catch (_) { return; }
    cellsData = data.cells || [];
    publicLayer.clearLayers();
    coverageLayer.clearLayers();

    cellsData.forEach((c) => {
      const radius = 12 + Math.min(28, c.total * 3);
      L.circleMarker([c.lat, c.lon], {
        radius, color: '#fff', weight: 2, fillColor: TIER_COLOR[c.dominant] || '#777', fillOpacity: 0.8,
      }).addTo(publicLayer).bindPopup(cellPopup(c));

      if (c.underserved) {
        L.circleMarker([c.lat, c.lon], {
          radius: radius + 6, color: '#94a3b8', weight: 2, dashArray: '4 4', fill: false,
        }).addTo(coverageLayer).bindPopup(`<strong>${esc(t('a.underserved'))}</strong>`);
      }
    });

    rebuildHeat();
    updateViewCounter();
  }

  function cellPopup(c) {
    return (
      `<div class="cell-pop"><strong>${esc(t('a.cellReports', { count: c.total }))}</strong>` +
      `<div class="cell-break">` +
      `<span class="cb cb-min">${esc(t('damage.minimal'))}: ${c.minimal}</span>` +
      `<span class="cb cb-par">${esc(t('damage.partial'))}: ${c.partial}</span>` +
      `<span class="cb cb-com">${esc(t('damage.complete'))}: ${c.complete}</span>` +
      `</div>${c.underserved ? `<div class="cell-under">${esc(t('a.underserved'))}</div>` : ''}</div>`
    );
  }

  // =========================================================================
  // ANALYST tier
  // =========================================================================
  function currentFilters() {
    const v = (id) => document.getElementById(id).value || '';
    const params = new URLSearchParams();
    if (v('f-damage')) params.set('damage_classification', v('f-damage'));
    if (v('f-hazard')) params.set('hazard_type', v('f-hazard'));
    if (v('f-infra')) params.set('infrastructure_type', v('f-infra'));
    if (document.getElementById('f-priority').checked) params.set('priority_flag', '1');
    if (document.getElementById('f-conflict').checked) params.set('conflict_flag', '1');
    if (v('f-from')) params.set('from_time', new Date(v('f-from')).toISOString());
    if (v('f-to')) params.set('to_time', new Date(v('f-to')).toISOString());
    return params;
  }

  async function loadAnalyst() {
    if (!analystKey) return;
    let data;
    try {
      const r = await fetch('/api/analyst/submissions?' + currentFilters().toString(), {
        headers: { 'x-analyst-key': analystKey },
      });
      if (r.status === 401) { analystKey = null; localStorage.removeItem(KEY_STORE); setTab('analyst'); return; }
      data = await r.json();
    } catch (_) { return; }
    recordsData = data.submissions || [];
    renderMarkers();
    renderRecordsList();
    renderInfraSummary();
    updateViewCounter();
    updateApiUrl();
    loadAutoPdf();
  }

  // Compact "reports by building type" panel for the records currently matching
  // the active filters (recordsData is already filtered server-side). Mirrors the
  // PDF area-summary's infrastructure breakdown; refreshes whenever filters change.
  function renderInfraSummary() {
    const el = document.getElementById('infra-summary');
    if (!el) return;
    if (!recordsData.length) { el.hidden = true; el.innerHTML = ''; return; }
    const counts = {};
    recordsData.forEach((r) => {
      const k = r.infrastructure_type || '—';
      counts[k] = (counts[k] || 0) + 1;
    });
    // Canonical order (all 7 types), only listing those present, most-common first.
    const rows = D().INFRASTRUCTURE
      .map((i) => ({ value: i.value, label: D().infraLabel(i.value), n: counts[i.value] || 0 }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    let html = `<h2 class="infra-summary-title">${esc(t('a.infraSummary'))}</h2><ul class="infra-summary-list">`;
    rows.forEach((x) => {
      html += `<li><span class="infra-name">${esc(x.label)}</span><span class="infra-count">${x.n}</span></li>`;
    });
    html += '</ul>';
    el.innerHTML = html;
    el.hidden = false;
  }

  function renderMarkers() {
    analystLayer.clearLayers();
    markerById.clear();
    recordsData.forEach((rec) => {
      if (rec.lat == null || rec.lon == null) return;
      const m = L.marker([rec.lat, rec.lon], { icon: markerIcon(rec) });
      m.on('click', () => selectRecord(rec.submission_id, false));
      m.addTo(analystLayer);
      markerById.set(rec.submission_id, m);
    });
  }

  function markerIcon(rec) {
    let badges = '';
    if (rec.priority_flag) badges += '<i class="mk-badge prio">⚑</i>';
    if (rec.conflict_flag) badges += '<i class="mk-badge conf">⚠</i>';
    return L.divIcon({
      className: 'mk-wrap',
      html: `<span class="mk mk-${tierCls(rec.damage_classification)}"></span>${badges}`,
      iconSize: [20, 20], iconAnchor: [10, 10],
    });
  }

  function renderRecordsList() {
    const list = document.getElementById('records-list');
    const empty = document.getElementById('records-empty');
    document.getElementById('records-count').textContent = t('a.records', { count: recordsData.length });
    list.innerHTML = '';
    empty.hidden = recordsData.length > 0;
    recordsData.forEach((rec) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'record-row' + (rec.submission_id === selectedId ? ' selected' : '');
      let badges = '';
      if (rec.priority_flag) badges += `<span class="badge prio">⚑ ${esc(t('a.detail.priority'))}</span>`;
      if (rec.conflict_flag) badges += `<span class="badge conf">⚠ ${esc(t('a.detail.conflict'))}</span>`;
      row.innerHTML =
        `<span class="rec-dot dot-${tierCls(rec.damage_classification)}"></span>` +
        `<span class="rec-main"><span class="rec-line1">${esc(D().hazardLabel(rec.hazard_type))} · ${esc(D().damageLabel(rec.damage_classification))}</span>` +
        `<span class="rec-line2">${esc(D().infraLabel(rec.infrastructure_type))} · ${esc(fmtTime(rec.timestamp))}</span>` +
        `<span class="rec-badges">${badges}</span></span>`;
      row.addEventListener('click', () => selectRecord(rec.submission_id, true));
      list.appendChild(row);
    });
  }

  function selectRecord(id, fromList) {
    selectedId = id;
    renderRecordsList();
    const rec = recordsData.find((r) => r.submission_id === id);
    if (!rec) return;
    if (rec.lat != null) {
      map.setView([rec.lat, rec.lon], Math.max(map.getZoom(), 15));
      const m = markerById.get(id);
      if (m && fromList) m.openPopup && m.openPopup();
    }
    showDetail(rec);
  }

  async function showDetail(rec) {
    selectedRecord = rec;
    const el = document.getElementById('detail');
    el.hidden = false;
    const coords = rec.lat != null ? `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}` : '—';
    const lowConf = rec.location_confidence === 'low';
    // Mark an approximate coordinate (e.g. a landmark-only report pinned at the
    // map centre) so the analyst treats it with care and geocodes the landmark.
    const coordsCell = rec.lat != null && lowConf
      ? `${esc(coords)} <span class="loc-approx">${esc(t('a.detail.approxFlag'))}</span>`
      : esc(coords);
    let badges = '';
    if (rec.priority_flag) badges += `<span class="badge prio">⚑ ${esc(t('a.detail.priority'))}</span>`;
    if (rec.conflict_flag) badges += `<span class="badge conf">⚠ ${esc(t('a.detail.conflict'))}</span>`;

    const rows = [
      [t('a.detail.userDamage'), `<strong class="tone-${tierCls(rec.damage_classification)}">${esc(D().damageLabel(rec.damage_classification))}</strong>`],
      [t('a.detail.aiDamage'), rec.ai_suggested_damage ? esc(D().damageLabel(rec.ai_suggested_damage)) : '—'],
      [t('a.detail.aiConfidence'), rec.ai_confidence != null ? Math.round(rec.ai_confidence * 100) + '%' : '—'],
      [t('a.detail.aiPercent'), rec.ai_damage_percentage != null ? rec.ai_damage_percentage + '%' : '—'],
      [t('a.detail.hazard'), esc(D().hazardLabel(rec.hazard_type))],
      [t('a.detail.infra'), esc(D().infraLabel(rec.infrastructure_type))],
      [t('a.detail.people'), esc(peopleLabel(rec.people_in_danger))],
      [t('a.detail.time'), esc(fmtTime(rec.timestamp))],
      [t('a.detail.method'), esc(methodLabel(rec.location_method))],
      [t('a.detail.coordinates'), coordsCell],
      [t('a.detail.channel'), esc(rec.channel || 'PWA')],
    ];

    // Landmark description, when present (supplementary or the basis for an
    // approximate landmark-only coordinate the analyst can geocode later).
    if (rec.landmark_text) rows.push([t('a.detail.landmark'), esc(rec.landmark_text)]);

    // Optional crisis-specific answers
    const qs = D().questionsFor(rec.hazard_type);
    if (rec.dynamic_q1_answer && qs[0]) rows.push([t(qs[0].key), esc(optLabel(qs[0], rec.dynamic_q1_answer))]);
    if (rec.dynamic_q2_answer && qs[1]) rows.push([t(qs[1].key), esc(optLabel(qs[1], rec.dynamic_q2_answer))]);

    let html = `<div class="detail-head"><h2>${esc(t('a.detail.title'))}</h2><button class="btn btn-text" id="detail-close">✕</button></div>`;
    if (badges) html += `<div class="detail-badges">${badges}</div>`;
    html += '<dl class="detail-list">';
    rows.forEach(([k, v]) => { html += `<dt>${esc(k)}</dt><dd>${v}</dd>`; });
    html += '</dl>';
    // FIX 4: when the no-key mock classifier produced this AI suggestion, make it
    // unmistakable that it is a demo placeholder rather than a live AI result.
    if (rec.ai_source === 'mock') html += `<div class="detail-mock">${esc(t('a.detail.mockNote'))}</div>`;
    if (rec.description_text) html += `<div class="detail-desc"><strong>${esc(t('a.detail.description'))}:</strong> ${esc(rec.description_text)}</div>`;
    if (rec.description_en && rec.description_en !== rec.description_text) html += `<div class="detail-desc detail-translated"><strong>${esc(t('a.detail.translated'))}:</strong> ${esc(rec.description_en)}</div>`;
    if (rec.dedup_annotation) html += `<div class="detail-annot">${esc(rec.dedup_annotation)}</div>`;
    html += `<div class="detail-photos" id="detail-photos"></div>`;
    html += `<div class="detail-versions" id="detail-versions"></div>`;
    el.innerHTML = html;
    document.getElementById('detail-close').addEventListener('click', () => { el.hidden = true; selectedId = null; selectedRecord = null; renderRecordsList(); });
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    loadPhotos(rec);
    loadVersions(rec);
  }

  async function loadPhotos(rec) {
    const wrap = document.getElementById('detail-photos');
    if (!wrap) return;
    const hashes = [rec.photo_hash_1, rec.photo_hash_2, rec.photo_hash_3].filter(Boolean);
    if (!hashes.length) return;
    wrap.innerHTML = `<div class="detail-sub">${esc(t('a.detail.photos'))}</div>`;
    for (const h of hashes) {
      const img = document.createElement('img');
      img.className = 'detail-photo';
      img.alt = t('a.detail.photos');
      try {
        let url = photoUrlCache.get(h);
        if (!url) {
          const r = await fetch('/api/photo/' + h, { headers: { 'x-analyst-key': analystKey } });
          if (!r.ok) continue;
          url = URL.createObjectURL(await r.blob());
          photoUrlCache.set(h, url);
        }
        img.src = url;
        wrap.appendChild(img);
      } catch (_) { /* skip */ }
    }
  }

  async function loadVersions(rec) {
    const wrap = document.getElementById('detail-versions');
    if (!wrap || !rec.building_id) return;
    let data;
    try {
      const r = await fetch('/api/analyst/building/' + encodeURIComponent(rec.building_id), { headers: { 'x-analyst-key': analystKey } });
      data = await r.json();
    } catch (_) { return; }
    const versions = data.versions || [];
    if (versions.length <= 1) return;

    // Each row is a button that opens that version's own full detail. Every
    // version is a complete submission, so it carries its own photo + AI fields;
    // a row with no photo is marked so the analyst sees it was not retained for
    // that version rather than missing from the panel.
    wrap.innerHTML =
      `<div class="detail-sub">${esc(t('a.detail.versions'))} (${versions.length})</div>` +
      `<p class="ver-hint">${esc(t('a.detail.versionHint'))}</p>`;
    const list = document.createElement('div');
    list.className = 'ver-list';
    versions.forEach((v) => {
      const cur = v.submission_id === rec.submission_id;
      const hasPhoto = !!(v.photo_hash_1 || v.photo_hash_2 || v.photo_hash_3);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ver-row' + (cur ? ' cur' : '');
      row.setAttribute('aria-current', cur ? 'true' : 'false');
      let badges = '';
      if (v.priority_flag) badges += '<span class="badge prio">⚑</span>';
      if (v.conflict_flag) badges += '<span class="badge conf">⚠</span>';
      row.innerHTML =
        `<span class="ver-n">${esc(t('a.detail.version', { n: v.version_number }))}</span>` +
        `<span class="ver-dmg tone-${tierCls(v.damage_classification)}">${esc(D().damageLabel(v.damage_classification))}</span>` +
        badges +
        `<span class="ver-photo ${hasPhoto ? 'has' : 'none'}">${hasPhoto ? '📷' : esc(t('a.detail.noPhotoVersion'))}</span>` +
        `<span class="ver-time">${esc(fmtTime(v.timestamp))}</span>`;
      row.addEventListener('click', () => openVersion(v));
      list.appendChild(row);
    });
    wrap.appendChild(list);
  }

  // Open one version's full detail. The version object from /building/:id carries
  // the same complete columns as a records-list row, so it renders identically —
  // including its own photos, AI estimate and confirmed tier for that point in time.
  function openVersion(v) {
    selectedId = v.submission_id;
    renderRecordsList();
    if (v.lat != null && map) {
      map.setView([v.lat, v.lon], Math.max(map.getZoom(), 15));
      const m = markerById.get(v.submission_id);
      if (m && m.openPopup) m.openPopup();
    }
    showDetail(v);
  }

  // =========================================================================
  // Heatmap + coverage + counter
  // =========================================================================
  function rebuildHeat() {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    if (!document.getElementById('toggle-heatmap').checked) return;
    const pts = (tab === 'public')
      ? cellsData.map((c) => [c.lat, c.lon, Math.min(1, c.total / 8)])
      : recordsData.filter((r) => r.lat != null).map((r) => [r.lat, r.lon, 0.6]);
    if (!pts.length || typeof L.heatLayer !== 'function') return;
    heatLayer = L.heatLayer(pts, { radius: 35, blur: 25, maxZoom: 17 }).addTo(map);
  }

  function updateViewCounter() {
    const el = document.getElementById('view-counter');
    if (!el || !map) return;
    const b = map.getBounds();
    let n = 0;
    if (tab === 'public') cellsData.forEach((c) => { if (b.contains([c.lat, c.lon])) n += c.total; });
    else recordsData.forEach((r) => { if (r.lat != null && b.contains([r.lat, r.lon])) n += 1; });
    el.textContent = t('a.reportsInView', { count: n });
  }

  // =========================================================================
  // Filters
  // =========================================================================
  function buildFilterOptions() {
    const fill = (id, items, labeller) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = `<option value="">${t('a.filter.all')}</option>` +
        items.map((it) => `<option value="${esc(it.value)}">${esc(labeller(it))}</option>`).join('');
    };
    fill('f-damage', D().DAMAGE, (d) => t(d.key));
    const hazards = D().HAZARD_GROUPS.flatMap((g) => g.types.map((v) => ({ value: v })));
    fill('f-hazard', hazards, (h) => D().hazardLabel(h.value));
    fill('f-infra', D().INFRASTRUCTURE, (i) => t(i.key));
  }

  // =========================================================================
  // Events
  // =========================================================================
  function wireEvents() {
    document.getElementById('tab-public').addEventListener('click', () => setTab('public'));
    document.getElementById('tab-analyst').addEventListener('click', () => setTab('analyst'));
    document.getElementById('btn-unlock').addEventListener('click', unlock);
    document.getElementById('analyst-key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
    document.getElementById('toggle-heatmap').addEventListener('change', rebuildHeat);
    document.getElementById('toggle-coverage').addEventListener('change', (e) => {
      if (tab !== 'public') return;
      if (e.target.checked) map.addLayer(coverageLayer); else map.removeLayer(coverageLayer);
    });
    ['f-damage', 'f-hazard', 'f-infra', 'f-from', 'f-to'].forEach((id) =>
      document.getElementById(id).addEventListener('change', loadAnalyst));
    ['f-priority', 'f-conflict'].forEach((id) =>
      document.getElementById(id).addEventListener('change', loadAnalyst));
    document.getElementById('btn-clear-filters').addEventListener('click', () => {
      ['f-damage', 'f-hazard', 'f-infra', 'f-from', 'f-to'].forEach((id) => (document.getElementById(id).value = ''));
      document.getElementById('f-priority').checked = false;
      document.getElementById('f-conflict').checked = false;
      loadAnalyst();
    });

    // Exports (§14): each button downloads the current filtered set.
    document.querySelectorAll('.export-buttons [data-fmt]').forEach((btn) =>
      btn.addEventListener('click', () => doExport(btn.getAttribute('data-fmt'), btn)));
    document.getElementById('api-copy').addEventListener('click', copyApiUrl);
  }

  // =========================================================================
  // Exports & REST API
  // =========================================================================
  async function doExport(fmt, btn) {
    if (!analystKey) return;
    const status = document.getElementById('export-status');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = t('a.export.preparing');
    if (status) status.hidden = true;
    try {
      const params = currentFilters();
      // The PDF is an AREA summary (§13.3), not a full-dataset dump: scope it to the
      // current map view so "X reports in this area" is geographically true and the
      // cluster map stays tight (zoom to a cluster, then generate). The data exports
      // (CSV/GeoJSON/GeoPackage) intentionally keep the full filtered set instead.
      if (fmt === 'pdf' && map) {
        const b = map.getBounds();
        params.set('bbox', [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
          .map((n) => n.toFixed(6)).join(','));
      }
      const qs = params.toString();
      const url = `/api/export/${fmt}` + (qs ? '?' + qs : '');
      const r = await fetch(url, { headers: { 'x-analyst-key': analystKey } });
      if (!r.ok) throw new Error('export HTTP ' + r.status);
      const blob = await r.blob();
      const name = filenameFrom(r.headers.get('Content-Disposition')) || `groundtruth.${fmt}`;
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
    } catch (_) {
      if (status) { status.hidden = false; status.textContent = t('a.export.failed'); }
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  function filenameFrom(disposition) {
    if (!disposition) return null;
    const m = /filename="?([^"]+)"?/.exec(disposition);
    return m ? m[1] : null;
  }

  function updateApiUrl() {
    const el = document.getElementById('api-url');
    if (!el) return;
    const qs = currentFilters().toString();
    el.textContent = `${location.origin}/api/v1/reports` + (qs ? '?' + qs : '');
  }

  async function copyApiUrl() {
    const el = document.getElementById('api-url');
    const btn = document.getElementById('api-copy');
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent);
      const old = btn.textContent; btn.textContent = t('a.export.copied');
      setTimeout(() => (btn.textContent = old), 1500);
    } catch (_) { /* clipboard blocked — the URL is visible to copy manually */ }
  }

  // Auto-trigger detection (§13.3): flag areas that reached the PDF threshold.
  async function loadAutoPdf() {
    const note = document.getElementById('autopdf-note');
    if (!note || !analystKey) return;
    try {
      const r = await fetch('/api/analyst/pdf-clusters', { headers: { 'x-analyst-key': analystKey } });
      if (!r.ok) return;
      const d = await r.json();
      if (d.clusters && d.clusters.length) {
        note.hidden = false;
        note.textContent = '⚑ ' + t('a.export.autoPdf', { count: d.clusters.length, n: d.threshold.count, r: d.threshold.radius_m });
      } else {
        note.hidden = true;
      }
    } catch (_) { /* ignore */ }
  }

  async function unlock() {
    const input = document.getElementById('analyst-key-input');
    const err = document.getElementById('login-error');
    const key = (input.value || '').trim();
    if (!key) return;
    try {
      const r = await fetch('/api/analyst/check', { headers: { 'x-analyst-key': key } });
      if (!r.ok) throw new Error('bad key');
      analystKey = key;
      localStorage.setItem(KEY_STORE, key);
      err.hidden = true;
      input.value = '';
      setTab('analyst');
    } catch (_) {
      err.hidden = false;
    }
  }

  // =========================================================================
  // Live refresh (briefing §16: 60s when online, paused offline)
  // =========================================================================
  async function loadLiveInterval() {
    try {
      const s = await (await fetch('/api/settings')).json();
      const m = {}; (s.settings || []).forEach((x) => (m[x.key] = x.value));
      liveSeconds = Number(m.live_refresh_seconds) || 60;
    } catch (_) { liveSeconds = 60; }
  }
  function startLiveRefresh() {
    stopLiveRefresh();
    if (!navigator.onLine) return;
    refreshTimer = setInterval(() => {
      if (!navigator.onLine) return;
      if (tab === 'public') loadPublic(); else if (analystKey) loadAnalyst();
    }, liveSeconds * 1000);
  }
  function stopLiveRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  // =========================================================================
  // Language change → re-render visible content
  // =========================================================================
  function onLanguageChanged() {
    buildFilterOptions();
    if (tab === 'public') loadPublic();
    else if (analystKey) {
      renderRecordsList();
      renderInfraSummary();
      loadAutoPdf();
      // Re-render the open detail. Prefer the filtered-list record; fall back to
      // the currently-shown record (e.g. a version opened from version history
      // that isn't in the current filter set).
      const rec = recordsData.find((r) => r.submission_id === selectedId) || selectedRecord;
      if (rec) showDetail(rec);
    }
    updateViewCounter();
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  function show(id, on) { const el = document.getElementById(id); if (el) el.hidden = !on; }
  function peopleLabel(v) {
    const o = D().MANDATORY.options.find((x) => x.value === v);
    return o ? t(o.key) : (v || '—');
  }
  function optLabel(q, v) { const o = q.options.find((x) => x.value === v); return o ? t(o.key) : v; }
  function methodLabel(v) {
    const map2 = { EXIF: 'location.methodEXIF', LiveGPS: 'location.methodLiveGPS', MapTap: 'location.methodMapTap', Landmark: 'location.methodLandmark', Unknown: 'location.methodUnknown' };
    return map2[v] ? t(map2[v]) : (v || '—');
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    try { return d.toLocaleString(window.GT_I18N ? window.GT_I18N.current() : undefined); } catch (_) { return iso; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
