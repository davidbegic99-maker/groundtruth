// GroundTruth — AI damage classification (Section 8 engineering methodology).
//
// The prototype uses the Claude vision API when ANTHROPIC_API_KEY is set.
// When it is NOT set (the common evaluator case), a deterministic mock
// classifier runs instead so the ENTIRE flow — including conflict detection —
// remains testable offline with zero configuration. The production pathway
// (LLaVA / CLIP, open source) is documented in the README.
//
// Output is ALWAYS one of three UNDP tiers — Minimal / Partial / Complete —
// plus a 0..1 confidence and a 0..100 analyst-only damage percentage, and a
// suggested infrastructure type from the 7 mandatory categories.

import crypto from 'node:crypto';

export const DAMAGE_TIERS = ['Minimal', 'Partial', 'Complete'];

export const INFRASTRUCTURE_TYPES = [
  'Residential Infrastructure',
  'Commercial Infrastructure',
  'Government Building',
  'Utility Infrastructure',
  'Transport and Communication Infrastructure',
  'Community Infrastructure',
  'Public Spaces / Recreation Infrastructure',
];

// Hazard-specific visual weighting (Section 8.3) — fed to the model as context.
const HAZARD_WEIGHTING = {
  Earthquake: 'Use the full ATC-20 visual indicator set as the primary reference.',
  Flood: 'Weight foundation undermining, wall-base erosion, waterline staining, wall bowing from hydrostatic pressure, roof uplift.',
  Tsunami: 'Weight lateral hydrostatic loading, foundation scour, debris-impact patterns on walls.',
  'Hurricane / Cyclone': 'Weight foundation undermining, wall-base erosion, waterline staining, wall bowing, roof uplift.',
  Wildfire: 'Weight structural steel deformation from heat, roof collapse from ember intrusion, wall framing burned through vs. surface char only.',
  Explosion: 'Weight blast-radius damage pattern, structural penetration, debris-scatter pattern.',
  'Chemical Incident': 'Weight blast-radius damage pattern, structural penetration, debris-scatter pattern.',
  Conflict: 'Weight blast-damage patterns, spalling from shrapnel, window-frame blow-out, structural penetration vs. surface damage.',
  'Civil Unrest': 'Weight blast-damage patterns, spalling from shrapnel, window-frame blow-out, structural penetration vs. surface damage.',
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function classify({ photosBase64 = [], hazardType = null }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && photosBase64.length) {
    try {
      return await classifyWithClaude({ photosBase64, hazardType, key });
    } catch (err) {
      console.warn('[classify] Claude API failed, using mock:', err.message);
    }
  }
  return mockClassify({ photosBase64, hazardType });
}

// ---------------------------------------------------------------------------
// Claude vision path
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a structural damage assessor for UNDP disaster response. You classify building damage from community photos into EXACTLY one of three UNDP tiers. There is no fourth tier and no "uncertain" tier — uncertainty is expressed only through the confidence score.

FIVE-STANDARD CROSS-WALK — ATC-20, EMS-98, Copernicus EMS, the xBD Joint Damage Scale, and FEMA P-154 (Rapid Visual Screening of Buildings for Potential Seismic Hazards) — map to the UNDP tier:
- Minimal  = ATC-20 GREEN/Inspected; EMS-98 grades 1-2; Copernicus "No Damage" OR "Possibly Damaged"; xBD "No Damage" OR "Minor Damage"; FEMA P-154 "no significant structural or falling hazards observed — passes rapid visual screening".
- Partial  = ATC-20 YELLOW/Restricted; EMS-98 grades 3-4; Copernicus "Damaged"; xBD "Major Damage"; FEMA P-154 "visible structural or falling hazards — flagged for detailed engineering evaluation".
- Complete = ATC-20 RED/Unsafe; EMS-98 grade 5; Copernicus "Destroyed"; xBD "Destroyed"; FEMA P-154 "severe structural hazard / collapse potential — immediate detailed evaluation".

TIER 1 MINIMAL (any alone = Minimal): no structural cracking or only hairline cosmetic cracks; no deformation of columns/beams/load-bearing walls; windows intact or corner-cracked without frame distortion; roof/floor lines horizontal; foundation/lower walls show no fractures; ground shows no fissures; doors/windows still plumb and operable.

TIER 2 PARTIAL (any = Partial unless a Tier 3 indicator is present): diagonal/X-cracking at corners or around openings; concrete spalling exposing rebar without full section loss; non-catastrophic racking (leaning but standing); partial chimney/parapet failure without main collapse; visible roof sag but standing; broken windows across more than one elevation without frame collapse; foundation cracking but building not displaced; moderate ground settlement.

TIER 3 COMPLETE (any ONE alone = Complete): full or partial collapse of roof/floor; building or any story out of plumb/leaning; collapse of primary vertical members; building displaced off foundation; severe racking of whole wall bays; large ground fissures with slope displacement; X-cracking across >60% of a story's windows; pancake collapse.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"damage_tier":"Minimal|Partial|Complete","confidence":0.0-1.0,"damage_percentage":0-100,"infrastructure_type":"<one of the 7>","rationale":"one short sentence citing the visual indicator(s) you used"}

The 7 infrastructure types: ${INFRASTRUCTURE_TYPES.join('; ')}.`;

async function classifyWithClaude({ photosBase64, hazardType, key }) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const weighting = HAZARD_WEIGHTING[hazardType] || '';
  const content = [];
  for (const b64 of photosBase64.slice(0, 2)) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: stripDataUrl(b64) },
    });
  }
  content.push({
    type: 'text',
    text:
      `Hazard reported by the community member: ${hazardType || 'unspecified'}.` +
      (weighting ? ` ${weighting}` : '') +
      ' Classify the building damage in the photo(s).',
  });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim();
  const parsed = JSON.parse(extractJson(text));
  return normalize(parsed, 'claude');
}

// ---------------------------------------------------------------------------
// Deterministic mock path (no API key required)
// ---------------------------------------------------------------------------

function mockClassify({ photosBase64, hazardType }) {
  // Seed from the first photo's bytes so the same photo always yields the same
  // suggestion (reproducible demos); fall back to the hazard string.
  const seedSrc = photosBase64[0] ? stripDataUrl(photosBase64[0]).slice(0, 512) : (hazardType || 'seed');
  const h = crypto.createHash('sha256').update(seedSrc).digest();
  const n = h[0] + h[1] * 256; // 0..65535

  // Bias toward Partial (the most common real-world field outcome).
  const tier = n % 5 === 0 ? 'Complete' : n % 5 === 1 ? 'Minimal' : 'Partial';
  const confidence = +(0.6 + (h[2] % 38) / 100).toFixed(2); // 0.60..0.97
  const pctBase = tier === 'Minimal' ? 5 : tier === 'Partial' ? 45 : 85;
  const damage_percentage = Math.min(100, Math.max(0, pctBase + (h[3] % 20) - 8));
  const infrastructure_type = INFRASTRUCTURE_TYPES[h[4] % INFRASTRUCTURE_TYPES.length];

  return normalize(
    {
      damage_tier: tier,
      confidence,
      damage_percentage,
      infrastructure_type,
      rationale: 'Prototype mock estimate (no API key configured) — confirm or correct below.',
    },
    'mock'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(p, source) {
  let tier = String(p.damage_tier || '').trim();
  if (!DAMAGE_TIERS.includes(tier)) tier = 'Partial';
  let conf = Number(p.confidence);
  if (!Number.isFinite(conf)) conf = 0.7;
  conf = Math.min(1, Math.max(0, conf));
  let pct = Number(p.damage_percentage);
  if (!Number.isFinite(pct)) pct = tier === 'Minimal' ? 5 : tier === 'Partial' ? 45 : 85;
  pct = Math.min(100, Math.max(0, pct));
  let infra = String(p.infrastructure_type || '').trim();
  if (!INFRASTRUCTURE_TYPES.includes(infra)) infra = 'Residential Infrastructure';
  return {
    ai_suggested_damage: tier,
    ai_confidence: conf,
    ai_damage_percentage: pct,
    infrastructure_type: infra,
    rationale: String(p.rationale || '').slice(0, 300),
    source,
  };
}

function stripDataUrl(b64) {
  const i = b64.indexOf('base64,');
  return i >= 0 ? b64.slice(i + 7) : b64;
}

function extractJson(text) {
  // Tolerate accidental markdown fences or surrounding prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
