// Effect catalog schema (spec §4.2, §7): frozen CatalogEntry/CatalogPhase shapes,
// runtime validation for hand-authored + generated documents, and a loader that
// tolerates individually-invalid entries per the spec §7 error-handling contract.

import type { RNG } from './rng';
import { pick, range } from './rng';

export type BreakFamily =
  | 'peony'
  | 'chrysanthemum'
  | 'willow'
  | 'horsetail'
  | 'palm'
  | 'crossette'
  | 'fish'
  | 'ring'
  | 'pistil'
  | 'crackling_flower';
export type EffectTag = 'crackle' | 'strobe' | 'glitter' | 'whistle' | 'brocade' | 'wave';
export type DeviceType = 'shell' | 'cake' | 'mine' | 'comet' | 'rocket';
export type Caliber = 'small' | 'medium' | 'large';
export type SourceKind = 'glossary' | 'product_page' | 'catalog' | 'generated';
export type NormalizationStatus = 'direct' | 'alias' | 'inferred';
export type PhaseKind = 'ascent' | 'break' | 'secondary' | 'terminal';

export interface CatalogPhase {
  kind: PhaseKind;
  breakFamily?: BreakFamily;
  colors: string[]; // CSS hex, chromaticity only
  effectTags: EffectTag[];
}

export interface CatalogEntry {
  id: string;
  productName: string;
  sourceUrl: string;
  sourcePublisher: string;
  sourceKind: SourceKind;
  accessedOn: string;
  verbatimText: string;
  normalizationStatus: NormalizationStatus;
  deviceType: DeviceType;
  shotCount: number;
  durationSeconds?: number;
  caliberHint: Caliber;
  phases: CatalogPhase[];
}

const BREAK_FAMILIES: readonly BreakFamily[] = [
  'peony',
  'chrysanthemum',
  'willow',
  'horsetail',
  'palm',
  'crossette',
  'fish',
  'ring',
  'pistil',
  'crackling_flower',
];
const EFFECT_TAGS: readonly EffectTag[] = ['crackle', 'strobe', 'glitter', 'whistle', 'brocade', 'wave'];
const DEVICE_TYPES: readonly DeviceType[] = ['shell', 'cake', 'mine', 'comet', 'rocket'];
const CALIBERS: readonly Caliber[] = ['small', 'medium', 'large'];
const SOURCE_KINDS: readonly SourceKind[] = ['glossary', 'product_page', 'catalog', 'generated'];
const NORMALIZATION_STATUSES: readonly NormalizationStatus[] = ['direct', 'alias', 'inferred'];
const PHASE_KINDS: readonly PhaseKind[] = ['ascent', 'break', 'secondary', 'terminal'];
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Pyrotechnic emitter chromaticity per spec §3.6 (strontium red, barium green,
// copper blue, sodium amber, magnesium/aluminum white) plus gold/silver/purple
// mixes seen across the seed catalog — the palette generateCatalogEntry draws from.
const PALETTE: readonly string[] = [
  '#ff2d2d', // strontium red
  '#2ecc71', // barium green
  '#3060ff', // copper blue
  '#ffb300', // sodium amber / gold
  '#ffffff', // magnesium white
  '#a259ff', // purple
  '#c0c0c0', // silver
  '#ffd700', // gold
];

/** Type guard: is `value` one of `arr`'s literal members? Reused across every
 * enum field below — a bare `includes` call can't narrow a plain `string`. */
function includesValue<T extends string>(arr: readonly T[], value: string): value is T {
  return (arr as readonly string[]).includes(value);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validatePhase(x: unknown, index: number): string[] {
  const errors: string[] = [];
  if (!isRecord(x)) {
    errors.push(`phases[${index}]: not an object`);
    return errors;
  }

  if (typeof x.kind !== 'string' || !includesValue(PHASE_KINDS, x.kind)) {
    errors.push(`phases[${index}].kind: must be one of ${PHASE_KINDS.join('|')}`);
  }

  const breakFamilyValid = typeof x.breakFamily === 'string' && includesValue(BREAK_FAMILIES, x.breakFamily);
  if (x.kind === 'break' || x.kind === 'secondary') {
    if (!breakFamilyValid) {
      errors.push(`phases[${index}].breakFamily: required for kind '${String(x.kind)}' and must be one of ${BREAK_FAMILIES.join('|')}`);
    }
  } else if (x.breakFamily !== undefined && !breakFamilyValid) {
    errors.push(`phases[${index}].breakFamily: must be one of ${BREAK_FAMILIES.join('|')}`);
  }

  if (!Array.isArray(x.colors) || x.colors.length === 0 || x.colors.some((c) => typeof c !== 'string' || !HEX_COLOR.test(c))) {
    errors.push(`phases[${index}].colors: must be a non-empty array of CSS hex colors`);
  }
  if (!Array.isArray(x.effectTags) || x.effectTags.some((t) => typeof t !== 'string' || !includesValue(EFFECT_TAGS, t))) {
    errors.push(`phases[${index}].effectTags: must be an array drawn from ${EFFECT_TAGS.join('|')}`);
  }

  return errors;
}

/** Validates an unknown value against the CatalogEntry schema. Empty array = valid. */
export function validateEntry(x: unknown): string[] {
  if (!isRecord(x)) return ['entry: not an object'];
  const errors: string[] = [];

  if (typeof x.id !== 'string' || x.id.length === 0) errors.push('id: required non-empty string');
  if (typeof x.productName !== 'string' || x.productName.length === 0) errors.push('productName: required non-empty string');

  if (typeof x.sourceKind !== 'string' || !includesValue(SOURCE_KINDS, x.sourceKind)) {
    errors.push(`sourceKind: must be one of ${SOURCE_KINDS.join('|')}`);
  }

  // Provenance is required for every entry except generator output (spec §4.2/§7).
  const generated = x.sourceKind === 'generated';
  if (!generated && (typeof x.sourceUrl !== 'string' || x.sourceUrl.length === 0)) {
    errors.push('sourceUrl: required unless sourceKind is generated');
  } else if (typeof x.sourceUrl !== 'string') {
    errors.push('sourceUrl: must be a string');
  }
  if (!generated && (typeof x.sourcePublisher !== 'string' || x.sourcePublisher.length === 0)) {
    errors.push('sourcePublisher: required unless sourceKind is generated');
  } else if (typeof x.sourcePublisher !== 'string') {
    errors.push('sourcePublisher: must be a string');
  }
  if (!generated && (typeof x.accessedOn !== 'string' || x.accessedOn.length === 0)) {
    errors.push('accessedOn: required unless sourceKind is generated');
  } else if (typeof x.accessedOn !== 'string') {
    errors.push('accessedOn: must be a string');
  }
  if (!generated && (typeof x.verbatimText !== 'string' || x.verbatimText.length === 0)) {
    errors.push('verbatimText: required unless sourceKind is generated');
  } else if (typeof x.verbatimText !== 'string') {
    errors.push('verbatimText: must be a string');
  }

  if (typeof x.normalizationStatus !== 'string' || !includesValue(NORMALIZATION_STATUSES, x.normalizationStatus)) {
    errors.push(`normalizationStatus: must be one of ${NORMALIZATION_STATUSES.join('|')}`);
  }
  if (typeof x.deviceType !== 'string' || !includesValue(DEVICE_TYPES, x.deviceType)) {
    errors.push(`deviceType: must be one of ${DEVICE_TYPES.join('|')}`);
  }
  if (typeof x.shotCount !== 'number' || !Number.isInteger(x.shotCount) || x.shotCount < 1) {
    errors.push('shotCount: required positive integer');
  }
  if (x.durationSeconds !== undefined && (typeof x.durationSeconds !== 'number' || x.durationSeconds <= 0)) {
    errors.push('durationSeconds: must be a positive number when present');
  }
  if (typeof x.caliberHint !== 'string' || !includesValue(CALIBERS, x.caliberHint)) {
    errors.push(`caliberHint: must be one of ${CALIBERS.join('|')}`);
  }

  if (!Array.isArray(x.phases) || x.phases.length === 0) {
    errors.push('phases: required non-empty array');
  } else {
    x.phases.forEach((phase, i) => errors.push(...validatePhase(phase, i)));
  }

  return errors;
}

/**
 * Validates a batch of raw catalog documents, warning and skipping any entry
 * that fails `validateEntry` (spec §7: "entry skipped with console warning;
 * show continues with remaining entries") and returning the rest.
 */
export function loadCatalogEntries(raw: readonly unknown[]): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const item of raw) {
    const errors = validateEntry(item);
    if (errors.length > 0) {
      const id = isRecord(item) && typeof item.id === 'string' ? item.id : '<unknown>';
      console.warn(`catalog: skipping invalid entry '${id}': ${errors.join('; ')}`);
      continue;
    }
    // validateEntry(item) returned no errors, so item's shape matches CatalogEntry.
    entries.push(item as CatalogEntry);
  }
  return entries;
}

/** Synthesizes a schema-valid, `sourceKind: 'generated'` catalog entry from vocabulary lists. */
export function generateCatalogEntry(rng: RNG): CatalogEntry {
  const deviceType = pick(rng, DEVICE_TYPES);
  const caliberHint = pick(rng, CALIBERS);
  const family = pick(rng, BREAK_FAMILIES);
  const ascentColors = [pick(rng, PALETTE)];
  const breakColors = [pick(rng, PALETTE), pick(rng, PALETTE)];
  const effectTags = EFFECT_TAGS.filter(() => rng() < 0.3);
  const shotCount = deviceType === 'cake' ? Math.round(range(rng, [8, 60])) : 1;
  const durationSeconds =
    deviceType === 'rocket' || deviceType === 'cake' ? Math.round(range(rng, [3, 30])) : undefined;

  const phases: CatalogPhase[] = [
    { kind: 'ascent', colors: ascentColors, effectTags: [] },
    { kind: 'break', breakFamily: family, colors: breakColors, effectTags },
  ];
  if (family === 'crossette' || family === 'pistil') {
    phases.push({ kind: 'secondary', breakFamily: family, colors: breakColors, effectTags: [] });
  }

  const idSuffix = Math.floor(range(rng, [0, 2 ** 32])).toString(36);

  return {
    id: `generated-${idSuffix}`,
    productName: `Generated ${family} ${deviceType}`,
    sourceUrl: '',
    sourcePublisher: '',
    sourceKind: 'generated',
    accessedOn: '',
    verbatimText: '',
    normalizationStatus: 'inferred',
    deviceType,
    shotCount,
    durationSeconds,
    caliberHint,
    phases,
  };
}
