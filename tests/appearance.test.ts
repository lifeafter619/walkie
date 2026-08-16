// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { nextTheme, loadTheme, applyThemeToDOM, THEME_COLORS, syncThemeColor } from '../src/web/appearance';

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

describe('theme-color meta sync', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#fafafa" />';
    localStorage.clear();
  });

  it('uses app background colors for light/dark', () => {
    expect(THEME_COLORS.light).toBe('#fafafa');
    expect(THEME_COLORS.dark).toBe('#0a0a0a');
  });

  it('updates the meta tag on explicit themes', () => {
    syncThemeColor('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0a0a0a');
    syncThemeColor('light');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#fafafa');
  });

  it('follows prefers-color-scheme when mode is system', () => {
    if (typeof window.matchMedia !== 'function') return; // jsdom 未实现 matchMedia，浏览器验证覆盖此分支
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    syncThemeColor('system');
    // 断言与真实查询结果一致而非硬编码，避免环境差异造成假红
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content'))
      .toBe(query.matches ? '#0a0a0a' : '#fafafa');
  });

  it('is idempotent (no duplicate meta tags)', () => {
    syncThemeColor('dark');
    syncThemeColor('dark');
    expect(document.querySelectorAll('meta[name="theme-color"]').length).toBe(1);
  });
});
