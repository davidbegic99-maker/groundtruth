/* GroundTruth canonical reference data (shared by Reporter + Analyst).
 *
 * The `value` fields are the exact English enum values stored in the database
 * (Sections 4, 5, 6). The `key` fields are i18n keys for DISPLAY only — every
 * visible string is translated, nothing is hardcoded in the UI.
 *
 * Adding/altering categories here is the single source of truth. */
(function () {
  // --- Hazard types, grouped two-level (Section 6) -------------------------
  const HAZARD_GROUPS = [
    {
      id: 'natural',
      key: 'hazard.group.natural',
      types: ['Earthquake', 'Flood', 'Tsunami', 'Hurricane / Cyclone', 'Wildfire'],
    },
    {
      id: 'tech',
      key: 'hazard.group.tech',
      types: ['Explosion', 'Chemical Incident'],
    },
    {
      id: 'human',
      key: 'hazard.group.human',
      types: ['Conflict', 'Civil Unrest'],
    },
  ];

  // canonical hazard value -> display key + which question set + safety banner
  const HAZARDS = {
    'Earthquake':         { key: 'hazard.type.earthquake', qset: 'earthquake', safety: null },
    'Flood':              { key: 'hazard.type.flood',      qset: 'flood',      safety: null },
    'Tsunami':            { key: 'hazard.type.tsunami',    qset: 'tsunami',    safety: null },
    'Hurricane / Cyclone':{ key: 'hazard.type.hurricane',  qset: 'hurricane',  safety: null },
    'Wildfire':           { key: 'hazard.type.wildfire',   qset: 'wildfire',   safety: null },
    'Explosion':          { key: 'hazard.type.explosion',  qset: 'explosion',  safety: 'chemical' },
    'Chemical Incident':  { key: 'hazard.type.chemical',   qset: 'explosion',  safety: 'chemical' },
    'Conflict':           { key: 'hazard.type.conflict',   qset: 'conflict',   safety: 'conflict' },
    'Civil Unrest':       { key: 'hazard.type.unrest',     qset: 'conflict',   safety: 'conflict' },
  };

  // --- Infrastructure types (Section 5) — all 7 must appear ----------------
  const INFRASTRUCTURE = [
    { value: 'Residential Infrastructure',                  key: 'infra.residential',  descKey: 'infra.residentialDesc' },
    { value: 'Commercial Infrastructure',                   key: 'infra.commercial',   descKey: 'infra.commercialDesc' },
    { value: 'Government Building',                          key: 'infra.government',   descKey: 'infra.governmentDesc' },
    { value: 'Utility Infrastructure',                      key: 'infra.utility',      descKey: 'infra.utilityDesc' },
    { value: 'Transport and Communication Infrastructure',  key: 'infra.transport',    descKey: 'infra.transportDesc' },
    { value: 'Community Infrastructure',                     key: 'infra.community',    descKey: 'infra.communityDesc' },
    { value: 'Public Spaces / Recreation Infrastructure',   key: 'infra.publicspace',  descKey: 'infra.publicspaceDesc' },
  ];

  // --- Damage tiers (Section 8) — exactly three, no fourth -----------------
  const DAMAGE = [
    { value: 'Minimal',  key: 'damage.minimal',  descKey: 'damage.minimalDesc',  cls: 'tier-min' },
    { value: 'Partial',  key: 'damage.partial',  descKey: 'damage.partialDesc',  cls: 'tier-par' },
    { value: 'Complete', key: 'damage.complete', descKey: 'damage.completeDesc', cls: 'tier-com' },
  ];

  // --- Reusable answer options (translated via opt.* keys) -----------------
  const O = (value, key) => ({ value, key });
  const YESNOIDK = [O('Yes', 'opt.yes'), O('No', 'opt.no'), O("I don't know", 'opt.idk')];
  const YESNO = [O('Yes', 'opt.yes'), O('No', 'opt.no')];

  // --- Two optional crisis-specific questions per hazard (Section 7.2) -----
  const QUESTION_SETS = {
    earthquake: [
      { key: 'q.eq.1', options: YESNOIDK },
      { key: 'q.eq.2', options: [O('Open', 'opt.open'), O('Blocked', 'opt.blocked'), O("I don't know", 'opt.idk')] },
    ],
    flood: [
      { key: 'q.flood.1', options: [O('Dry', 'opt.dry'), O('Ankle', 'opt.ankle'), O('Knee', 'opt.knee'), O('Waist', 'opt.waist'), O('Above waist', 'opt.aboveWaist')] },
      { key: 'q.flood.2', options: YESNOIDK },
    ],
    hurricane: [
      { key: 'q.hur.1', options: [O('Intact', 'opt.intact'), O('Partially missing', 'opt.partiallyMissing'), O('Fully missing', 'opt.fullyMissing')] },
      { key: 'q.hur.2', options: YESNOIDK },
    ],
    wildfire: [
      { key: 'q.fire.1', options: [O('Active', 'opt.active'), O('Contained', 'opt.contained'), O('Extinguished', 'opt.extinguished'), O("I don't know", 'opt.idk')] },
      { key: 'q.fire.2', options: YESNO },
    ],
    tsunami: [
      { key: 'q.tsu.1', options: [O('Yes flowing', 'opt.yesFlowing'), O('Standing', 'opt.standing'), O('Receded', 'opt.receded'), O('Dry', 'opt.dry')] },
      { key: 'q.tsu.2', options: YESNOIDK },
    ],
    conflict: [
      { key: 'q.conf.1', options: YESNOIDK },
      { key: 'q.conf.2', options: YESNO },
    ],
    explosion: [
      { key: 'q.exp.1', options: YESNOIDK },
      { key: 'q.exp.2', options: YESNOIDK },
    ],
  };

  // --- Mandatory universal question (Section 7.1) --------------------------
  const MANDATORY = {
    key: 'mandatory.question',
    options: [
      O('Yes', 'mandatory.yes'),
      O('No', 'mandatory.no'),
      O('IDontKnow', 'mandatory.idk'),
    ],
  };

  function hazardLabel(value) {
    const h = HAZARDS[value];
    return h ? window.i18next.t(h.key) : value;
  }
  function infraLabel(value) {
    const i = INFRASTRUCTURE.find((x) => x.value === value);
    return i ? window.i18next.t(i.key) : value;
  }
  function damageLabel(value) {
    const d = DAMAGE.find((x) => x.value === value);
    return d ? window.i18next.t(d.key) : value;
  }
  function damageClass(value) {
    const d = DAMAGE.find((x) => x.value === value);
    return d ? d.cls : '';
  }
  function questionsFor(hazardValue) {
    const h = HAZARDS[hazardValue];
    return h ? QUESTION_SETS[h.qset] || [] : [];
  }

  window.GT_DATA = {
    HAZARD_GROUPS,
    HAZARDS,
    INFRASTRUCTURE,
    DAMAGE,
    QUESTION_SETS,
    MANDATORY,
    hazardLabel,
    infraLabel,
    damageLabel,
    damageClass,
    questionsFor,
  };
})();
