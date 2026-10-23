import { describe, expect, it } from 'vitest';
import {
  aufteilen,
  issueSchluesselAus,
  issueSchluesselOtelWert,
  ISSUE_SCHLUESSEL_MAX,
  ISSUE_SCHLUESSEL_MUSTER,
  projektSchluesselVon,
  schluesselFiltern,
} from './issue-schluessel.js';

describe('Issue-Schlüssel aus Branch-Namen', () => {
  it.each([
    ['feature/ABC-123-titel', ['ABC-123']],
    ['abc-123', ['ABC-123']],
    ['ABC-123/ABC-124', ['ABC-123', 'ABC-124']],
    ['bugfix/Proj2-7_kurz', ['PROJ2-7']],
    ['ABC-123-ABC-123', ['ABC-123']],
    ['main', []],
    ['feature/geheim-branch', []],
    ['release-2026-10', []],
    ['hotfix-3', []],
    ['A-1', []],
    ['1AB-2', []],
    ['', []],
  ])('%s → %j', (branch, erwartet) => {
    expect(issueSchluesselAus(branch)).toEqual(erwartet);
  });

  it('liefert nur Schlüssel, die das gespeicherte Muster erfüllen, höchstens 20', () => {
    const branch = Array.from({ length: 30 }, (_x, i) => `abc-${i + 1}`).join('/');
    const s = issueSchluesselAus(branch);
    expect(s).toHaveLength(ISSUE_SCHLUESSEL_MAX);
    expect(s.every((k) => ISSUE_SCHLUESSEL_MUSTER.test(k))).toBe(true);
    expect(issueSchluesselAus(null)).toEqual([]);
  });

  it('Präfix, Positivliste und OTel-Wert', () => {
    expect(projektSchluesselVon('ABC-123')).toBe('ABC');
    expect(schluesselFiltern(['ABC-1', 'XYZ-2'], null)).toEqual(['ABC-1', 'XYZ-2']);
    expect(schluesselFiltern(['ABC-1', 'XYZ-2'], ['XYZ'])).toEqual(['XYZ-2']);
    expect(schluesselFiltern(['ABC-1'], [])).toEqual([]);
    expect(issueSchluesselOtelWert(['ABC-1', 'ABC-2'])).toBe('ABC-1|ABC-2');
    expect(issueSchluesselAus('ABC-1|ABC-2')).toEqual(['ABC-1', 'ABC-2']);
  });

  it('teilt ganzzahlig ohne Rundungsverlust auf', () => {
    expect(aufteilen(10, 3)).toEqual([4, 3, 3]);
    expect(aufteilen(0, 2)).toEqual([0, 0]);
    expect(aufteilen(7, 1)).toEqual([7]);
    expect(aufteilen(5, 0)).toEqual([]);
  });
});
