# Warm-Editorial Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace RelayDock's generic AI-dashboard look with a warm-editorial visual system whose accent color (and shell layout) is user-configurable.

**Architecture:** A pure `appearance.ts` module holds accent-derivation logic (TDD'd in node) + an external store consumed via `useSyncExternalStore`. `styles.css` is fully rewritten on the same class names so components mostly need no markup change. A small `AppearanceControls` component + inline boot script apply the chosen accent/layout before/at mount.

**Tech Stack:** React 19, TypeScript, Vite, plain CSS (custom properties), vitest (node env).

**Spec:** `docs/superpowers/specs/2026-08-14-frontend-redesign-design.md`

## Global Constraints

- **No new npm dependencies.** Fonts use system-safe stacks only (`Spectral, "Source Serif Pro", Georgia, serif` for display; `Inter, ...` for UI).
- **No backend / API / shared-type changes.** Touch only `src/web/` (and `index.html`).
- **No behavioral changes** to any component — purely presentation + the new appearance-preference plumbing.
- **Keep all existing CSS class names** so components continue to bind; restyle in place.
- **Accent is driven entirely by CSS custom properties** (`--accent`, `--accent-ink`, `--accent-soft`, `--accent-press`); nothing hardcodes a brand color.
- **Semantic colors are fixed** (carry meaning): `--success`, `--danger`, `--warning`, `--info` + their `-soft` tints.
- Default accent = Clay `#c2603f`; default layout = `sidebar`. Both persisted in `localStorage` (`rd-accent`, `rd-layout`); existing `rd-theme` retained.
- Verify each task with: `npm run build:web` (vite build) and `npm run typecheck` must pass; run `npm test` to ensure no regression in existing server tests.
- Commit after each task with a `feat(web):` / `style(web):` prefix as appropriate.

---

### Task 1: Accent-derivation pure logic (TDD)

**Files:**
- Create: `src/web/appearance.ts`
- Create: `tests/appearance.test.ts`

**Interfaces:**
- Produces: `ACCENT_PRESETS`, `DEFAULT_ACCENT`, `DEFAULT_LAYOUT`, `type AccentVars`, `type Layout`, `type Appearance`, `parseHex`, `relativeLuminance`, `contrastRatio`, `pickAccentInk`, `deriveAccentVars`, plus an external store: `useAppearance`, `setAccent`, `setTheme`, `cycleTheme`, `setLayout`, `loadAppearance`, `applyAccentToDOM`, `applyLayoutToDOM`. (DOM-touching functions are build-verified, not unit-tested; the pure functions below are unit-tested.)

- [ ] **Step 1: Write the failing test**

Create `tests/appearance.test.ts`:

```ts
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
    // press is accent darkened ~0.82
    expect(v.accentPress).toBe('#a14f33');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/appearance.test.ts --config vitest.config.ts`
Expected: FAIL — module `../src/web/appearance` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/web/appearance.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/appearance.test.ts --config vitest.config.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/web/appearance.ts tests/appearance.test.ts
git commit -m "feat(web): add accent-derivation logic + appearance store"
```

---

### Task 2: Full `styles.css` rewrite (warm-editorial tokens + components)

**Files:**
- Modify: `src/web/styles.css` (full overwrite)

**Interfaces:**
- Consumes: the CSS class names already referenced by every component (kept identical).
- Produces: a token system where brand color = `--accent` family and semantic colors = fixed `--success/--danger/--warning/--info`; `data-theme` toggles light/warm-dark; `data-layout` is read by shell rules.

**Note:** This task has no unit test (pure CSS). Verification = build + typecheck pass and the app renders. The complete replacement file content is below.

- [ ] **Step 1: Overwrite `src/web/styles.css`**

Replace the entire contents of `src/web/styles.css` with:

```css
:root {
  font-family: Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-display: "Spectral", "Source Serif Pro", Georgia, serif;
  --font-mono: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  color-scheme: light;
  color: var(--ink);
  background: var(--app-bg);
  font-synthesis: none;
  letter-spacing: 0;

  /* 暖白基底（固定） */
  --app-bg: #faf7f2;
  --surface: #ffffff;
  --surface-side: #f5f1ea;
  --surface-alt: #f8f5f0;
  --hover: #f5f1ea;
  --bar: rgba(250, 247, 242, 0.92);
  --ink: #2c2823;
  --ink-2: #6b6353;
  --muted: #9a8f7d;
  --faint: #c7bda9;
  --line: #efe8dc;
  --line-soft: #f3ede2;
  --shadow: 0 1px 2px rgba(60, 40, 20, 0.04), 0 8px 24px rgba(60, 40, 20, 0.06);
  --shadow-lg: 0 24px 64px rgba(60, 40, 20, 0.18);

  /* 强调色（用户可配置；默认 Clay，由 appearance.ts 写入 :root） */
  --accent: #c2603f;
  --accent-ink: #ffffff;
  --accent-soft: rgba(194, 96, 63, 0.14);
  --accent-press: #a14f33;

  /* 语义色（固定） */
  --success: #5a7a52; --success-soft: #eef2e8;
  --danger: #b8552f;  --danger-soft: #f7e9e2;
  --warning: #b8862f; --warning-soft: #f3ead4;
  --info: #5b7a9a;    --info-soft: #e6ecf2;
}

:root[data-theme="dark"] { color-scheme: dark;
  --app-bg: #1a1714; --surface: #242020; --surface-side: #201c19; --surface-alt: #2a2522;
  --hover: #2e2823; --bar: rgba(26, 23, 20, 0.92);
  --ink: #ede7df; --ink-2: #c9bfb2; --muted: #9a8f7d; --faint: #6b6258;
  --line: #38302a; --line-soft: #2e2823;
  --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.35);
  --shadow-lg: 0 24px 64px rgba(0,0,0,0.5);
  --success: #8fb985; --success-soft: rgba(143,185,133,0.14);
  --danger: #e08c6f; --danger-soft: rgba(224,140,111,0.14);
  --warning: #d9b074; --warning-soft: rgba(217,176,116,0.14);
  --info: #88a8c9; --info-soft: rgba(136,168,201,0.14);
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
  --app-bg: #1a1714; --surface: #242020; --surface-side: #201c19; --surface-alt: #2a2522;
  --hover: #2e2823; --bar: rgba(26, 23, 20, 0.92);
  --ink: #ede7df; --ink-2: #c9bfb2; --muted: #9a8f7d; --faint: #6b6258;
  --line: #38302a; --line-soft: #2e2823;
  --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.35);
  --shadow-lg: 0 24px 64px rgba(0,0,0,0.5);
  --success: #8fb985; --success-soft: rgba(143,185,133,0.14);
  --danger: #e08c6f; --danger-soft: rgba(224,140,111,0.14);
  --warning: #d9b074; --warning-soft: rgba(217,176,116,0.14);
  --info: #88a8c9; --info-soft: rgba(136,168,201,0.14);
} }

* { box-sizing: border-box; }
html, body, #root { min-height: 100%; margin: 0; }
body { min-width: 320px; overflow-x: hidden; }
button, input, select, textarea { font: inherit; letter-spacing: 0; }
button, select { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.48; }
a { color: var(--accent); }
code { font-family: var(--font-mono); font-size: 12px; color: var(--ink-2); }
::selection { background: var(--accent-soft); }

.app-shell { min-height: 100vh; background: var(--app-bg); }

/* ── 侧栏（暖白，仅发丝线分隔） ── */
.app-shell > aside {
  position: fixed; z-index: 30; inset: 0 auto 0 0; width: 244px; display: flex; flex-direction: column;
  background: var(--surface-side); color: var(--ink); border-right: 1px solid var(--line);
}
.brand { height: 76px; display: flex; align-items: center; gap: 11px; padding: 0 22px; border-bottom: 1px solid var(--line); }
.brand > div { min-width: 0; flex: 1; }
.brand strong { display: block; font-family: var(--font-display); font-size: 19px; line-height: 1.1; font-weight: 640; letter-spacing: -0.01em; }
.brand small { display: block; margin-top: 4px; font-size: 11px; color: var(--muted); font-weight: 500; }
.brand > .icon-button { display: none; color: var(--muted); }
.brand-mark { width: 38px; height: 38px; border-radius: 10px; display: inline-grid; place-items: center; color: var(--accent-ink); background: var(--accent); flex: 0 0 auto; }
.brand-mark.large { width: 48px; height: 48px; }

.app-shell > aside nav { padding: 16px 12px; display: grid; gap: 3px; }
.app-shell > aside nav button { height: 42px; border: 0; border-radius: 9px; background: transparent; color: var(--ink-2); display: flex; align-items: center; gap: 12px; padding: 0 12px; text-align: left; transition: background .15s, color .15s; }
.app-shell > aside nav button:hover { color: var(--ink); background: var(--hover); }
.app-shell > aside nav button.active { color: var(--ink); background: var(--surface); box-shadow: 0 1px 3px rgba(60,40,20,.06); position: relative; }
.app-shell > aside nav button.active::before { content: ""; position: absolute; left: 12px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.app-shell > aside nav button.active span { padding-left: 12px; }
.app-shell > aside nav button span { flex: 1; font-size: 14px; font-weight: 560; }
.app-shell > aside nav button i { font-style: normal; min-width: 20px; height: 20px; border-radius: 10px; display: inline-grid; place-items: center; background: var(--danger); color: #fff; font-size: 11px; }

/* 侧栏底部外观区 */
.side-footer { margin-top: auto; padding: 14px 16px 18px; border-top: 1px solid var(--line); display: grid; gap: 12px; }
.appearance-label { font-size: 10px; color: var(--muted); font-weight: 600; }
.accent-swatches { display: flex; gap: 7px; flex-wrap: wrap; }
.accent-swatches button { width: 22px; height: 22px; border-radius: 7px; border: 2px solid transparent; padding: 0; cursor: pointer; }
.accent-swatches button.on { border-color: var(--ink); box-shadow: 0 0 0 1px var(--surface) inset; }
.accent-hex { display: flex; align-items: center; gap: 8px; }
.accent-hex input[type="color"] { width: 28px; height: 28px; padding: 0; border: 1px solid var(--line); border-radius: 7px; background: none; cursor: pointer; }
.accent-hex input[type="text"] { flex: 1; height: 28px; font-family: var(--font-mono); font-size: 12px; }
.layout-toggle { display: flex; gap: 3px; padding: 3px; border-radius: 8px; background: var(--hover); }
.layout-toggle button { flex: 1; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 11px; font-weight: 560; }
.layout-toggle button.active { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(60,40,20,.08); }
.appearance-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.appearance-row .icon-button { color: var(--muted); }

.workspace { min-height: 100vh; margin-left: 244px; }
.topbar { height: 76px; position: sticky; z-index: 20; top: 0; display: flex; align-items: center; gap: 14px; padding: 0 32px; background: var(--bar); border-bottom: 1px solid var(--line); backdrop-filter: blur(12px); }
.topbar > .icon-button:first-child { display: none; }
.topbar h1 { margin: 0; font-family: var(--font-display); font-size: 23px; line-height: 1.2; font-weight: 640; letter-spacing: -0.01em; }
.topbar p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.top-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.page-content { padding: 28px 32px 48px; max-width: 1600px; margin: 0 auto; }
.mobile-nav { display: none; }

/* ── 布局 B：顶部导航 ── */
:root[data-layout="top"] .app-shell > aside { display: none; }
:root[data-layout="top"] .workspace { margin-left: 0; }
:root[data-layout="top"] .topbar > .icon-button:first-child { display: none; }
.top-nav { display: none; }
:root[data-layout="top"] .top-nav { display: flex; gap: 2px; }
.top-nav button { height: 34px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-2); font-size: 13px; font-weight: 560; }
.top-nav button:hover { color: var(--ink); background: var(--hover); }
.top-nav button.active { color: var(--ink); background: var(--surface); box-shadow: 0 1px 3px rgba(60,40,20,.06); }

/* ── 按钮 ── */
.button { min-height: 40px; border-radius: 9px; border: 1px solid var(--line); padding: 0 16px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-weight: 580; font-size: 13px; transition: background .15s, border-color .15s, transform .1s; }
.button:active:not(:disabled) { transform: translateY(1px); }
.button-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.button-primary:hover:not(:disabled) { background: var(--accent-press); border-color: var(--accent-press); }
.button-secondary { background: var(--surface); color: var(--ink-2); }
.button-secondary:hover:not(:disabled) { border-color: var(--muted); background: var(--surface-alt); }
.button-danger { background: var(--danger); color: #fff; border-color: var(--danger); }
.button-ghost { background: transparent; border-color: transparent; color: var(--muted); }
.button-ghost:hover:not(:disabled) { color: var(--ink); background: var(--hover); }
.icon-button { width: 36px; height: 36px; flex: 0 0 auto; border: 0; border-radius: 8px; background: transparent; color: var(--muted); display: inline-grid; place-items: center; transition: background .15s, color .15s; }
.icon-button:hover:not(:disabled) { color: var(--ink); background: var(--hover); }

/* ── 工具栏 ── */
.toolbar { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.toolbar-copy { display: flex; flex-direction: column; gap: 3px; }
.toolbar-copy strong { font-size: 14px; }
.toolbar-copy span { color: var(--muted); font-size: 12px; }
.filters { display: flex; align-items: center; gap: 9px; }
.search { width: 260px; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; color: var(--muted); }
.search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search input { min-width: 0; flex: 1; border: 0; outline: 0; background: none; }

/* ── 面板 / 卡片 ── */
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.section-head { min-height: 64px; padding: 0 20px; display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.section-head h2 { margin: 0; font-size: 14px; font-weight: 640; }
.section-head p { margin: 3px 0 0; font-size: 12px; color: var(--muted); }

/* ── 概览网格 ── */
.page-grid { display: grid; gap: 18px; }
.overview-grid { grid-template-columns: minmax(0, 1fr) 360px; }
.stats-strip { grid-column: 1 / -1; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; display: grid; grid-template-columns: repeat(4, 1fr); box-shadow: var(--shadow); }
.stat { display: flex; align-items: center; gap: 14px; padding: 20px 24px; position: relative; }
.stat:not(:last-child)::after { content: ""; position: absolute; right: 0; top: 26px; bottom: 26px; width: 1px; background: var(--line-soft); }
.stat-icon { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; color: var(--muted); background: var(--hover); }
.tone-green, .tone-blue, .tone-amber, .tone-red, .tone-neutral { color: var(--muted); background: var(--hover); }
.stat p { margin: 0 0 4px; color: var(--muted); font-size: 12px; }
.stat strong { font-family: var(--font-display); font-size: 27px; line-height: 1; font-weight: 640; letter-spacing: -0.02em; }
.recent-panel { min-width: 0; }
.quick-send { grid-column: 2; grid-row: 2; }
.stack-form { padding: 18px 20px 20px; display: grid; gap: 16px; }

/* ── 表单 ── */
label, .field-label { display: grid; gap: 7px; font-size: 13px; font-weight: 560; color: var(--ink-2); }
.field-label { margin-bottom: 8px; grid-template-columns: 1fr auto; }
.field-label span, .optional { font-weight: 400; color: var(--muted); font-size: 11px; }
input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); outline: 0; }
input, select { height: 40px; padding: 0 12px; }
textarea { padding: 10px 12px; resize: vertical; line-height: 1.5; }
input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
input::placeholder, textarea::placeholder { color: var(--faint); }
label small { font-weight: 400; color: var(--muted); line-height: 1.45; }
.segments { height: 36px; display: grid; grid-template-columns: repeat(4, 1fr); padding: 3px; border-radius: 8px; background: var(--hover); }
.segments button { min-width: 0; border: 0; border-radius: 6px; color: var(--muted); background: transparent; font-size: 12px; }
.segments button.active { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(60,40,20,.1); font-weight: 600; }

/* ── 表格 ── */
.table-wrap { min-width: 0; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { height: 44px; padding: 0 16px; text-align: left; color: var(--muted); font-size: 12px; font-weight: 500; white-space: nowrap; }
td { min-height: 56px; padding: 13px 16px; border-bottom: 1px solid var(--line-soft); color: var(--ink-2); font-size: 13px; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-alt); }
.table-title { display: flex; align-items: center; gap: 7px; color: var(--ink); font-size: 13px; margin-bottom: 4px; }
.muted-row { display: block; color: var(--muted); font-size: 11px; }
.nowrap { white-space: nowrap; }
.muted { color: var(--muted); }
.actions-col { text-align: right; }
.row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.row-actions .icon-button { width: 32px; height: 32px; }
.disabled-row { opacity: 0.55; }
.clickable-row { cursor: pointer; }
.clickable-row > td:last-child { text-align: right; color: var(--muted); }

/* ── 徽章 / 状态 ── */
.badge { width: fit-content; min-height: 24px; border-radius: 999px; display: inline-flex; align-items: center; gap: 5px; padding: 0 9px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.badge-delivered, .badge-success { color: var(--success); background: var(--success-soft); }
.badge-failed { color: var(--danger); background: var(--danger-soft); }
.badge-partial, .badge-retrying { color: var(--warning); background: var(--warning-soft); }
.badge-processing, .badge-sending { color: var(--info); background: var(--info-soft); }
.badge-queued, .badge-pending, .badge-skipped, .badge-revoked { color: var(--muted); background: var(--hover); }
.spin { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.severity { font-size: 11px; font-weight: 600; }
.severity-info { color: var(--info); } .severity-success { color: var(--success); } .severity-warning { color: var(--warning); } .severity-critical { color: var(--danger); }

/* ── 渠道图标 / 选择 ── */
.provider-cell { display: flex; align-items: center; gap: 10px; }
.provider-cell > span:last-child { display: grid; gap: 2px; }
.provider-cell small { color: var(--muted); font-size: 10px; }
.provider-icon { flex: 0 0 auto; display: inline-grid; place-items: center; overflow: hidden; }
.provider-icon img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
.provider-select { width: 100%; min-height: 56px; padding: 9px 13px; display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); text-align: left; transition: border-color .15s, box-shadow .15s; }
.provider-select:hover:not(:disabled) { border-color: var(--muted); }
.provider-select:disabled { cursor: not-allowed; opacity: 0.7; }
.provider-select:focus-visible { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.provider-select-text { min-width: 0; flex: 1; display: grid; gap: 2px; }
.provider-select-text strong { font-size: 13px; color: var(--ink); }
.provider-select-text small { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-select-hint { flex: 0 0 auto; font-size: 11px; font-weight: 600; color: var(--muted); padding: 3px 9px; border-radius: 999px; background: var(--hover); }

/* ── 渠道选择弹框 ── */
.picker { display: grid; gap: 13px; padding: 20px 22px 10px; }
.picker-search { height: 42px; display: flex; align-items: center; gap: 9px; padding: 0 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; color: var(--muted); }
.picker-search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.picker-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: none; }
.picker-cats { display: flex; flex-wrap: wrap; gap: 6px; }
.picker-cats button { height: 30px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); font-size: 12px; font-weight: 560; }
.picker-cats button.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.picker-cats button i { font-style: normal; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; display: inline-grid; place-items: center; background: var(--hover); color: var(--ink-2); font-size: 10px; }
.picker-cats button.active i { background: var(--accent); color: var(--accent-ink); }
.picker-grid { max-height: 46vh; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 9px; align-content: start; padding: 2px; }
.picker-tile { position: relative; min-height: 66px; padding: 11px 12px; display: flex; align-items: center; gap: 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); text-align: left; transition: border-color .14s, box-shadow .14s, background .14s; }
.picker-tile:hover:not(:disabled), .picker-tile.focused { border-color: var(--accent); background: var(--surface-alt); box-shadow: 0 0 0 3px var(--accent-soft); }
.picker-tile.current { border-color: var(--accent); }
.picker-tile-name { min-width: 0; display: grid; gap: 2px; }
.picker-tile-name strong { font-size: 13px; color: var(--ink); }
.picker-tile-name small { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-current { position: absolute; top: 7px; right: 9px; font-size: 10px; font-weight: 600; color: var(--accent); }
.picker-empty { grid-column: 1 / -1; min-height: 130px; display: grid; place-items: center; text-align: center; color: var(--muted); font-size: 13px; }
.picker-empty code { color: var(--ink-2); }
.picker-footer { min-height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 5px; border-top: 1px solid var(--line-soft); color: var(--muted); font-size: 12px; }
.picker-footer small { font-size: 11px; }

.builder-empty { margin: 0; padding: 26px 12px; text-align: center; color: var(--muted); font-size: 12px; }
.config-count { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.switch { width: 38px; height: 22px; padding: 2px; border: 0; border-radius: 12px; background: var(--hover); border: 1px solid var(--line); transition: background .15s; }
.switch span { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,.15); transition: transform .15s; }
.switch.on { background: var(--accent); border-color: var(--accent); }
.switch.on span { transform: translateX(16px); background: var(--accent-ink); }

/* ── 空状态 ── */
.empty { min-height: 280px; padding: 44px 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.empty > span { width: 48px; height: 48px; border: 1px solid var(--line); border-radius: 12px; display: grid; place-items: center; color: var(--muted); background: var(--surface-alt); }
.empty h3 { margin: 16px 0 6px; font-size: 15px; }
.empty p { max-width: 380px; margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.55; }

/* ── 路由 ── */
.route-list { display: grid; gap: 10px; }
.route-row { min-height: 88px; padding: 15px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; display: grid; grid-template-columns: 44px 190px minmax(240px, 1fr) auto 80px; align-items: center; gap: 15px; box-shadow: var(--shadow); }
.route-strategy { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 10px; color: var(--accent); background: var(--accent-soft); }
.route-strategy.fallback { color: var(--warning); background: var(--warning-soft); }
.route-identity h3 { margin: 0 0 5px; font-size: 14px; }
.route-flow > span { display: block; margin-bottom: 7px; font-size: 11px; color: var(--muted); font-weight: 600; }
.route-flow > div { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.route-node { min-height: 27px; border: 1px solid var(--line); border-radius: 999px; padding: 0 9px 0 5px; display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); font-size: 11px; background: var(--surface-alt); }
.route-node i, .order-index { width: 18px; height: 18px; border-radius: 6px; display: inline-grid; place-items: center; font-style: normal; font-size: 10px; color: var(--accent); background: var(--accent-soft); }
.state-dot { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; white-space: nowrap; }
.state-dot::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.state-dot.active { color: var(--success); }
.state-dot.active::before { background: var(--success); }

.scope-pills { display: flex; gap: 4px; }
.scope-pills span { padding: 3px 7px; border-radius: 999px; background: var(--hover); color: var(--ink-2); font-size: 10px; }
.with-icon { flex-direction: row; }

/* ── 系统页 ── */
.system-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.system-grid .panel { min-width: 0; }
.system-status dl { margin: 0; }
.system-status dl > div { min-height: 49px; display: grid; grid-template-columns: 150px minmax(0,1fr); align-items: center; padding: 0 20px; border-bottom: 1px solid var(--line-soft); }
.system-status dl > div:last-child { border: 0; }
.system-status dt { color: var(--muted); font-size: 12px; }
.system-status dd { margin: 0; min-width: 0; font-size: 13px; }
.system-status dd code { display: block; overflow: hidden; text-overflow: ellipsis; }
.system-status dd span { display: inline-flex; align-items: center; gap: 5px; }
.health { color: var(--success); display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; }
.health i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 4px var(--success-soft); }
.warning-text { color: var(--warning); }
.capability-list { padding: 8px 20px 16px; }
.capability-list .capability-row { min-height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line-soft); }
.capability-list .capability-row:last-child { border-bottom: 0; }
.capability-list .capability-label { color: var(--ink-2); font-size: 13px; font-weight: 560; }
.capability-list .capability-count { min-width: 30px; height: 26px; padding: 0 9px; border-radius: 999px; display: inline-grid; place-items: center; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600; }
.endpoint-sample pre { margin: 0; min-height: 220px; padding: 20px; overflow: auto; background: #241f1c; color: #d5c9bd; font: 12px/1.65 var(--font-mono); border-radius: 0 0 11px 11px; }
.security-list ul { margin: 0; padding: 8px 20px; list-style: none; }
.security-list li { min-height: 50px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--line-soft); color: var(--success); }
.security-list li:last-child { border: 0; }
.security-list li span { display: grid; gap: 3px; }
.security-list li strong { color: var(--ink); font-size: 12px; }
.security-list li small { color: var(--muted); font-size: 11px; }

/* ── 接入页 ── */
.integration-layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
.endpoint-hero { grid-column: 1 / -1; min-height: 112px; padding: 24px 26px; display: flex; align-items: center; justify-content: space-between; gap: 20px; background: var(--accent-soft); color: var(--ink); border-color: var(--line); }
.endpoint-hero .eyebrow { display: block; margin-bottom: 9px; color: var(--accent); font-size: 11px; font-weight: 600; }
.endpoint-hero h2 { max-width: min(900px, 75vw); margin: 0; overflow-wrap: anywhere; font-family: var(--font-display); font-size: 20px; font-weight: 580; }
.endpoint-hero p { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.endpoint-hero .icon-button { color: var(--ink-2); background: var(--surface); }
.endpoint-hero .icon-button:hover { color: var(--ink); background: var(--surface-alt); }
.integration-config { min-width: 0; overflow: hidden; }
.client-tabs { min-height: 53px; padding: 9px 12px 0; display: flex; gap: 3px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.client-tabs button { min-width: 0; height: 44px; padding: 0 14px; display: inline-flex; align-items: center; gap: 7px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); white-space: nowrap; font-size: 12px; }
.client-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.config-head { min-height: 64px; padding: 11px 14px 11px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.config-head > div { min-width: 0; display: grid; gap: 4px; }
.config-head strong { font-size: 13px; }
.config-head code { color: var(--muted); font-size: 11px; }
.integration-code { min-height: 320px; max-height: 460px; margin: 0; padding: 20px; overflow: auto; background: #241f1c; color: #d5c9bd; font: 12px/1.75 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.integration-notes { display: grid; gap: 18px; }
.connection-facts { margin: 0; }
.connection-facts > div { min-height: 47px; padding: 0 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line-soft); }
.connection-facts > div:last-child { border: 0; }
.connection-facts dt { color: var(--muted); font-size: 11px; }
.connection-facts dd { margin: 0; text-align: right; font-size: 11px; font-weight: 560; }
.env-callout { min-height: 80px; padding: 16px 18px; display: flex; align-items: center; gap: 12px; color: var(--accent); }
.env-callout > div { min-width: 0; }
.env-callout strong { color: var(--ink); font-size: 12px; }
.env-callout p { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.45; }

/* ── 模态 ── */
.modal-backdrop { position: fixed; z-index: 100; inset: 0; padding: 24px; display: grid; place-items: center; background: rgba(44, 40, 35, 0.4); backdrop-filter: blur(4px); }
.modal { width: min(480px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; overflow: hidden; border-radius: 16px; background: var(--surface); box-shadow: var(--shadow-lg); animation: modal-in .16s ease-out; }
.modal-wide { width: min(720px, 100%); }
@keyframes modal-in { from { opacity: 0; transform: translateY(8px); } }
.modal > header { min-height: 62px; flex: 0 0 auto; padding: 0 18px 0 22px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; }
.modal > header h2 { margin: 0; font-size: 17px; font-family: var(--font-display); font-weight: 600; }
.modal-body { padding: 20px 22px; overflow-y: auto; display: grid; gap: 18px; }
.modal-actions { margin: 2px -22px -20px; padding: 15px 22px; border-top: 1px solid var(--line-soft); display: flex; justify-content: flex-end; gap: 8px; background: var(--surface-alt); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.provider-note { min-height: 56px; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 11px; padding: 10px 12px; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--line); border-radius: 10px; }
.provider-note strong { font-size: 12px; }
.provider-note p { margin: 2px 0 0; color: var(--muted); font-size: 11px; }
.provider-note a { width: 30px; height: 30px; display: grid; place-items: center; }
.config-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 15px 13px; }
.config-fields label:has(textarea), .config-fields label:has(.check-row) { grid-column: 1 / -1; }
.optional { margin-left: 5px; }
.check-row { min-height: 38px; display: flex; align-items: center; gap: 8px; font-weight: 500; }
.check-row input, .channel-choice input, .scope-list input, .destination-checks input { width: 16px; height: 16px; accent-color: var(--accent); }
.strategy-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.strategy-picker button { min-height: 64px; display: flex; align-items: center; gap: 11px; padding: 11px 13px; text-align: left; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--muted); }
.strategy-picker button.active { color: var(--accent); border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.strategy-picker span { display: grid; gap: 3px; }
.strategy-picker strong { color: var(--ink); font-size: 12px; }
.strategy-picker small { color: var(--muted); font-size: 10px; }
.route-builder { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; max-height: 260px; }
.available-channels, .selected-order { overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; }
.channel-choice { min-height: 52px; padding: 7px 10px; display: grid; grid-template-columns: 18px 30px 1fr; align-items: center; gap: 8px; border-bottom: 1px solid var(--line-soft); cursor: pointer; }
.channel-choice:last-child { border: 0; }
.channel-choice > span:last-child { display: grid; gap: 2px; }
.channel-choice strong { font-size: 11px; }
.channel-choice small { color: var(--muted); font-size: 10px; }
.selected-order > p { margin: 0; height: 36px; padding: 0 11px; display: flex; align-items: center; background: var(--surface-alt); color: var(--muted); font-size: 11px; font-weight: 600; }
.selected-order > div { min-height: 47px; padding: 6px 8px; display: flex; align-items: center; gap: 9px; border-top: 1px solid var(--line-soft); }
.selected-order strong { flex: 1; font-size: 11px; }
.order-buttons { display: flex; }
.order-buttons .icon-button { width: 28px; height: 28px; }

/* ── 投递详情 ── */
.delivery-head { display: grid; grid-template-columns: minmax(0,1fr) 270px; gap: 22px; }
.delivery-head h3 { margin: 13px 0 8px; font-size: 18px; font-family: var(--font-display); font-weight: 600; }
.delivery-head p { margin: 0; color: var(--ink-2); font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
.delivery-head a { margin-top: 11px; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; max-width: 100%; overflow-wrap: anywhere; }
.delivery-head dl { margin: 0; padding: 4px 0; border-left: 1px solid var(--line); }
.delivery-head dl div { padding: 6px 0 9px 17px; }
.delivery-head dt { margin-bottom: 3px; color: var(--muted); font-size: 11px; }
.delivery-head dd { margin: 0; font-size: 11px; overflow-wrap: anywhere; }
.attempts { border-top: 1px solid var(--line); padding-top: 18px; }
.attempts h4 { margin: 0 0 13px; font-size: 13px; }
.attempt { min-height: 60px; display: grid; grid-template-columns: 30px minmax(0,1fr) auto 78px; align-items: center; gap: 11px; position: relative; margin-left: 9px; padding-left: 17px; }
.attempt-line { position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: var(--line); }
.attempt-line::before { content: ""; position: absolute; top: 26px; left: -3px; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.attempt > div { display: grid; gap: 2px; }
.attempt strong { font-size: 11px; }
.attempt p, .attempt time { margin: 0; color: var(--muted); font-size: 10px; }
.attempt time { text-align: right; }
.error-text { max-width: 320px; color: var(--danger); overflow-wrap: anywhere; }
.modal-loading { min-height: 260px; display: grid; place-items: center; color: var(--accent); }

.warning-banner { min-height: 62px; padding: 12px 14px; display: flex; gap: 11px; color: var(--warning); border: 1px solid var(--line); background: var(--warning-soft); border-radius: 10px; }
.warning-banner strong { color: var(--warning); font-size: 12px; }
.warning-banner p { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.copy-field { min-height: 47px; padding-left: 12px; border: 1px solid var(--line); border-radius: 8px; display: flex; align-items: center; gap: 8px; background: var(--surface-alt); }
.copy-field code { min-width: 0; flex: 1; overflow-wrap: anywhere; color: var(--accent); }
.scope-list { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.scope-list label { min-height: 56px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; display: flex; align-items: center; gap: 10px; cursor: pointer; }
.scope-list label > span { display: grid; gap: 3px; }
.scope-list strong { font-size: 11px; }
.scope-list code { font-size: 10px; }
.inline-toggle { grid-template-columns: auto 1fr; align-items: center; }
.inline-toggle > span { display: grid; gap: 3px; }
.inline-toggle strong { font-size: 12px; }
.inline-toggle small { font-size: 10px; }
.destination-checks { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.destination-checks label { min-height: 41px; padding: 0 11px; display: grid; grid-template-columns: 16px 1fr auto; align-items: center; gap: 8px; border-bottom: 1px solid var(--line-soft); font-size: 11px; }
.destination-checks small { font-size: 10px; }

/* ── Toast ── */
.toast-stack { position: fixed; z-index: 150; right: 22px; bottom: 22px; width: min(360px, calc(100vw - 32px)); display: grid; gap: 9px; }
.toast { min-height: 50px; padding: 8px 9px 8px 14px; display: flex; align-items: center; gap: 10px; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-left: 3px solid var(--muted); border-radius: 10px; box-shadow: var(--shadow); font-size: 13px; }
.toast.success { border-left-color: var(--success); }
.toast.success > svg { color: var(--success); }
.toast.error { border-left-color: var(--danger); }
.toast.error > svg { color: var(--danger); }
.toast > span { flex: 1; }
.toast .icon-button { color: var(--muted); }

/* ── 启动 / 登录 ── */
.boot { min-height: 100vh; display: flex; align-items: center; justify-content: center; gap: 14px; color: var(--accent); }
.login-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--app-bg); }
.login-panel { width: min(400px, 100%); padding: 36px; border-radius: 16px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-lg); }
.login-panel .eyebrow { margin: 22px 0 8px; color: var(--accent); font-size: 12px; font-weight: 600; }
.login-panel h1 { margin: 0; font-family: var(--font-display); font-size: 24px; font-weight: 640; letter-spacing: -0.01em; }
.login-copy { margin: 9px 0 26px; color: var(--muted); font-size: 13px; }
.login-panel form { display: grid; gap: 15px; }
.password-input { display: flex; border: 1px solid var(--line); border-radius: 8px; }
.password-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.password-input input { border: 0; box-shadow: none; }
.inline-error { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--danger-soft); color: var(--danger); font-size: 12px; }
.login-panel footer { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
.nav-backdrop { display: none; }

/* ── 响应式 ── */
@media (max-width: 1100px) {
  .overview-grid { grid-template-columns: minmax(0, 1fr) 320px; }
  .route-row { grid-template-columns: 42px 160px minmax(200px,1fr) auto 72px; }
}
@media (max-width: 900px) {
  .app-shell > aside { transform: translateX(-100%); transition: transform .2s ease; box-shadow: var(--shadow-lg); }
  .app-shell > aside.open { transform: translateX(0); }
  .brand > .icon-button { display: inline-grid; }
  .nav-backdrop { display: block; position: fixed; z-index: 29; inset: 0; background: rgba(44,40,35,.3); }
  .workspace { margin-left: 0; }
  .topbar > .icon-button:first-child { display: inline-grid; }
  :root[data-layout="top"] .top-nav { display: none; }
  .overview-grid { grid-template-columns: 1fr; }
  .quick-send { grid-column: 1; grid-row: auto; }
  .recent-panel { grid-row: 3; }
  .route-row { grid-template-columns: 42px 170px minmax(220px,1fr) auto 74px; overflow-x: auto; }
  .integration-layout { grid-template-columns: 1fr; }
  .integration-notes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  body { padding-bottom: 64px; }
  .topbar { height: 66px; padding: 0 16px; }
  .topbar h1 { font-size: 18px; }
  .topbar p { display: none; }
  .page-content { padding: 16px 14px 28px; }
  .mobile-nav { position: fixed; z-index: 25; inset: auto 0 0; height: calc(64px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); display: grid; grid-template-columns: repeat(5, 1fr); background: var(--bar); border-top: 1px solid var(--line); backdrop-filter: blur(12px); }
  .mobile-nav button { border: 0; background: transparent; color: var(--muted); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; font-size: 10px; }
  .mobile-nav button.active { color: var(--accent); font-weight: 600; }
  .stats-strip { grid-template-columns: repeat(2, 1fr); }
  .stat { min-height: 88px; padding: 16px; }
  .stat:nth-child(2)::after { display: none; }
  .stat:nth-child(-n+2) { border-bottom: 1px solid var(--line-soft); }
  .stat-icon { width: 36px; height: 36px; }
  .stat strong { font-size: 22px; }
  .toolbar { align-items: stretch; }
  .filters { min-width: 0; flex: 1; }
  .search { min-width: 0; width: auto; flex: 1; }
  .filters select { width: 116px; }
  .toolbar-copy span { display: none; }
  .panel { border-radius: 10px; }
  table { min-width: 680px; }
  .recent-panel table { min-width: 610px; }
  .route-list { overflow-x: auto; }
  .route-row { min-width: 720px; }
  .system-grid { grid-template-columns: 1fr; }
  .endpoint-hero { min-height: 100px; padding: 18px 18px; }
  .endpoint-hero h2 { max-width: calc(100vw - 108px); font-size: 15px; }
  .client-tabs button { padding: 0 11px; }
  .client-tabs button span { display: none; }
  .config-head { align-items: flex-start; }
  .config-head .button { min-width: 40px; padding: 0 11px; }
  .integration-code { min-height: 280px; padding: 16px; font-size: 11px; }
  .integration-notes { grid-template-columns: 1fr; }
  .modal-backdrop { padding: 0; align-items: end; }
  .modal, .modal-wide { width: 100%; max-height: 92vh; border-radius: 16px 16px 0 0; }
  .form-grid, .config-fields, .strategy-picker, .route-builder, .scope-list, .destination-checks, .delivery-head { grid-template-columns: 1fr; }
  .config-fields label:has(textarea), .config-fields label:has(.check-row) { grid-column: 1; }
  .route-builder { max-height: none; }
  .available-channels, .selected-order { max-height: 210px; }
  .delivery-head dl { border-left: 0; border-top: 1px solid var(--line); padding-top: 9px; }
  .delivery-head dl div { padding-left: 0; }
  .attempt { grid-template-columns: 30px minmax(100px,1fr) auto; }
  .attempt time { display: none; }
  .toast-stack { right: 16px; bottom: 80px; }
  .login-panel { padding: 28px 24px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

- [ ] **Step 2: Verify build + typecheck**

Run: `npm run build:web && npm run typecheck`
Expected: both pass (CSS changes don't affect typecheck; build succeeds with no errors).

- [ ] **Step 3: Commit**

```bash
git add src/web/styles.css
git commit -m "style(web): rewrite tokens + components to warm-editorial system"
```

---

### Task 3: Boot script + index.html meta

**Files:**
- Modify: `src/web/index.html`

**Interfaces:**
- Produces: an inline script that reads `rd-theme`, `rd-accent`, `rd-layout` from `localStorage` and applies `data-theme`, the derived accent vars, and `data-layout` before first paint (avoids FOUC). The accent derivation logic is a compact inline copy of `deriveAccentVars`/`pickAccentInk` (acceptable duplication for a boot script; mirrors the existing inline theme approach).

- [ ] **Step 1: Update `index.html`**

Replace the `<head>` of `src/web/index.html` so the full file becomes:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#faf7f2" />
    <meta name="description" content="RelayDock notification control plane for AI agents" />
    <title>RelayDock</title>
    <script>try{
      var r=document.documentElement,s=localStorage.getItem('rd-theme');
      if(s==='dark'||s==='light')r.setAttribute('data-theme',s);
      var la=localStorage.getItem('rd-layout');
      if(la==='sidebar'||la==='top')r.setAttribute('data-layout',la);
      var ac=localStorage.getItem('rd-accent');
      function pl(h){h=h.replace('#','');if(h.length===3)h=h.split('').map(function(c){return c+c}).join('');var n=parseInt(h,16)||0;return {r:(n>>16)&255,g:(n>>8)&255,b:n&255};}
      function cl(c){var s=c/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4);}
      function lum(h){var c=pl(h);return 0.2126*cl(c.r)+0.7152*cl(c.g)+0.0722*cl(c.b);}
      function ink(h){var a=lum(h),w=1,d=lum('#2c2823');var cr=function(x,y){var hi=x>=y?x:y,lo=x>=y?y:x;return (hi+0.05)/(lo+0.05);};return cr(a,w)>=cr(a,d)?'#ffffff':'#2c2823';}
      if(ac){var c=pl(ac);r.style.setProperty('--accent',ac);r.style.setProperty('--accent-ink',ink(ac));r.style.setProperty('--accent-soft','rgba('+c.r+','+c.g+','+c.b+',0.14)');}
    }catch(e){}</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Verify build**

Run: `npm run build:web`
Expected: build succeeds; `dist/index.html` contains the inline script.

- [ ] **Step 3: Commit**

```bash
git add src/web/index.html
git commit -m "feat(web): apply accent/layout/theme before first paint"
```

---

### Task 4: AppearanceControls component + wire into ui.tsx

**Files:**
- Create: `src/web/components/AppearanceControls.tsx`
- Modify: `src/web/components/ui.tsx` (replace the local `useTheme`/`ThemeToggle` with re-exports from the new module)

**Interfaces:**
- Consumes: `useAppearance`, `setAccent`, `cycleTheme`, `setLayout`, `ACCENT_PRESETS` from `../appearance`.
- Produces: `AppearanceControls` (sidebar footer variant) and `ThemeToggle` (topbar icon, kept for App.tsx's top-actions), exported from `ui.tsx`.

- [ ] **Step 1: Create `AppearanceControls.tsx`**

```tsx
import { Monitor, Moon, Sun } from 'lucide-react';
import { ACCENT_PRESETS, useAppearance, setAccent, cycleTheme, setLayout } from '../appearance';

/* ────────────────────────────────────────────────────────────
 * 外观偏好控件：主题循环 + 强调色（预设 + 自定义 hex）+ 布局。
 * ──────────────────────────────────────────────────────────── */

export function ThemeToggle() {
  const { theme } = useAppearance();
  const Icon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  const label = theme === 'system' ? '跟随系统' : theme === 'dark' ? '暗色' : '亮色';
  return (
    <button className="icon-button" title={`主题：${label}（点击切换）`} aria-label={`主题：${label}`} onClick={cycleTheme}>
      <Icon size={17} />
    </button>
  );
}

export function AppearanceControls() {
  const { accent, layout } = useAppearance();
  return (
    <div className="side-footer">
      <div>
        <div className="appearance-label">主题色</div>
        <div className="accent-swatches" role="group" aria-label="选择主题色">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.id}
              title={p.name}
              aria-label={p.name}
              aria-pressed={accent.toLowerCase() === p.hex.toLowerCase()}
              className={accent.toLowerCase() === p.hex.toLowerCase() ? 'on' : ''}
              style={{ background: p.hex }}
              onClick={() => setAccent(p.hex)}
            />
          ))}
        </div>
        <div className="accent-hex">
          <input
            type="color"
            aria-label="自定义主题色"
            value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#c2603f'}
            onChange={(e) => setAccent(e.target.value)}
          />
          <input
            type="text"
            aria-label="主题色 hex"
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            onBlur={(e) => { const v = e.target.value.trim(); if (/^#?[0-9a-fA-F]{6}$/.test(v)) setAccent(v.startsWith('#') ? v : '#' + v); }}
          />
        </div>
      </div>
      <div>
        <div className="appearance-label">布局</div>
        <div className="layout-toggle" role="group" aria-label="布局切换">
          <button className={layout === 'sidebar' ? 'active' : ''} onClick={() => setLayout('sidebar')}>侧栏</button>
          <button className={layout === 'top' ? 'active' : ''} onClick={() => setLayout('top')}>顶部</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `ui.tsx` to remove local theme logic**

In `src/web/components/ui.tsx`, delete the `useTheme` function and the local `ThemeToggle` definition, and re-export from the new module. The top of the file's theme-related block (lines ~40–55) becomes:

```tsx
export { ThemeToggle } from './AppearanceControls';
```

Concretely, replace this block in `ui.tsx`:

```tsx
type ThemeMode = 'system' | 'dark' | 'light';
function useTheme(): [ThemeMode, () => void] {
  const [mode, setMode] = useState<ThemeMode>(() => (localStorage.getItem('rd-theme') as ThemeMode) || 'system');
  useEffect(() => {
    const root = document.documentElement;
    mode === 'system' ? root.removeAttribute('data-theme') : root.setAttribute('data-theme', mode);
    localStorage.setItem('rd-theme', mode);
  }, [mode]);
  return [mode, () => setMode((old) => (old === 'system' ? 'dark' : old === 'dark' ? 'light' : 'system'))];
}

export function ThemeToggle() {
  const [mode, cycle] = useTheme();
  const [Icon, label] = mode === 'system' ? [Monitor, '跟随系统'] : mode === 'dark' ? [Moon, '暗色'] : [Sun, '亮色'];
  return <IconButton label={`主题：${label}（点击切换）`} icon={Icon} onClick={cycle} />;
}
```

with:

```tsx
export { ThemeToggle } from './AppearanceControls';
```

Also remove the now-unused `Monitor, Moon, Sun` imports from `ui.tsx` (they were only used by the deleted `ThemeToggle`). Keep the other lucide imports (`AlertTriangle, Check, CheckCircle2, Clock3, LoaderCircle, X, XCircle, type LucideIcon`).

- [ ] **Step 3: Verify build + typecheck**

Run: `npm run build:web && npm run typecheck`
Expected: pass. (App.tsx still imports `ThemeToggle` from `./components/ui` — re-export keeps it working.)

- [ ] **Step 4: Commit**

```bash
git add src/web/components/AppearanceControls.tsx src/web/components/ui.tsx
git commit -m "feat(web): add AppearanceControls (accent picker + layout toggle)"
```

---

### Task 5: App.tsx shell restructure

**Files:**
- Modify: `src/web/App.tsx`

**Interfaces:**
- Consumes: `useAppearance` from `./appearance`, `AppearanceControls` + `ThemeToggle` from `./components/ui`.
- Produces: a light sidebar shell that mounts `AppearanceControls` in the sidebar footer, renders a top-nav when `layout === 'top'`, and removes the uppercase `NOTIFICATION FABRIC` eyebrow.

- [ ] **Step 1: Edit `App.tsx` imports**

In `src/web/App.tsx`, add imports for the appearance store and controls. Replace this import line:

```tsx
import { IconButton, ThemeToggle, Toasts, type Notify, type Toast } from './components/ui';
```

with:

```tsx
import { AppearanceControls, IconButton, ThemeToggle, Toasts, type Notify, type Toast } from './components/ui';
import { useAppearance } from './appearance';
```

- [ ] **Step 2: Read layout state + remove uppercase eyebrow**

Inside the `App` component, after the existing `useState` hooks (around line 46, after `const [menu, setMenu] = useState(false);`), add:

```tsx
  const { layout } = useAppearance();
```

Then make two edits to the sidebar block. First, replace the uppercase eyebrow text — change:

```tsx
          <div><strong>RelayDock</strong><small>NOTIFICATION FABRIC</small></div>
```

to:

```tsx
          <div><strong>RelayDock</strong><small>通知控制台</small></div>
```

Second, mount the appearance controls after the sidebar `</nav>` — change:

```tsx
          ))}
        </nav>
      </aside>
```

to:

```tsx
          ))}
        </nav>
        <AppearanceControls />
      </aside>
```

- [ ] **Step 3: Add top-nav for layout B**

In the topbar's `.top-actions`, add a top-nav before `ThemeToggle`. Replace:

```tsx
          <div className="top-actions">
            <ThemeToggle />
            <IconButton label="刷新数据" icon={RefreshCw} onClick={refresh} />
          </div>
```

with:

```tsx
          <div className="top-actions">
            <nav className="top-nav">
              {nav.map(({ id, label, icon: Icon }) => (
                <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <ThemeToggle />
            <IconButton label="刷新数据" icon={RefreshCw} onClick={refresh} />
          </div>
```

- [ ] **Step 4: Verify build + typecheck**

Run: `npm run build:web && npm run typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx
git commit -m "feat(web): light sidebar shell + appearance footer + top-nav layout"
```

---

### Task 6: Component markup cleanup (eyebrows + inline hardcoded colors)

**Files:**
- Modify: `src/web/components/Login.tsx`
- Modify: `src/web/components/Integrations.tsx`
- Modify: `src/web/components/ProviderIcon.tsx`

**Interfaces:**
- None new. These are small markup/constant edits to remove uppercase AI-template eyebrows and a fallback brand color.

- [ ] **Step 1: Login.tsx — replace uppercase eyebrow with plain label**

In `src/web/components/Login.tsx`, replace:

```tsx
        <p className="eyebrow">RELAYDOCK / ADMIN</p>
```

with:

```tsx
        <p className="eyebrow">RelayDock 管理控制台</p>
```

- [ ] **Step 2: Integrations.tsx — replace uppercase eyebrow**

In `src/web/components/Integrations.tsx`, replace:

```tsx
          <span className="eyebrow">STREAMABLE HTTP</span>
```

with:

```tsx
          <span className="eyebrow">远程 MCP 端点</span>
```

- [ ] **Step 3: ProviderIcon.tsx — neutral fallback brand color**

In `src/web/components/ProviderIcon.tsx`, replace the fallback in `providerBrand`:

```tsx
export function providerBrand(provider: ProviderId): { hex: string } {
  return { hex: BRAND_HEX[provider] ?? '5f9e8e' };
}
```

with:

```tsx
export function providerBrand(provider: ProviderId): { hex: string } {
  return { hex: BRAND_HEX[provider] ?? '6b6353' };
}
```

- [ ] **Step 4: Verify build + typecheck + tests**

Run: `npm run build:web && npm run typecheck && npm test`
Expected: build + typecheck pass; all tests (including the new `appearance.test.ts`) pass; no server tests regress.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/Login.tsx src/web/components/Integrations.tsx src/web/components/ProviderIcon.tsx
git commit -m "style(web): remove uppercase eyebrows, neutral provider fallback"
```

---

### Task 7: Full visual verification + boot FOUC check

**Files:** none (verification only)

- [ ] **Step 1: Run the dev server and verify in browser**

Run: `npm run dev:web` (or `npm run dev` for full stack)
Open the app in a browser and verify against the spec's acceptance criteria (§10):

1. Light mode: warm-cream canvas, ink text, **no dark sidebar**, no uppercase eyebrows, no colored stat icon squares (all stat icons neutral).
2. Accent: switching a preset swatch in the sidebar footer instantly recolors primary buttons, links, focus rings, badges-tinted-by-accent (route node indices, capability counts), and the brand mark; persists across refresh (no FOUC on reload).
3. Custom hex: typing a 6-digit hex + blurring recolors; the color picker wheel does too.
4. Layout: toggling 侧栏/顶部 swaps between the sidebar shell and the top-nav shell; persists across refresh.
5. Dark mode (toggle theme to 暗色): warm near-black canvas; accent picker still works.
6. Login page: warm centered card, serif title, no `RELAYDOCK / ADMIN` uppercase eyebrow.
7. Integrations hero: accent-tinted soft background (not the old dark-green slab); code block is warm-dark `#241f1c`.
8. Route list / delivery attempt timeline: warm cards, timeline dots neutral (not the old green).

If anything is off, fix it in the relevant file and re-verify before committing.

- [ ] **Step 2: Final clean commit (if any fixes were made)**

If fixes were made in Step 1, commit them:

```bash
git add -A
git commit -m "style(web): final warm-editorial polish"
```

If no fixes were needed, this step is a no-op — the feature is complete.
