import { describe, expect, it } from 'vitest';
import { rrfFusion } from './rrf.js';

// RRF constants (mirror the module's internal values for verification)
const K = 60;

describe('rrfFusion', () => {
  describe('empty input', () => {
    it('should return an empty array when given no lists', () => {
      expect(rrfFusion([])).toEqual([]);
    });

    it('should return an empty array when given a single empty list', () => {
      expect(rrfFusion([[]])).toEqual([]);
    });

    it('should return an empty array when all lists are empty', () => {
      expect(rrfFusion([[], [], []])).toEqual([]);
    });
  });

  describe('single list passthrough', () => {
    it('should return items from a single list in their original rank order', () => {
      const list = ['a', 'b', 'c', 'd', 'e'];
      const result = rrfFusion([list]);
      expect(result).toEqual(list);
    });

    it('should cap at RRF_TOP_N items when a single list exceeds the cap', () => {
      // Cap is 150 (raised from 50 to give Stage 2 a wider candidate pool).
      const list = Array.from({ length: 200 }, (_, i) => `tool-${i}`);
      const result = rrfFusion([list]);
      expect(result.length).toBe(150);
    });

    it('should preserve the top-N entries in rank order, not an arbitrary subset', () => {
      const list = Array.from({ length: 200 }, (_, i) => `tool-${i}`);
      const result = rrfFusion([list]);
      // The top-ranked item in the single list must be first in the output
      expect(result[0]).toBe('tool-0');
    });
  });

  describe('two lists with overlap', () => {
    it('should rank an item appearing in both lists higher than one appearing in only one', () => {
      // 'shared' appears at rank 1 in both lists.
      // 'only-in-b' appears at rank 1 in list B only.
      const listA = ['shared', 'only-in-a'];
      const listB = ['shared', 'only-in-b'];

      const result = rrfFusion([listA, listB]);

      const sharedIdx = result.indexOf('shared');
      const onlyInBIdx = result.indexOf('only-in-b');

      expect(sharedIdx).toBeGreaterThanOrEqual(0);
      expect(onlyInBIdx).toBeGreaterThanOrEqual(0);
      expect(sharedIdx).toBeLessThan(onlyInBIdx);
    });

    it('should also rank the shared item above one that only appears in list A', () => {
      const listA = ['shared', 'only-in-a'];
      const listB = ['shared', 'only-in-b'];

      const result = rrfFusion([listA, listB]);

      const sharedIdx = result.indexOf('shared');
      const onlyInAIdx = result.indexOf('only-in-a');

      expect(sharedIdx).toBeLessThan(onlyInAIdx);
    });
  });

  describe('k=60 score math', () => {
    it('should assign score 1/(60+1) to an item at rank 1 in a single list', () => {
      // We verify by checking relative ordering matches the known formula.
      // rank-1 item score: 1/61, rank-2 item score: 1/62
      // rank-1 must be first
      const result = rrfFusion([['first', 'second']]);
      expect(result[0]).toBe('first');
      expect(result[1]).toBe('second');
    });

    it('should produce a combined score of 2/(k+1) for an item at rank 1 in two identical lists', () => {
      // If 'alpha' is rank-1 in both lists its fused score = 1/61 + 1/61 = 2/61.
      // 'beta' at rank-1 in one list has score 1/61.
      // So alpha must outrank beta-only.
      const listA = ['alpha', 'beta'];
      const listB = ['alpha', 'gamma'];
      const result = rrfFusion([listA, listB]);
      expect(result[0]).toBe('alpha');
    });

    it('should verify that rank-1 in two lists beats rank-1 in one list', () => {
      // alpha: 1/(60+1) + 1/(60+1) = 2/61 ≈ 0.032787
      // beta (only in listA at rank 1): 1/(60+1) = 1/61 ≈ 0.016393
      // => alpha score > beta score
      const expected_alpha_score = 2 / (K + 1);
      const expected_beta_score = 1 / (K + 1);
      expect(expected_alpha_score).toBeGreaterThan(expected_beta_score);

      const result = rrfFusion([['alpha', 'beta'], ['alpha']]);
      expect(result[0]).toBe('alpha');
      expect(result[1]).toBe('beta');
    });
  });

  describe('deduplication', () => {
    it('should include a shared item only once in the output', () => {
      const listA = ['x', 'y', 'z'];
      const listB = ['z', 'x', 'y'];
      const result = rrfFusion([listA, listB]);
      // Each id should appear exactly once
      const uniqueIds = new Set(result);
      expect(uniqueIds.size).toBe(result.length);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('output shape', () => {
    it('should return an array of strings', () => {
      const result = rrfFusion([
        ['a', 'b'],
        ['b', 'c'],
      ]);
      expect(Array.isArray(result)).toBe(true);
      for (const id of result) {
        expect(typeof id).toBe('string');
      }
    });

    it('should never exceed RRF_TOP_N (150) items regardless of combined input size', () => {
      const listA = Array.from({ length: 200 }, (_, i) => `a-${i}`);
      const listB = Array.from({ length: 200 }, (_, i) => `b-${i}`);
      const result = rrfFusion([listA, listB]);
      expect(result.length).toBeLessThanOrEqual(150);
    });
  });
});
