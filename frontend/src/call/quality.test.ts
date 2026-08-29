import { describe, expect, it } from 'vitest';
import { classifyNetwork, ewma } from './quality';

describe('network adaptation', () => {
  it('classifies the worst observed constraint', () => {
    expect(classifyNetwork(0, .1, 10_000_000)).toBe(0);
    expect(classifyNetwork(.04, .1, 10_000_000)).toBe(1);
    expect(classifyNetwork(0, .6, 10_000_000)).toBe(2);
    expect(classifyNetwork(0, .1, 2_000_000)).toBe(3);
  });

  it('weights current measurements without losing the previous sample', () => {
    expect(ewma(null, 10, .5)).toBe(10);
    expect(ewma(10, 20, .25)).toBe(12.5);
    expect(ewma(10, Number.POSITIVE_INFINITY, .5)).toBe(10);
  });
});
