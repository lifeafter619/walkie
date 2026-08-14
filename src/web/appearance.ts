import { useSyncExternalStore } from 'react';

/* ────────────────────────────────────────────────────────────
 * 外观偏好：强调色（用户可配置）+ 主题 + 布局。
 * 纯函数部分可被 node 环境单测；DOM 应用部分由 build 校验。
 * ──────────────────────────────────────────────────────────── */

export type Layout = 'sidebar' | 'top';
export type ThemeMode = 'system' | 'dark' | 'light';

export type AccentPreset = { id: string; name: string; hex: string };

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'clay', name: '陶土', hex: '#c2603f' },
  { id: 'ochre', name: '赭黄', hex: '#b8862f' },
  { id: 'forest', name: '深苔', hex: '#3d6b4f' },
  { id: 'ink', name: '墨', hex: '#2c2823' },
  { id: 'plum', name: '梅紫', hex: '#7a5c8f' },
  { id: 'slate', name: '青灰', hex: '#5b7a9a' }
] as const;

export const DEFAULT_ACCENT = '#c2603f';
export const DEFAULT_LAYOUT: Layout = 'sidebar';
export const ACCENT_INK_LIGHT = '#ffffff';
export const ACCENT_INK_DARK = '#2c2823';

export type AccentVars = {
  accent: string;
  accentInk: string;
  accentSoft: string;
  accentPress: string;
};

export type Appearance = {
  accent: string;
  theme: ThemeMode;
  layout: Layout;
};

/* ── 纯函数：颜色推导 ── */

export function parseHex(input: string): { r: number; g: number; b: number } {
  const raw = input.trim().replace(/^#/, '');
  let hex: string;
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    hex = raw;
  } else if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    hex = raw.split('').map((c) => c + c).join('');
  } else {
    return { r: 0, g: 0, b: 0 };
  }
  const num = parseInt(hex, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export function pickAccentInk(hex: string): string {
  const accentL = relativeLuminance(hex);
  const whiteL = 1;
  const darkL = relativeLuminance(ACCENT_INK_DARK);
  return contrastRatio(accentL, whiteL) >= contrastRatio(accentL, darkL) ? ACCENT_INK_LIGHT : ACCENT_INK_DARK;
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

function darken(hex: string, factor: number): string {
  const { r, g, b } = parseHex(hex);
  return `#${toHex(r * factor)}${toHex(g * factor)}${toHex(b * factor)}`;
}

export function deriveAccentVars(hex: string): AccentVars {
  const { r, g, b } = parseHex(hex);
  return {
    accent: hex,
    accentInk: pickAccentInk(hex),
    accentSoft: `rgba(${r},${g},${b},0.14)`,
    accentPress: darken(hex, 0.82)
  };
}

/* ── DOM 应用 + 外部 store ── */

function readTheme(): ThemeMode {
  const t = typeof localStorage !== 'undefined' ? (localStorage.getItem('rd-theme') as ThemeMode | null) : null;
  return t ?? 'system';
}

export function loadAppearance(): Appearance {
  if (typeof localStorage === 'undefined') {
    return { accent: DEFAULT_ACCENT, theme: 'system', layout: DEFAULT_LAYOUT };
  }
  return {
    accent: localStorage.getItem('rd-accent') || DEFAULT_ACCENT,
    theme: readTheme(),
    layout: (localStorage.getItem('rd-layout') as Layout | null) || DEFAULT_LAYOUT
  };
}

export function applyAccentToDOM(hex: string): void {
  if (typeof document === 'undefined') return;
  const v = deriveAccentVars(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent', v.accent);
  root.style.setProperty('--accent-ink', v.accentInk);
  root.style.setProperty('--accent-soft', v.accentSoft);
  root.style.setProperty('--accent-press', v.accentPress);
}

export function applyThemeToDOM(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  theme === 'system' ? root.removeAttribute('data-theme') : root.setAttribute('data-theme', theme);
}

export function applyLayoutToDOM(layout: Layout): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-layout', layout);
}

/* module-level external store */
let appearance: Appearance = loadAppearance();
const listeners = new Set<() => void>();
function emit(): void { for (const l of listeners) l(); }
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot(): Appearance { return appearance; }

export function setAccent(hex: string): void {
  appearance = { ...appearance, accent: hex };
  if (typeof localStorage !== 'undefined') localStorage.setItem('rd-accent', hex);
  applyAccentToDOM(hex);
  emit();
}

export function setTheme(theme: ThemeMode): void {
  appearance = { ...appearance, theme };
  if (typeof localStorage !== 'undefined') localStorage.setItem('rd-theme', theme);
  applyThemeToDOM(theme);
  emit();
}

export function cycleTheme(): void {
  const next: ThemeMode = appearance.theme === 'system' ? 'dark' : appearance.theme === 'dark' ? 'light' : 'system';
  setTheme(next);
}

export function setLayout(layout: Layout): void {
  appearance = { ...appearance, layout };
  if (typeof localStorage !== 'undefined') localStorage.setItem('rd-layout', layout);
  applyLayoutToDOM(layout);
  emit();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
