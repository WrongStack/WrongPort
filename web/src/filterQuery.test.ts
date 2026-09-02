import { describe, expect, it } from 'vitest';
import { DEFAULT_INCLUDE } from '../../src/core/config.js';
import { filterBoxToQuery, SUGGESTED_ONLY_PATTERNS } from './filterQuery';

describe('filterBoxToQuery', () => {
  it('maps empty and blank input to no params', () => {
    expect(filterBoxToQuery('')).toEqual({});
    expect(filterBoxToQuery('   ')).toEqual({});
  });

  it('maps digit-only input to the server-side ports parameter', () => {
    expect(filterBoxToQuery('3000')).toEqual({ ports: '3000' });
    expect(filterBoxToQuery('3000,5173')).toEqual({ ports: '3000,5173' });
    expect(filterBoxToQuery(' 3000 ')).toEqual({ ports: '3000' });
  });

  it('maps any other text to the server-side only parameter', () => {
    expect(filterBoxToQuery('vite')).toEqual({ only: 'vite' });
    expect(filterBoxToQuery('\\bgo\\b')).toEqual({ only: '\\bgo\\b' });
    // Mixed tokens are not pure ports — they go to only= as a pattern.
    expect(filterBoxToQuery('3000,abc')).toEqual({ only: '3000,abc' });
  });
});

describe('SUGGESTED_ONLY_PATTERNS', () => {
  it('is non-empty and contains unique entries', () => {
    expect(SUGGESTED_ONLY_PATTERNS.length).toBeGreaterThan(0);
    expect(new Set(SUGGESTED_ONLY_PATTERNS).size).toBe(SUGGESTED_ONLY_PATTERNS.length);
  });

  it('compiles every pattern as a case-insensitive regex (a typo would 400 at runtime)', () => {
    for (const source of SUGGESTED_ONLY_PATTERNS) {
      expect(() => new RegExp(source, 'i'), source).not.toThrow();
    }
  });

  it('never overlaps the default dev filter — chips must reveal, not repeat', () => {
    const defaults = DEFAULT_INCLUDE.map((source) => new RegExp(source, 'i'));
    for (const pattern of SUGGESTED_ONLY_PATTERNS) {
      const covered = defaults.some((re) => re.test(pattern));
      expect(covered, `"${pattern}" is already matched by the default dev filter`).toBe(false);
    }
  });
});
