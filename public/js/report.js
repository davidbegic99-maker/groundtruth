/* GroundTruth Reporter wizard — Step 2: photos + location fallback chain.
 *
 * Holds the in-progress report state (window.GTReport) that later steps
 * (hazard, AI, answers, submit) extend. Handles:
 *   - photo capture (up to 3) with the dismissible guidance overlay
 *   - EXIF GPS + timestamp extraction (privacy: the stored JPEG is re-encoded
 *     via canvas, which strips ALL metadata; we keep only lat/lon/timestamp)
 *   - client-side compression to a configurable target size
 *   - location fallback chain: EXIF GPS -> live device GPS -> map tap -> landmark
 */
(function () {
  const SLOT_COUNT = 3;

  // --- shared report state -------------------------------------------------
  const state = {
    photos: [],            // [{url, blob, mime, width, height, sizeKB, hash, exifLat, exifLon, ts}]
    lat: null,
    lon: null,
    accuracy: null,
    location_method: null,     // EXIF | LiveGPS | MapTap | Landmark | Unknown
    location_confidence: null, // normal | low (low = approximate, e.g. landmark-only)
    landmark_text: null,
    timestamp: null        // capture time from EXIF; null -> defaults to now at submit
  };
  window.GTReport = state;

  let settings = { photo_target_kb: 200 };
  let guidanceShownThisReport = false;
  let pendingSlot = null;
  let map = null;
  let marker = null;
  let accuracyCircle = null;
  let footprintFeatures = []; // static demo building polygons (one area only)

  const t = (k, o) => window.i18next.t(k, o);

  // =========================================================================
  // Boot
  // =========================================================================
  document.addEventListener('gt:shellready', () => {
    fetchSettings();

    document.getElementById('btn-start')?.addEventListener('click', startReport);
    document.getElementById('btn-photos-continue')?.addEventListener('click', goToLocation);
    document.getElementById('btn-location-continue')?.addEventListener('click', goToNextStep);
    document.getElementById('btn-use-gps')?.addEventListener('click', useLiveGps);
    document.getElementById('btn-guidance-gotit')?.addEventListener('click', dismissGuidance);
    document.getElementById('guidance-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'guidance-overlay') dismissGuidance(); // backdrop tap = dismiss
    });

    const landmark = document.getElementById('landmark-input');
    landmark?.addEventListener('input', () => {
      state.landmark_text = landmark.value.trim() || null;
      updateLocStatus();
      updateLocationContinue();
    });

    // Re-render translated bits when language changes.
    document.addEventListener('gt:languagechanged', () => {
      renderPhotoGrid();
      updateLocStatus();
    });
  });

  async function fetchSettings() {
    try {
      const r = await fetch('/api/settings');
      if (r.ok) {
        const map = {};
        (await r.json()).settings.forEach((s) => (map[s.key] = s.value));
        settings.photo_target_kb = Number(map.photo_target_kb) || 200;
      }
    } catch (_) { /* offline — use defaults */ }
  }

  // =========================================================================
  // Wizard navigation
  // =========================================================================
  function startReport() {
    resetState();
    renderPhotoGrid();
    window.GT_showScreen('screen-photos');
  }

  function resetState() {
    state.photos.forEach((p) => p && p.url && URL.revokeObjectURL(p.url));
    state.photos = [];
    state.lat = state.lon = state.accuracy = null;
    state.location_method = null;
    state.location_confidence = null;
    state.landmark_text = null;
    state.timestamp = null;
    guidanceShownThisReport = false;
    const li = document.getElementById('landmark-input');
    if (li) li.value = '';
    // Let Step 3 (flow.js) clear its own fields for a fresh report.
    document.dispatchEvent(new CustomEvent('gt:reportreset'));
  }

  function goToLocation() {
    window.GT_showScreen('screen-location');
    initMapOnce();
    setTimeout(() => { if (map) { map.invalidateSize(); syncMap(); } }, 60);
    updateLocStatus();
    updateLocationContinue();
  }

  function goToNextStep() {
    commitLocation();
    window.GT_showScreen('screen-hazard');
    // Hand off to the Step 3 flow (hazard / AI / questions / review).
    document.dispatchEvent(new CustomEvent('gt:locationcommitted'));
  }

  // =========================================================================
  // Photos
  // =========================================================================
  function slotLabel(i) { return t(`photos.slot${i + 1}`); }
  function slotTag(i) { return i === 0 ? t('photos.required') : t('photos.optional'); }

  // At least one photo (slot 1) is REQUIRED before the Photos step can continue.
  function hasAtLeastOnePhoto() {
    return state.photos.some((p) => p && p.blob);
  }
  function updatePhotosContinue() {
    const btn = document.getElementById('btn-photos-continue');
    if (btn) btn.disabled = !hasAtLeastOnePhoto();
  }

  function renderPhotoGrid() {
    const grid = document.getElementById('photo-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (let i = 0; i < SLOT_COUNT; i++) {
      const photo = state.photos[i];
      const slot = document.createElement('div');
      slot.className = 'photo-slot' + (photo ? ' filled' : '');

      const head = document.createElement('div');
      head.className = 'photo-slot-head';
      head.innerHTML = `<span class="photo-slot-label">${escapeHtml(slotLabel(i))}</span>` +
        `<span class="photo-tag ${i === 0 ? 'rec' : ''}">${escapeHtml(slotTag(i))}</span>`;
      slot.appendChild(head);

      if (photo) {
        const img = document.createElement('img');
        img.className = 'photo-thumb';
        img.src = photo.url;
        img.alt = slotLabel(i);
        slot.appendChild(img);

        const meta = document.createElement('div');
        meta.className = 'photo-meta';
        meta.textContent = `${photo.width}×${photo.height} · ${photo.sizeKB} KB`;
        slot.appendChild(meta);

        if (photo.exifLat != null && photo.exifLon != null) {
          const gps = document.createElement('div');
          gps.className = 'photo-gps';
          gps.textContent = '📍 ' + t('photos.gpsFound');
          slot.appendChild(gps);
        }

        const actions = document.createElement('div');
        actions.className = 'photo-actions';
        const rep = document.createElement('button');
        rep.className = 'btn btn-text';
        rep.textContent = t('photos.replace');
        rep.addEventListener('click', () => requestPhoto(i));
        const rem = document.createElement('button');
        rem.className = 'btn btn-text danger';
        rem.textContent = t('photos.remove');
        rem.addEventListener('click', () => removePhoto(i));
        actions.append(rep, rem);
        slot.appendChild(actions);
      } else {
        const add = document.createElement('button');
        add.className = 'photo-add';
        add.innerHTML = `<span class="plus">＋</span><span>${escapeHtml(t('photos.add'))}</span>`;
        add.addEventListener('click', () => requestPhoto(i));
        slot.appendChild(add);
      }
      grid.appendChild(slot);
    }
    updatePhotosContinue();
  }

  function requestPhoto(i) {
    pendingSlot = i;
    if (!guidanceShownThisReport) {
      showGuidance();
    } else {
      openFilePicker();
    }
  }

  function showGuidance() {
    const ov = document.getElementById('guidance-overlay');
    if (ov) ov.hidden = false;
  }
  function dismissGuidance() {
    const ov = document.getElementById('guidance-overlay');
    if (ov) ov.hidden = true;
    guidanceShownThisReport = true;
    openFilePicker();
  }

  function openFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (file) await processFile(file, pendingSlot);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  async function processFile(file, idx) {
    // show a processing placeholder in the slot
    state.photos[idx] = { processing: true };
    renderPhotoGrid();
    markProcessing(idx);

    const [exif, compressed] = await Promise.all([extractExif(file), compressImage(file)]);
    const hash = await sha256(compressed.blob);
    const url = URL.createObjectURL(compressed.blob);

    state.photos[idx] = {
      url,
      blob: compressed.blob,           // compressed (~photo_target_kb) — used for upload
      mime: 'image/jpeg',
      width: compressed.width,
      height: compressed.height,
      sizeKB: Math.round(compressed.blob.size / 1024),
      // §16: keep the FULL-RESOLUTION original so it can be retained locally on the
      // device. The compressed copy above is what gets uploaded; this is not.
      fullBlob: file,
      fullMime: file.type || 'image/jpeg',
      fullSizeKB: Math.round(file.size / 1024),
      hash,
      exifLat: exif.lat,
      exifLon: exif.lon,
      ts: exif.ts
    };

    // Location fallback #1: EXIF GPS (don't override an explicit user choice)
    if (exif.lat != null && exif.lon != null &&
        (state.location_method == null || state.location_method === 'EXIF')) {
      setCoords(exif.lat, exif.lon, 'EXIF', null);
    }
    // Capture timestamp from EXIF if we don't already have one
    if (exif.ts && !state.timestamp) state.timestamp = exif.ts;

    renderPhotoGrid();
  }

  function markProcessing(idx) {
    const slots = document.querySelectorAll('.photo-slot');
    const slot = slots[idx];
    if (slot) {
      slot.classList.add('filled');
      slot.insertAdjacentHTML('beforeend', `<div class="photo-processing">${escapeHtml(t('photos.processing'))}</div>`);
    }
  }

  function removePhoto(i) {
    const p = state.photos[i];
    if (p && p.url) URL.revokeObjectURL(p.url);
    state.photos[i] = undefined;
    // If EXIF location came from photos and none remain with GPS, and the user
    // hasn't picked another method, clear it back so the chain can re-resolve.
    if (state.location_method === 'EXIF') {
      const anyGps = state.photos.find((ph) => ph && ph.exifLat != null);
      if (!anyGps) {
        state.lat = state.lon = null;
        state.location_method = null;
        state.location_confidence = null;
        syncMap(); updateLocStatus(); updateLocationContinue();
      }
    }
    renderPhotoGrid();
  }

  // --- EXIF ---------------------------------------------------------------
  async function extractExif(file) {
    let lat = null, lon = null, ts = null;
    try {
      const g = await window.exifr.gps(file);
      if (g && typeof g.latitude === 'number' && typeof g.longitude === 'number') {
        lat = g.latitude; lon = g.longitude;
      }
    } catch (_) { /* no GPS */ }
    try {
      // NB: the exifr "lite" build throws on the `pick` option, so read the
      // EXIF block and select the date fields ourselves.
      const meta = await window.exifr.parse(file, { tiff: true, exif: true });
      const d = meta && (meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate);
      if (d) {
        const date = d instanceof Date ? d : new Date(d);
        if (!isNaN(date.getTime())) ts = date.toISOString();
      }
    } catch (_) { /* no date */ }
    return { lat, lon, ts };
  }

  // --- Compression (Canvas; also strips all metadata for privacy) ---------
  async function compressImage(file) {
    const targetBytes = (settings.photo_target_kb || 200) * 1024;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      bitmap = await createImageBitmap(file);
    }
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();

    let quality = 0.85;
    let blob = await canvasToBlob(canvas, quality);
    while (blob && blob.size > targetBytes && quality > 0.4) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, quality);
    }
    return { blob, width: w, height: h };
  }
  function canvasToBlob(canvas, quality) {
    return new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  }

  async function sha256(blob) {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // =========================================================================
  // Location
  // =========================================================================
  function setCoords(lat, lon, method, accuracy) {
    state.lat = lat;
    state.lon = lon;
    state.location_method = method;
    // A real coordinate from EXIF / live GPS / a deliberate map tap is normal
    // confidence. Landmark-only fallback (no coordinate yet) is handled at commit.
    state.location_confidence = 'normal';
    state.accuracy = accuracy;
    syncMap();
    updateLocStatus();
    updateLocationContinue();
  }

  function useLiveGps() {
    const btn = document.getElementById('btn-use-gps');
    if (!navigator.geolocation) { showLocMessage(t('location.gpsUnavailable')); return; }
    if (btn) { btn.disabled = true; btn.querySelector('span').textContent = t('location.gpsLocating'); }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords(pos.coords.latitude, pos.coords.longitude, 'LiveGPS', pos.coords.accuracy);
        if (map) map.setView([pos.coords.latitude, pos.coords.longitude], 17);
        resetGpsButton();
      },
      (err) => {
        showLocMessage(err.code === 1 ? t('location.gpsDenied') : t('location.gpsUnavailable'));
        resetGpsButton();
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }
  function resetGpsButton() {
    const btn = document.getElementById('btn-use-gps');
    if (btn) { btn.disabled = false; btn.querySelector('span').textContent = t('location.useGps'); }
  }

  function initMapOnce() {
    if (map || typeof L === 'undefined') return;
    const start = (state.lat != null) ? [state.lat, state.lon] : [20, 0];
    const zoom = (state.lat != null) ? 17 : 2;
    map = L.map('map', { zoomControl: true }).setView(start, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    loadFootprints(); // demo building polygons, drawn under the marker
    map.on('click', (e) => {
      // If the tap lands inside a demo building footprint, snap the pin to that
      // building's centroid (still a normal-confidence map tap). Otherwise use the
      // raw tapped point exactly as before.
      const snapped = snapToBuilding(e.latlng.lat, e.latlng.lng);
      const ll = snapped || { lat: e.latlng.lat, lon: e.latlng.lng };
      setCoords(ll.lat, ll.lon, 'MapTap', null);
    });
  }

  // Load the STATIC footprint GeoJSON (sourced once at dev time; cached by the
  // service worker for offline use). One demo area only — never fetched live from
  // any external footprint service. Failure is non-fatal: the map still works.
  async function loadFootprints() {
    if (footprintFeatures.length || typeof L === 'undefined') return;
    try {
      const fc = await (await fetch('/data/buildings-demo.geojson')).json();
      footprintFeatures = (fc && fc.features) || [];
      // Default overlayPane sits below markerPane, so footprints draw under the
      // pin automatically; interactive:false lets taps pass through to the map.
      L.geoJSON(fc, {
        interactive: false,
        style: { color: '#1565c0', weight: 1, fillColor: '#1565c0', fillOpacity: 0.12 },
      }).addTo(map);
    } catch (_) { /* offline before first cache, or file missing — skip overlay */ }
  }

  // How close a tap must be (metres) to a building to snap to it when it didn't
  // land strictly inside any footprint.
  const SNAP_RADIUS_M = 25;

  // Snap a tap to a building centroid: a tap strictly INSIDE a footprint snaps to
  // that building; otherwise the tap snaps to the centroid of the NEAREST building
  // whose centroid is within SNAP_RADIUS_M. If nothing is near enough, returns null
  // and the caller drops the pin exactly where the user tapped.
  function snapToBuilding(lat, lon) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const f of footprintFeatures) {
      const ring = outerRing(f);
      if (!ring) continue;
      if (pointInRing(lat, lon, ring)) return polygonCentroid(ring); // inside wins outright
      const c = polygonCentroid(ring);
      const d = metresBetween(lat, lon, c.lat, c.lon);
      if (d <= SNAP_RADIUS_M && d < nearestDist) { nearest = c; nearestDist = d; }
    }
    return nearest; // nearest building within range, or null for a free-placed pin
  }

  // Great-circle distance in metres (haversine).
  function metresBetween(aLat, aLon, bLat, bLon) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function outerRing(feature) {
    const g = feature && feature.geometry;
    if (!g) return null;
    if (g.type === 'Polygon') return g.coordinates[0];
    if (g.type === 'MultiPolygon') return g.coordinates[0] && g.coordinates[0][0];
    return null;
  }

  // Ray-casting point-in-polygon. Ring is an array of [lon, lat] pairs.
  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = (yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Area-weighted centroid of a polygon ring ([lon, lat] pairs). Computed in a
  // local frame (offset by the first vertex) so the shoelace sums don't lose
  // precision to catastrophic cancellation — the raw lon/lat (~29, ~41) are huge
  // next to a building's ~0.0001° span, which would otherwise push the centroid
  // outside its own footprint.
  function polygonCentroid(ring) {
    const ox = ring[0][0], oy = ring[0][1];
    let area = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0] - ox, yi = ring[i][1] - oy;
      const xj = ring[j][0] - ox, yj = ring[j][1] - oy;
      const cross = xj * yi - xi * yj;
      area += cross;
      cx += (xi + xj) * cross;
      cy += (yi + yj) * cross;
    }
    if (Math.abs(area) < 1e-14) {
      // Degenerate ring — fall back to the average of the vertices.
      const n = ring.length;
      const sx = ring.reduce((s, p) => s + p[0], 0) / n;
      const sy = ring.reduce((s, p) => s + p[1], 0) / n;
      return { lat: sy, lon: sx };
    }
    area *= 0.5;
    return { lat: oy + cy / (6 * area), lon: ox + cx / (6 * area) };
  }

  // A clear, standard teardrop map-pin as an inline-SVG divIcon. Avoids Leaflet's
  // default PNG marker (whose auto-detected imagePath doubled onto our absolute
  // icon URLs produced a 404 / broken-image placeholder) and needs no image files.
  function pinIcon() {
    return L.divIcon({
      className: 'gt-pin',
      html: '<svg width="28" height="40" viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M14 1C7 1 1.5 6.5 1.5 13.5c0 8.7 11 24 12 25.2.3.4.7.4 1 0 1-1.2 12-16.5 12-25.2C26.5 6.5 21 1 14 1z" ' +
        'fill="#d32f2f" stroke="#ffffff" stroke-width="2"/>' +
        '<circle cx="14" cy="13.5" r="4.8" fill="#ffffff"/></svg>',
      iconSize: [28, 40],
      iconAnchor: [14, 39],   // tip of the teardrop sits on the point
      popupAnchor: [0, -34],
    });
  }

  function syncMap() {
    if (!map) return;
    if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
    if (state.lat == null) {
      if (marker) { map.removeLayer(marker); marker = null; }
      return;
    }
    const ll = [state.lat, state.lon];
    if (!marker) {
      marker = L.marker(ll, { draggable: true, icon: pinIcon() }).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        setCoords(p.lat, p.lng, 'MapTap', null);
      });
    } else {
      marker.setLatLng(ll);
    }
    if (state.accuracy && state.location_method === 'LiveGPS') {
      accuracyCircle = L.circle(ll, { radius: state.accuracy, color: '#1565c0', weight: 1, fillOpacity: 0.1 }).addTo(map);
    }
    if (map.getZoom() < 14) map.setView(ll, 17);
  }

  function methodLabel() {
    switch (state.location_method) {
      case 'EXIF': return t('location.methodEXIF');
      case 'LiveGPS': return t('location.methodLiveGPS');
      case 'MapTap': return t('location.methodMapTap');
      case 'Landmark': return t('location.methodLandmark');
      case 'Unknown': return t('location.methodUnknown');
      default: return null;
    }
  }

  function updateLocStatus() {
    const el = document.getElementById('loc-status');
    if (!el) return;
    const label = methodLabel();
    if (state.lat == null) {
      // No coordinate yet. If the user has typed a landmark, reflect that it
      // will be used as an approximate location; otherwise prompt for one.
      const lm = (document.getElementById('landmark-input')?.value || '').trim();
      if (lm) {
        el.className = 'loc-status set';
        el.innerHTML = `<strong>${escapeHtml(t('location.selected'))}:</strong> ${escapeHtml(t('location.methodLandmark'))}` +
          `<br><span class="loc-coords">${escapeHtml(t('location.landmarkApprox'))}</span>`;
        return;
      }
      el.className = 'loc-status none';
      el.textContent = t('location.none');
      return;
    }
    el.className = 'loc-status set';
    const coords = state.lat != null
      ? `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`
      : '—';
    let html = `<strong>${escapeHtml(t('location.selected'))}:</strong> ${escapeHtml(label || '')}`;
    if (state.lat != null) html += `<br><span class="loc-coords">${coords}</span>`;
    if (state.accuracy && state.location_method === 'LiveGPS') {
      html += ` <span class="loc-acc">${escapeHtml(t('location.gpsAccuracy', { m: Math.round(state.accuracy) }))}</span>`;
    }
    el.innerHTML = html;
  }

  function showLocMessage(msg) {
    const el = document.getElementById('loc-status');
    if (el) { el.className = 'loc-status msg'; el.textContent = msg; }
  }

  // True once the user has resolved a location one of the two required ways:
  // a real coordinate (EXIF / live GPS / map tap) OR a typed landmark.
  function hasResolvableLocation() {
    const lm = (document.getElementById('landmark-input')?.value || '').trim();
    return (state.lat != null && state.lon != null) || lm.length > 0;
  }

  // Gate the location-step Continue button: it stays disabled until the user
  // taps the map or types a landmark, so a report can no longer proceed with no
  // location at all (every record must end up with a coordinate — export schema).
  function updateLocationContinue() {
    const btn = document.getElementById('btn-location-continue');
    if (btn) btn.disabled = !hasResolvableLocation();
  }

  function commitLocation() {
    const lm = (document.getElementById('landmark-input')?.value || '').trim();
    if (state.lat != null && state.lon != null) {
      // A real coordinate is set (EXIF / live GPS / map tap). If the user ALSO
      // typed a landmark, keep it as a supplementary field; the coordinate wins.
      state.landmark_text = lm || null;
      if (!state.location_confidence) state.location_confidence = 'normal';
    } else if (lm) {
      // Landmark only — no coordinate was tapped. Pin the report at the current
      // map centre as an APPROXIMATE fallback (so the record still carries a
      // coordinate) and flag it low-confidence with method 'Landmark', so an
      // analyst can see it is approximate and geocode the landmark text later.
      const center = map ? map.getCenter() : null;
      state.lat = center ? center.lat : null;
      state.lon = center ? center.lng : null;
      state.location_method = 'Landmark';
      state.location_confidence = 'low';
      state.landmark_text = lm;
    } else {
      // No coordinate and no landmark. Continue is disabled in this state, so
      // this is only a defensive fallback and never reached in normal use.
      state.location_method = 'Unknown';
      state.location_confidence = null;
      state.landmark_text = null;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
