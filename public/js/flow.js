/* GroundTruth Reporter wizard — Step 3: hazard → AI assessment → questions →
 * review. Reads/extends the shared report state (window.GTReport) started in
 * report.js and hands a complete report object to Step 4 (submit).
 *
 * Screens owned here: screen-hazard, screen-assess, screen-questions, screen-review.
 */
(function () {
  const t = (k, o) => window.i18next.t(k, o);
  const D = () => window.GT_DATA;
  const state = window.GTReport; // shared object from report.js

  // Step-3 fields layered onto the shared report state.
  Object.assign(state, {
    hazard_type: null,
    infrastructure_type: null,
    damage_classification: null,
    ai_suggested_damage: null,
    ai_confidence: null,
    ai_damage_percentage: null, // analyst-only — never rendered to the user
    ai_rationale: null,
    ai_source: null,
    people_in_danger: null,
    priority_flag: false,
    dynamic_q1_answer: null,
    dynamic_q2_answer: null,
    description_text: null,
  });

  let selectedGroupId = null;
  let aiCache = { key: null, result: null }; // avoid re-classifying the same photos+hazard

  // =========================================================================
  // Boot / navigation wiring
  // =========================================================================
  document.addEventListener('gt:shellready', () => {
    document.getElementById('btn-hazard-continue')?.addEventListener('click', goAssess);
    document.getElementById('btn-assess-continue')?.addEventListener('click', goQuestions);
    document.getElementById('btn-questions-continue')?.addEventListener('click', goReview);
    document.getElementById('btn-submit')?.addEventListener('click', onSubmit);

    const desc = document.getElementById('desc-input');
    desc?.addEventListener('input', () => { state.description_text = desc.value.trim() || null; });

    document.addEventListener('gt:locationcommitted', buildHazardScreen);
    document.addEventListener('gt:reportreset', resetStep3);

    // Re-render visible dynamic content when the language switches.
    document.addEventListener('gt:languagechanged', () => {
      buildHazardScreen(true);
      if (lastAi) renderAiBox(lastAi);
      renderDamageChoices();
      renderInfraChoices();
      renderMandatory();
      renderOptional();
      renderSafetyBanners();
      if (isActive('screen-review')) renderReview();
    });
  });

  function isActive(id) {
    const el = document.getElementById(id);
    return el && el.classList.contains('active');
  }

  function resetStep3() {
    Object.assign(state, {
      hazard_type: null, infrastructure_type: null, damage_classification: null,
      ai_suggested_damage: null, ai_confidence: null, ai_damage_percentage: null,
      ai_rationale: null, ai_source: null, people_in_danger: null, priority_flag: false,
      dynamic_q1_answer: null, dynamic_q2_answer: null, description_text: null,
    });
    selectedGroupId = null;
    aiCache = { key: null, result: null };
    lastAi = null;
    const desc = document.getElementById('desc-input');
    if (desc) desc.value = '';
  }

  // =========================================================================
  // Screen 1 — Hazard selection (two-level)
  // =========================================================================
  function buildHazardScreen(preserve) {
    const groupsEl = document.getElementById('hazard-groups');
    if (!groupsEl) return;
    groupsEl.innerHTML = '';
    D().HAZARD_GROUPS.forEach((g) => {
      const btn = choiceCard({
        label: t(g.key),
        selected: g.id === selectedGroupId,
        onClick: () => selectGroup(g.id),
      });
      groupsEl.appendChild(btn);
    });
    if (preserve && selectedGroupId) renderHazardTypes();
    else if (!preserve) { selectedGroupId = null; document.getElementById('hazard-types-wrap').hidden = true; }
    updateHazardContinue();
  }

  function selectGroup(groupId) {
    selectedGroupId = groupId;
    buildHazardScreen(true);
    document.getElementById('hazard-types-wrap').hidden = false;
  }

  function renderHazardTypes() {
    const wrap = document.getElementById('hazard-types-wrap');
    const el = document.getElementById('hazard-types');
    if (!el) return;
    const group = D().HAZARD_GROUPS.find((g) => g.id === selectedGroupId);
    if (!group) { wrap.hidden = true; return; }
    wrap.hidden = false;
    el.innerHTML = '';
    group.types.forEach((value) => {
      el.appendChild(choiceCard({
        label: D().hazardLabel(value),
        selected: state.hazard_type === value,
        onClick: () => selectHazard(value),
      }));
    });
  }

  function selectHazard(value) {
    state.hazard_type = value;
    renderHazardTypes();
    renderSafetyBanners();
    updateHazardContinue();
  }

  function updateHazardContinue() {
    const btn = document.getElementById('btn-hazard-continue');
    if (btn) btn.disabled = !state.hazard_type;
  }

  // =========================================================================
  // Screen 2 — AI assessment + confirmation
  // =========================================================================
  let lastAi = null;

  function goAssess() {
    window.GT_showScreen('screen-assess');
    renderSafetyBanners();
    renderDamageChoices();
    renderInfraChoices();
    updateAssessContinue();
    runClassification();
  }

  async function runClassification() {
    const box = document.getElementById('ai-box');
    const photos = (state.photos || []).filter(Boolean);
    const cacheKey = (state.hazard_type || '') + '|' + photos.map((p) => p.hash).join(',');

    // Reuse a prior result for the same photos + hazard.
    if (aiCache.key === cacheKey && aiCache.result) {
      applyAi(aiCache.result);
      return;
    }

    // Offline or no photos → manual selection, no AI call.
    if (!navigator.onLine || photos.length === 0) {
      lastAi = null;
      if (box) {
        box.innerHTML = `<div class="ai-unavailable">${escapeHtml(
          !navigator.onLine ? t('assess.offline') : t('assess.noPhoto')
        )}</div>`;
      }
      return;
    }

    if (box) box.innerHTML = `<div class="ai-spinner"><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(t('assess.analyzing'))}</span></div>`;

    try {
      const b64s = await Promise.all(photos.slice(0, 2).map((p) => blobToBase64(p.blob)));
      const r = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photos: b64s, hazard_type: state.hazard_type }),
      });
      if (!r.ok) throw new Error('classify HTTP ' + r.status);
      const result = await r.json();
      aiCache = { key: cacheKey, result };
      applyAi(result);
    } catch (err) {
      console.warn('classification failed', err);
      lastAi = null;
      if (box) box.innerHTML = `<div class="ai-unavailable">${escapeHtml(t('assess.failed'))}</div>`;
    }
  }

  function applyAi(result) {
    lastAi = result;
    // Store AI fields (Section 4). damage_percentage is analyst-only.
    state.ai_suggested_damage = result.ai_suggested_damage;
    state.ai_confidence = result.ai_confidence;
    state.ai_damage_percentage = result.ai_damage_percentage;
    state.ai_rationale = result.rationale;
    state.ai_source = result.source;
    // Pre-fill the user's confirmable choices with the AI suggestion.
    if (!state.damage_classification) state.damage_classification = result.ai_suggested_damage;
    if (!state.infrastructure_type) state.infrastructure_type = result.infrastructure_type;
    renderAiBox(result);
    renderDamageChoices();
    renderInfraChoices();
    updateAssessContinue();
  }

  function renderAiBox(result) {
    const box = document.getElementById('ai-box');
    if (!box) return;
    const pct = Math.round((result.ai_confidence || 0) * 100);
    const tierLabel = D().damageLabel(result.ai_suggested_damage);
    const tierCls = D().damageClass(result.ai_suggested_damage);
    let html = `<div class="ai-result">`;
    html += `<div class="ai-result-head"><span class="ai-chip">${escapeHtml(t('assess.aiSuggests'))}</span></div>`;
    html += `<div class="ai-tier ${tierCls}">${escapeHtml(tierLabel)}</div>`;
    html += `<div class="ai-conf">${escapeHtml(t('assess.confidence', { pct }))}</div>`;
    html += `<div class="ai-infra">${escapeHtml(t('assess.aiInfra'))}: <strong>${escapeHtml(D().infraLabel(result.infrastructure_type))}</strong></div>`;
    if (result.rationale) html += `<div class="ai-rationale">${escapeHtml(result.rationale)}</div>`;
    if (result.source === 'mock') html += `<div class="ai-note">${escapeHtml(t('assess.mockNote'))}</div>`;
    html += `<div class="ai-confirm-hint">${escapeHtml(t('assess.confirmHint'))}</div>`;
    html += `</div>`;
    box.innerHTML = html;
  }

  function renderDamageChoices() {
    const el = document.getElementById('damage-choices');
    if (!el) return;
    el.innerHTML = '';
    D().DAMAGE.forEach((d) => {
      el.appendChild(choiceCard({
        label: t(d.key),
        desc: t(d.descKey),
        selected: state.damage_classification === d.value,
        extraClass: 'damage-choice ' + d.cls,
        onClick: () => { state.damage_classification = d.value; renderDamageChoices(); updateAssessContinue(); },
      }));
    });
  }

  function renderInfraChoices() {
    const el = document.getElementById('infra-choices');
    if (!el) return;
    el.innerHTML = '';
    D().INFRASTRUCTURE.forEach((i) => {
      el.appendChild(choiceCard({
        label: t(i.key),
        desc: t(i.descKey),
        selected: state.infrastructure_type === i.value,
        onClick: () => { state.infrastructure_type = i.value; renderInfraChoices(); updateAssessContinue(); },
      }));
    });
  }

  function updateAssessContinue() {
    const btn = document.getElementById('btn-assess-continue');
    if (btn) btn.disabled = !(state.damage_classification && state.infrastructure_type);
  }

  // =========================================================================
  // Screen 3 — Mandatory + optional questions
  // =========================================================================
  function goQuestions() {
    window.GT_showScreen('screen-questions');
    renderSafetyBanners();
    renderMandatory();
    renderOptional();
    const desc = document.getElementById('desc-input');
    if (desc) desc.value = state.description_text || '';
    updateQuestionsContinue();
  }

  function renderMandatory() {
    const labelEl = document.getElementById('mandatory-label');
    if (labelEl) labelEl.textContent = t(D().MANDATORY.key);
    const el = document.getElementById('mandatory-choices');
    if (!el) return;
    el.innerHTML = '';
    D().MANDATORY.options.forEach((o) => {
      el.appendChild(choiceCard({
        label: t(o.key),
        selected: state.people_in_danger === o.value,
        extraClass: o.value === 'Yes' ? 'danger-choice' : '',
        onClick: () => {
          state.people_in_danger = o.value;
          state.priority_flag = o.value === 'Yes';
          renderMandatory();
          updateQuestionsContinue();
        },
      }));
    });
  }

  function renderOptional() {
    const wrap = document.getElementById('optional-questions');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.hazard_type) return;
    const qs = D().questionsFor(state.hazard_type);
    qs.forEach((q, idx) => {
      const field = idx === 0 ? 'dynamic_q1_answer' : 'dynamic_q2_answer';
      const fs = document.createElement('fieldset');
      fs.className = 'choice-fieldset optional';
      const legend = document.createElement('legend');
      legend.innerHTML = `${escapeHtml(t(q.key))} <span class="opt-tag">${escapeHtml(t('common.optional'))}</span>`;
      fs.appendChild(legend);
      const grid = document.createElement('div');
      grid.className = 'choice-grid';
      q.options.forEach((o) => {
        grid.appendChild(choiceCard({
          label: t(o.key),
          selected: state[field] === o.value,
          onClick: () => {
            // Toggle: clicking the selected option again clears it (optional).
            state[field] = state[field] === o.value ? null : o.value;
            renderOptional();
          },
        }));
      });
      fs.appendChild(grid);
      wrap.appendChild(fs);
    });
  }

  function updateQuestionsContinue() {
    const btn = document.getElementById('btn-questions-continue');
    if (btn) btn.disabled = !state.people_in_danger; // mandatory must be answered
  }

  // =========================================================================
  // Screen 4 — Review
  // =========================================================================
  function goReview() {
    window.GT_showScreen('screen-review');
    renderSafetyBanners();
    renderReview();
  }

  function renderReview() {
    const el = document.getElementById('review-summary');
    if (!el) return;
    const photos = (state.photos || []).filter(Boolean);
    const coords = state.lat != null ? `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}` : '—';

    // Mirror the Location step: a low-confidence (landmark/approximate) location is
    // labelled "Approximate location" with the landmark note, so a placeholder-looking
    // coordinate (e.g. a landmark pinned at the map centre) doesn't make the reporter
    // doubt their submission. A precise device-GPS / map-tap coordinate stays normal.
    const approx = state.location_confidence === 'low' && state.lat != null;
    let locationCell, locationCls = '';
    if (approx) {
      locationCls = 'review-approx';
      locationCell =
        `<span class="review-approx-label">${escapeHtml(t('location.methodLandmark'))}</span>` +
        `<span class="review-coords">${escapeHtml(coords)}</span>` +
        `<span class="review-approx-note">${escapeHtml(t('location.landmarkApprox'))}</span>` +
        (state.landmark_text ? `<span class="review-landmark">${escapeHtml(state.landmark_text)}</span>` : '');
    } else {
      locationCell = escapeHtml(coords);
    }

    const rows = [
      [t('review.hazard'), state.hazard_type ? D().hazardLabel(state.hazard_type) : '—'],
      [t('review.damage'), state.damage_classification ? D().damageLabel(state.damage_classification) : '—', D().damageClass(state.damage_classification)],
      [t('review.infra'), state.infrastructure_type ? D().infraLabel(state.infrastructure_type) : '—'],
      [t('review.location'), locationCell, locationCls, true],
      [t('review.danger'), state.people_in_danger ? mandatoryLabel(state.people_in_danger) : '—', state.priority_flag ? 'review-priority' : ''],
      [t('review.photos'), `${photos.length} / 3`],
    ];
    let html = '<dl class="review-list">';
    // `raw` rows carry pre-escaped HTML (the approximate-location cell); all others
    // are plain text and get escaped here.
    rows.forEach(([k, v, cls, raw]) => {
      html += `<dt>${escapeHtml(k)}</dt><dd class="${cls || ''}">${raw ? v : escapeHtml(String(v))}</dd>`;
    });
    html += '</dl>';

    if (state.priority_flag) {
      html += `<div class="review-flag priority">⚑ ${escapeHtml(t('review.priorityNote'))}</div>`;
    }

    // Show captured optional answers, if any.
    const opt = [];
    const qs = D().questionsFor(state.hazard_type);
    if (state.dynamic_q1_answer && qs[0]) opt.push([t(qs[0].key), optionLabel(qs[0], state.dynamic_q1_answer)]);
    if (state.dynamic_q2_answer && qs[1]) opt.push([t(qs[1].key), optionLabel(qs[1], state.dynamic_q2_answer)]);
    if (opt.length) {
      html += '<dl class="review-list sub">';
      opt.forEach(([k, v]) => { html += `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`; });
      html += '</dl>';
    }
    if (state.description_text) {
      html += `<div class="review-desc"><strong>${escapeHtml(t('questions.descLabel'))}:</strong> ${escapeHtml(state.description_text)}</div>`;
    }

    if (photos.length) {
      html += '<div class="review-photos">';
      photos.forEach((p, i) => { html += `<img src="${p.url}" alt="photo ${i + 1}" />`; });
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function mandatoryLabel(value) {
    const o = D().MANDATORY.options.find((x) => x.value === value);
    return o ? t(o.key) : value;
  }
  function optionLabel(q, value) {
    const o = q.options.find((x) => x.value === value);
    return o ? t(o.key) : value;
  }

  // =========================================================================
  // Submit (real submission is wired in Step 4 via window.GT_submitReport)
  // =========================================================================
  function onSubmit() {
    const errEl = document.getElementById('submit-error');
    if (errEl) errEl.hidden = true;
    // The Submit click must ALWAYS produce a visible result — never a silent
    // no-op. We surface three failure modes that a silent handler would hide:
    //   1. the Step-4 submit module never loaded (e.g. a stale/partial bundle),
    //   2. a synchronous throw before the queue write, and
    //   3. an async rejection from the (un-awaited) submit promise.
    // Each shows the translated submit error and re-enables the button.
    try {
      if (typeof window.GT_submitReport !== 'function') {
        throw new Error('submit module (GT_submitReport) not available');
      }
      const result = window.GT_submitReport();
      if (result && typeof result.catch === 'function') result.catch(reportSubmitFailure);
    } catch (err) {
      reportSubmitFailure(err);
    }
  }

  function reportSubmitFailure(err) {
    console.error('[submit] could not start', err);
    const errEl = document.getElementById('submit-error');
    if (errEl) { errEl.hidden = false; errEl.textContent = t('review.submitError'); }
    const btn = document.getElementById('btn-submit');
    if (btn) btn.disabled = false;
  }

  // Expose the assembled report for Step 4.
  window.GT_buildReport = snapshotReport;
  function snapshotReport() {
    return {
      timestamp: state.timestamp,
      lat: state.lat,
      lon: state.lon,
      location_method: state.location_method,
      location_confidence: state.location_confidence,
      landmark_text: state.landmark_text,
      hazard_type: state.hazard_type,
      infrastructure_type: state.infrastructure_type,
      damage_classification: state.damage_classification,
      ai_suggested_damage: state.ai_suggested_damage,
      ai_confidence: state.ai_confidence,
      ai_damage_percentage: state.ai_damage_percentage,
      ai_source: state.ai_source,
      people_in_danger: state.people_in_danger,
      priority_flag: state.priority_flag,
      dynamic_q1_answer: state.dynamic_q1_answer,
      dynamic_q2_answer: state.dynamic_q2_answer,
      description_text: state.description_text,
      photos: (state.photos || []).filter(Boolean),
    };
  }

  // =========================================================================
  // Safety banners (Conflict / Chemical) — Section 7
  // =========================================================================
  function renderSafetyBanners() {
    const h = state.hazard_type ? D().HAZARDS[state.hazard_type] : null;
    const safety = h ? h.safety : null;
    ['safety-banner-assess', 'safety-banner-questions', 'safety-banner-review'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (!safety) { el.hidden = true; el.textContent = ''; return; }
      el.hidden = false;
      el.className = 'safety-banner ' + safety;
      el.textContent = (safety === 'chemical' ? '⚠ ' : '🛈 ') + t(safety === 'chemical' ? 'safety.chemical' : 'safety.conflict');
    });
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  function choiceCard({ label, desc, selected, onClick, extraClass }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice' + (selected ? ' selected' : '') + (extraClass ? ' ' + extraClass : '');
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    let inner = `<span class="choice-label">${escapeHtml(label)}</span>`;
    if (desc) inner += `<span class="choice-desc">${escapeHtml(desc)}</span>`;
    if (selected) inner += `<span class="choice-tick" aria-hidden="true">✓</span>`;
    btn.innerHTML = inner;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]); // strip data: prefix
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
