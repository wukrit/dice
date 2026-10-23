import { describe, expect, it } from 'vitest';
import { dieLabel, mergeRolls, randomUuid } from './api';
import type { Roll } from './types';
const make = (id: string, sequence: number): Roll => ({ id, sequence, request_id: id, member_id: 'a', name: 'Mira', die: 20, value: 12, created_at: '2026-01-01T00:00:00Z', duration_ms: 2000 });
describe('history reconciliation', () => {
  it('deduplicates overlapping history and live events', () => {
    expect(mergeRolls([make('a', 1), make('c', 3)], [make('b', 2), make('c', 3)]).map(roll => roll.id)).toEqual(['c', 'b', 'a']);
  });
  it('keeps sequence order, not client clock order', () => {
    expect(mergeRolls([make('a', 9)], [make('b', 11)]).map(roll => roll.sequence)).toEqual([11, 9]);
  });
  it('labels percentile rolls', () => { expect(dieLabel(100)).toBe('d100'); });
  it('generates valid v4 UUIDs even without crypto.randomUUID', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
