import { useSyncExternalStore } from 'react';

/* ────────────────────────────────────────────────────────────
 * 主题偏好：仅明暗（system / dark / light），localStorage 键 rd-theme。
 * 强调色与布局自定义已移除——一套设计做到位，不留半成品选项。
 * ──────────────────────────────────────────────────────────── */

export type ThemeMode = 'system' | 'dark' | 'light';

/* 移动端浏览器地址栏/状态栏着色，与 CSS 的 --app-bg 保持一致 */
export const THEME_COLORS: Record<'light' | 'dark', string> = { light: '#fafafa', dark: '#0a0a0a' };

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
  syncThemeColor(theme);
}

/** 把 <meta name="theme-color"> 同步为当前生效主题的背景色；system 模式跟随 prefers-color-scheme */
export function syncThemeColor(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  let resolved: 'light' | 'dark';
  if (theme === 'system') {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return; // 无法探测系统偏好，保留 meta 现值
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    resolved = theme;
  }
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLORS[resolved];
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

/* system 模式下，系统明暗切换时同步 theme-color 与订阅者（CSS 变量由媒体查询自动跟随） */
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    if (theme === 'system') syncThemeColor('system');
  };
  // Safari < 14 只支持 addListener；capability check 而非 UA 嗅探
  if (typeof darkQuery.addEventListener === 'function') darkQuery.addEventListener('change', onSystemChange);
  else if (typeof darkQuery.addListener === 'function') darkQuery.addListener(onSystemChange);
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
