import { describe, it, expect } from 'vitest';
import { nextTheme, loadTheme, applyThemeToDOM } from '../src/web/appearance';

describe('nextTheme', () => {
  it('cycles system → dark → light → system', () => {
    expect(nextTheme('system')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('system');
  });
});

describe('loadTheme', () => {
  it('returns system when localStorage is unavailable (node env)', () => {
    expect(loadTheme()).toBe('system');
  });
});

describe('applyThemeToDOM', () => {
  it('no-ops when document is unavailable (node env)', () => {
    expect(() => applyThemeToDOM('dark')).not.toThrow();
    expect(() => applyThemeToDOM('system')).not.toThrow();
  });
});
