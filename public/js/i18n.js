/* GroundTruth i18n — wraps i18next.
 * All 6 UN languages. Adding a new language = drop a /locales/<code>.json file
 * and one entry in SUPPORTED below — zero other code changes.
 * Handles RTL (Arabic) by setting <html dir>. */
(function () {
  const SUPPORTED = [
    { code: 'en', name: 'English',  dir: 'ltr' },
    { code: 'ar', name: 'العربية',  dir: 'rtl' },
    { code: 'zh', name: '中文',      dir: 'ltr' },
    { code: 'fr', name: 'Français',  dir: 'ltr' },
    { code: 'ru', name: 'Русский',   dir: 'ltr' },
    { code: 'es', name: 'Español',   dir: 'ltr' }
  ];
  const FALLBACK = 'en';
  const loaded = {}; // code -> resource object

  async function loadResource(code) {
    if (loaded[code]) return loaded[code];
    const res = await fetch(`/locales/${code}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`locale ${code} failed to load`);
    loaded[code] = await res.json();
    return loaded[code];
  }

  function isSupported(code) {
    return SUPPORTED.some((s) => s.code === code);
  }

  function detect() {
    const saved = localStorage.getItem('gt_lang');
    if (saved && isSupported(saved)) return saved;
    const navs = navigator.languages || [navigator.language || 'en'];
    for (const l of navs) {
      const base = String(l).toLowerCase().split('-')[0];
      if (isSupported(base)) return base;
    }
    return FALLBACK;
  }

  function dirOf(code) {
    const s = SUPPORTED.find((x) => x.code === code);
    return s ? s.dir : 'ltr';
  }

  function setDocLang(code) {
    document.documentElement.lang = code;
    document.documentElement.dir = dirOf(code);
  }

  function applyTranslations(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = window.i18next.t(el.getAttribute('data-i18n'));
    });
    // attributes, e.g. data-i18n-attr="placeholder:key;aria-label:key2"
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, window.i18next.t(key));
      });
    });
    const titleKey = document.documentElement.getAttribute('data-i18n-title');
    if (titleKey) document.title = window.i18next.t(titleKey);
  }

  async function changeLanguage(code) {
    if (!isSupported(code)) return;
    await loadResource(code);
    if (!window.i18next.hasResourceBundle(code, 'translation')) {
      window.i18next.addResourceBundle(code, 'translation', loaded[code], true, true);
    }
    await window.i18next.changeLanguage(code);
    localStorage.setItem('gt_lang', code);
    setDocLang(code);
    applyTranslations();
    document.dispatchEvent(new CustomEvent('gt:languagechanged', { detail: { code } }));
  }

  async function init() {
    const initial = detect();
    await Promise.all([
      loadResource(initial),
      initial === FALLBACK ? Promise.resolve() : loadResource(FALLBACK)
    ]);
    const resources = {
      [FALLBACK]: { translation: loaded[FALLBACK] }
    };
    resources[initial] = { translation: loaded[initial] };
    await window.i18next.init({
      lng: initial,
      fallbackLng: FALLBACK,
      resources,
      interpolation: { escapeValue: false }
    });
    setDocLang(initial);
    applyTranslations();
    return initial;
  }

  window.GT_I18N = {
    SUPPORTED,
    init,
    changeLanguage,
    applyTranslations,
    current: () => window.i18next.language,
    dirOf,
    t: (...args) => window.i18next.t(...args)
  };
})();
