import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { generateCatalogEntry, loadCatalogEntries, validateEntry } from '../src/show/catalog';
import { mulberry32 } from '../src/show/rng';

const catalogDir = fileURLToPath(new URL('../catalog', import.meta.url));

function readShippedEntries(): Array<{ file: string; entry: unknown }> {
  return readdirSync(catalogDir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({ file, entry: JSON.parse(readFileSync(`${catalogDir}/${file}`, 'utf8')) }));
}

describe('shipped catalog entries', () => {
  const shipped = readShippedEntries();

  it('ships at least the 10 required documents', () => {
    expect(shipped.length).toBeGreaterThanOrEqual(10);
  });

  it.each(shipped.map(({ file, entry }) => [file, entry] as const))('%s validates', (_file, entry) => {
    expect(validateEntry(entry)).toEqual([]);
  });

  it('every non-generated shipped entry carries real provenance', () => {
    for (const { entry } of shipped) {
      const record = entry as Record<string, unknown>;
      expect(record.sourceKind).not.toBe('generated');
      expect(typeof record.sourceUrl === 'string' && record.sourceUrl.length > 0).toBe(true);
      expect(typeof record.verbatimText === 'string' && record.verbatimText.length > 0).toBe(true);
    }
  });
});

describe('validateEntry provenance rule', () => {
  const base = JSON.parse(readFileSync(`${catalogDir}/golden-pyro-fusion.json`, 'utf8')) as Record<string, unknown>;

  it('accepts the untouched real entry', () => {
    expect(validateEntry(base)).toEqual([]);
  });

  it('rejects a non-generated entry with sourceUrl removed', () => {
    const { sourceUrl: _drop, ...mutated } = base;
    expect(validateEntry(mutated).length).toBeGreaterThan(0);
  });

  it('rejects a non-generated entry with verbatimText emptied', () => {
    const mutated = { ...base, verbatimText: '' };
    expect(validateEntry(mutated).length).toBeGreaterThan(0);
  });

  it('rejects a non-generated entry with accessedOn removed', () => {
    const { accessedOn: _drop, ...mutated } = base;
    expect(validateEntry(mutated).length).toBeGreaterThan(0);
  });

  it('does not require provenance fields when sourceKind is generated', () => {
    const generated = { ...base, sourceKind: 'generated', sourceUrl: '', sourcePublisher: '', accessedOn: '', verbatimText: '' };
    expect(validateEntry(generated)).toEqual([]);
  });
});

describe('generateCatalogEntry', () => {
  it('produces a schema-valid entry across 100 seeds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = mulberry32(seed);
      const entry = generateCatalogEntry(rng);
      expect(validateEntry(entry)).toEqual([]);
      expect(entry.sourceKind).toBe('generated');
    }
  });
});

describe('loadCatalogEntries', () => {
  it('skips an invalid entry with a console warning and returns the rest', () => {
    const shipped = readShippedEntries().map(({ entry }) => entry);
    const invalid = { id: 'broken', productName: 'Broken Entry' }; // missing every other required field
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = loadCatalogEntries([...shipped, invalid]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('broken');
    expect(loaded).toHaveLength(shipped.length);

    warn.mockRestore();
  });
});
