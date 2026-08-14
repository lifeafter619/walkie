import { useSyncExternalStore } from 'react';

/* ────────────────────────────────────────────────────────────
 * 主题偏好：仅明暗（system / dark / light），localStorage 键 rd-theme。
 * 强调色与布局自定义已移除——一套设计做到位，不留半成品选项。
 * ──────────────────────────────────────────────────────────── */

export type ThemeMode = 'system' | 'dark' | 'light';

export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === 'system' ? 'dark' : mode === 'dark' ? 'light' : 'system';
}

export function loadTheme(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system';
  const t = localStorage.getItem('rd-theme');
  return t === 'dark' || t === 'light' ? t : 'system';
}

export function applyThemeToDOM(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/* module-level external store */
let theme: ThemeMode = loadTheme();
const listeners = new Set<() => void>();
function emit(): void { for (const l of listeners) l(); }
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function getSnapshot(): ThemeMode { return theme; }

export function setTheme(next: ThemeMode): void {
  theme = next;
  if (typeof localStorage !== 'undefined') localStorage.setItem('rd-theme', next);
  applyThemeToDOM(next);
  emit();
}

export function cycleTheme(): void {
  setTheme(nextTheme(theme));
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
