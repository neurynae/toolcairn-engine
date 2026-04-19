import { describe, expect, it } from 'vitest';
import { satisfies } from './range-evaluator.js';

describe('satisfies (range evaluator)', () => {
  describe('semver', () => {
    it.each<[string, string, boolean]>([
      ['18.2.0', '^18 || ^19', true],
      ['19.0.0', '^18 || ^19', true],
      ['17.0.0', '^18 || ^19', false],
      ['20.0.0', '^18 || ^19', false],
      ['15.0.3', '>=15.0.0 <16', true],
      ['16.0.0', '>=15.0.0 <16', false],
      ['1.2.3', '1.2.x', true],
      ['1.3.0', '1.2.x', false],
    ])('satisfies(%s, %s) should be %s', (version, range, expected) => {
      expect(satisfies(version, range, 'semver').ok).toBe(expected);
    });

    it('returns a reason string when the range is unsatisfied', () => {
      const result = satisfies('17.0.0', '^18 || ^19', 'semver');
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  });

  describe('pep440', () => {
    it.each<[string, string, boolean]>([
      ['3.11', '>=3.10,<4', true],
      ['3.10.0', '>=3.10,<4', true],
      ['3.9', '>=3.10,<4', false],
      ['4.0', '>=3.10,<4', false],
      ['3.10.5', '~=3.10', true],
      ['4.0.0', '~=3.10', false],
      ['1.2.3', '!=1.2.4', true],
      ['1.2.4', '!=1.2.4', false],
    ])('satisfies(%s, %s) should be %s', (version, range, expected) => {
      expect(satisfies(version, range, 'pep440').ok).toBe(expected);
    });
  });

  describe('maven', () => {
    it.each<[string, string, boolean]>([
      ['1.5.0', '[1.0,2.0)', true],
      ['2.0.0', '[1.0,2.0)', false],
      ['1.0.0', '[1.0,2.0)', true],
      ['2.0.0', '(1.0,2.0]', true],
      ['1.0.0', '(1.0,2.0]', false],
      ['3.0.0', '[1.0,2.0)', false],
    ])('satisfies(%s, %s) should be %s', (version, range, expected) => {
      expect(satisfies(version, range, 'maven').ok).toBe(expected);
    });
  });

  describe('ruby (twiddle-waka)', () => {
    it.each<[string, string, boolean]>([
      ['2.1.5', '~> 2.1', true],
      ['3.0.0', '~> 2.1', false],
      ['2.1.3', '~> 2.1.0', true],
      ['2.2.0', '~> 2.1.0', false],
      ['1.0.0', '>= 0.9, < 2.0', true],
      ['2.0.0', '>= 0.9, < 2.0', false],
    ])('satisfies(%s, %s) should be %s', (version, range, expected) => {
      expect(satisfies(version, range, 'ruby').ok).toBe(expected);
    });
  });

  describe('composer', () => {
    it.each<[string, string, boolean]>([
      ['1.9.0', '^1.0 || ^2.0', true],
      ['2.5.0', '^1.0 || ^2.0', true],
      ['3.0.0', '^1.0 || ^2.0', false],
    ])('satisfies(%s, %s) should be %s', (version, range, expected) => {
      expect(satisfies(version, range, 'composer').ok).toBe(expected);
    });
  });

  describe('cargo', () => {
    it.each<[string, string, boolean]>([
      ['0.12.4', '^0.12', true],
      ['0.13.0', '^0.12', false],
      ['1.2.3', '^1.0', true],
      ['2.0.0', '^1.0', false],
    ])('satisfies(%s, %s) should be %s', (version, range, expected) => {
      expect(satisfies(version, range, 'cargo').ok).toBe(expected);
    });
  });

  describe('opaque', () => {
    it('accepts exact string match', () => {
      expect(satisfies('1.0.0', '1.0.0', 'opaque').ok).toBe(true);
    });
    it('rejects anything else', () => {
      expect(satisfies('1.0.0', '2.0.0', 'opaque').ok).toBe(false);
      expect(satisfies('1.0.0', '^1.0.0', 'opaque').ok).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('rejects empty version', () => {
      expect(satisfies('', '^1.0.0', 'semver').ok).toBe(false);
    });
    it('rejects empty range', () => {
      expect(satisfies('1.0.0', '', 'semver').ok).toBe(false);
    });
    it('handles malformed range gracefully (no throw)', () => {
      expect(() => satisfies('1.0.0', 'not a real range', 'semver')).not.toThrow();
    });
  });
});
