// GroundTruth — server-side translation of user description text (§10.4).
//
// User text is stored AS-IS in any language. LibreTranslate (open source,
// self-hostable, 50+ languages) produces an English translation that is stored
// alongside the original, plus the detected language code. This is optional and
// fails safe: if no LibreTranslate endpoint is configured (the default for the
// offline evaluator demo), translation is simply skipped and the original text
// is retained — nothing breaks.
//
// Enable by setting LIBRETRANSLATE_URL (e.g. http://localhost:5000) and,
// if the instance requires it, LIBRETRANSLATE_API_KEY. Documented in the README.

export function translationEnabled() {
  return !!process.env.LIBRETRANSLATE_URL;
}

// Returns { translated, detected } or null when disabled/unavailable.
export async function translateToEnglish(text) {
  const base = process.env.LIBRETRANSLATE_URL;
  if (!base || !text || !String(text).trim()) return null;
  const resp = await fetch(base.replace(/\/$/, '') + '/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      q: String(text),
      source: 'auto',
      target: 'en',
      format: 'text',
      ...(process.env.LIBRETRANSLATE_API_KEY ? { api_key: process.env.LIBRETRANSLATE_API_KEY } : {}),
    }),
  });
  if (!resp.ok) throw new Error('LibreTranslate HTTP ' + resp.status);
  const data = await resp.json();
  return {
    translated: data.translatedText || null,
    detected: (data.detectedLanguage && data.detectedLanguage.language) || null,
  };
}
