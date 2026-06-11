/* GroundTruth shared shell — language selector, online/offline indicator,
 * service worker registration, install prompt. Used by both Reporter and
 * Analyst pages. Fires `gt:shellready` once i18n is initialised. */
(async function () {
  try {
    await window.GT_I18N.init();
  } catch (e) {
    console.error('i18n init failed', e);
  }

  // --- Language selector ---------------------------------------------------
  const sel = document.getElementById('lang-select');
  if (sel) {
    window.GT_I18N.SUPPORTED.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.code;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
    sel.value = window.GT_I18N.current();
    sel.addEventListener('change', () => window.GT_I18N.changeLanguage(sel.value));
    document.addEventListener('gt:languagechanged', (e) => {
      if (sel.value !== e.detail.code) sel.value = e.detail.code;
    });
  }

  // --- Network indicator + offline banner ----------------------------------
  const indicator = document.getElementById('net-indicator');
  const banner = document.getElementById('net-banner');
  function updateNet() {
    const online = navigator.onLine;
    if (indicator) {
      indicator.textContent = window.i18next.t(online ? 'status.online' : 'status.offline');
      indicator.classList.toggle('is-online', online);
      indicator.classList.toggle('is-offline', !online);
    }
    if (banner) {
      banner.hidden = online;
      if (!online) banner.textContent = window.i18next.t('status.offlineBanner');
    }
    document.body.classList.toggle('is-offline', !online);
  }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  document.addEventListener('gt:languagechanged', updateNet);
  updateNet();

  // --- Service worker (offline-first) --------------------------------------
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (e) {
      console.warn('Service worker registration failed', e);
    }
  }

  // --- PWA install prompt ---------------------------------------------------
  let deferredPrompt = null;
  const installBtn = document.getElementById('btn-install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  }

  document.dispatchEvent(new CustomEvent('gt:shellready'));
})();
