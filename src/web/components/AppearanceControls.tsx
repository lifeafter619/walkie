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
