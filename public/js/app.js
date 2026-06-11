/* GroundTruth Reporter page logic.
 * Step 1 (Foundation): screen navigation framework + live contribution counter.
 * Later steps plug the photo/location/hazard/AI/submit screens into this. */
document.addEventListener('gt:shellready', () => {
  const screens = Array.from(document.querySelectorAll('.screen'));
  function showScreen(id) {
    screens.forEach((s) => s.classList.toggle('active', s.id === id));
    window.scrollTo(0, 0);
  }
  window.GT_showScreen = showScreen; // later steps reuse this

  document.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', () => showScreen(el.getAttribute('data-go')));
  });

  // --- Live community contribution counter ---------------------------------
  const counterEl = document.getElementById('contrib-counter');
  let lastTotal = 0;
  function renderCounter() {
    if (counterEl) counterEl.textContent = window.i18next.t('counter.contributions', { count: lastTotal });
  }
  async function loadCount() {
    try {
      const r = await fetch('/api/stats');
      if (r.ok) lastTotal = (await r.json()).total ?? lastTotal;
    } catch (_) { /* offline — keep last known total */ }
    renderCounter();
  }
  loadCount();
  window.GT_refreshCount = loadCount; // Step 4 calls this after a successful submit
  // Language switch re-renders instantly from the cached total (no fetch lag).
  document.addEventListener('gt:languagechanged', renderCounter);
});
