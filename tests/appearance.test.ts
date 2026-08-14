import { describe, it, expect } from 'vitest';
import {
  ACCENT_PRESETS, DEFAULT_ACCENT, DEFAULT_LAYOUT,
  parseHex, relativeLuminance, contrastRatio, pickAccentInk, deriveAccentVars
} from '../src/web/appearance';

describe('parseHex', () => {
  it('parses 6-digit hex with and without #', () => {
    expect(parseHex('#c2603f')).toEqual({ r: 194, g: 96, b: 63 });
    expect(parseHex('c2603f')).toEqual({ r: 194, g: 96, b: 63 });
  });
  it('expands 3-digit hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('000')).toEqual({ r: 0, g: 0, b: 0 });
  });
  it('returns black for invalid input', () => {
    expect(parseHex('nope')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHex('')).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('relativeLuminance', () => {
  it('white is ~1 and black is 0', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 2);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 2);
  });
});

describe('contrastRatio', () => {
  it('identical colors yield 1', () => {
    expect(contrastRatio(0.5, 0.5)).toBeCloseTo(1, 4);
  });
  it('white vs black is 21', () => {
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 1);
  });
});

describe('pickAccentInk', () => {
  it('uses white ink on dark accents', () => {
    expect(pickAccentInk('#c2603f')).toBe('#ffffff'); // clay (dark)
    expect(pickAccentInk('#3d6b4f')).toBe('#ffffff'); // forest (dark)
    expect(pickAccentInk('#2c2823')).toBe('#ffffff'); // ink (very dark)
  });
  it('uses dark ink on light accents', () => {
    expect(pickAccentInk('#ffffff')).toBe('#2c2823');
    expect(pickAccentInk('#f5f1ea')).toBe('#2c2823');
  });
});

describe('deriveAccentVars', () => {
  it('returns the 4 variables, soft as rgba tint, press as darker', () => {
    const v = deriveAccentVars('#c2603f');
    expect(v.accent).toBe('#c2603f');
    expect(v.accentInk).toBe('#ffffff');
    expect(v.accentSoft).toBe('rgba(194,96,63,0.14)');
    // press is accent darkened ~0.82 (194→0x9f, 96→0x4f, 63→0x34)
    expect(v.accentPress).toBe('#9f4f34');
  });
  it('preserves the hex casing of the input', () => {
    expect(deriveAccentVars('#3D6B4F').accent).toBe('#3D6B4F');
  });
});

describe('presets', () => {
  it('has clay as first and default', () => {
    expect(ACCENT_PRESETS[0].id).toBe('clay');
    expect(DEFAULT_ACCENT).toBe('#c2603f');
  });
  it('every preset hex is valid and derives an ink', () => {
    for (const p of ACCENT_PRESETS) {
      expect(() => deriveAccentVars(p.hex)).not.toThrow();
    }
  });
  it('default layout is sidebar', () => {
    expect(DEFAULT_LAYOUT).toBe('sidebar');
  });
});
