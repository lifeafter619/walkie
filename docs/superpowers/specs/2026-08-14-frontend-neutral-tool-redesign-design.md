# RelayDock 前端重设计：中性工具风

- **日期：** 2026-08-14
- **状态：** 已确认（待实现）
- **范围：** `src/web/` 表现层 + 信息架构。无后端改动、无 API 改动、无新依赖。
- **目标：** 简单直接、无 AI 感。参考 Linear / Vercel Dashboard / GitHub 的中性工具语言。
- **取代：** `2026-08-14-frontend-redesign-design.md`（Warm Editorial 方向，已落地为当前 UI；本次整体替换其视觉与外观自定义系统）。

## 1. 背景与问题

当前前端是 Warm Editorial 风格（暖白底、陶土强调色、衬线标题、侧栏外观自定义区）。问题：

- **过度设计**：双布局模式（侧栏/顶栏可切换）、六预设强调色选择器 + 自定义 hex + 对比度推导系统——对自托管工具是 gratuitous 的复杂度。
- **装饰痕迹**：衬线显示字体、统计卡彩色图标芯片、页面装饰性副标题、accent-soft 大色块 hero、模态入场动画。
- **信息架构冗余**：8 个页面中「凭据」与「Agents」都是密钥管理却分两处；「系统」页的 MCP 端点面板与「接入」页 hero 重复。
- **密度偏低**：控件 40px 高、内容区 max-width 1600px，表单页显得散。

用户确认的方向：**中性工具风**；**删除全部外观自定义，只留明暗主题**；**视觉 + 信息架构都改**。

## 2. 反 AI 感设计准则（硬约束）

实现与后续迭代都必须遵守：

1. 无渐变、无发光、无毛玻璃、无 `backdrop-filter`。
2. 无 eyebrow 小标签、无装饰性副标题、UI 文案无 emoji。
3. 无彩色图标方块（stat 卡的 tone-green/blue/amber 图标芯片）。
4. 一种强调色；状态色只出现在真实状态上。
5. 1px 边线代替投影；阴影只留给模态框、Toast、下拉层。
6. 只用系统字体栈，零网络字体；ID/URL/密钥/代码一律等宽字体。
7. 状态表达 = 小圆点 + 文字，不用彩色胶囊背景。

## 3. 设计令牌

全部外观仍由 CSS 自定义属性驱动，但令牌集大幅收敛。

### 3.1 中性色阶

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `--app-bg` | `#fafafa` | `#0a0a0a` |
| `--surface` | `#ffffff` | `#141414` |
| `--surface-alt`（表格头/次级面） | `#fafafa` | `#1a1a1a` |
| `--hover` | `#f4f4f5` | `#1f1f1f` |
| `--ink` | `#18181b` | `#ededed` |
| `--ink-2` | `#52525b` | `#a1a1aa` |
| `--muted` | `#a1a1aa` | `#52525b` |
| `--faint`（占位符） | `#d4d4d8` | `#3f3f46` |
| `--line` | `#e4e4e7` | `#262626` |
| `--line-soft` | `#f0f0f1` | `#1f1f1f` |

### 3.2 强调色（固定，不可配置）

- **主按钮/选中态 = 墨色实心**：浅色 `--accent: #18181b`（文字 `#ffffff`），深色 `--accent: #ededed`（文字 `#0a0a0a`）。Vercel 式反色主按钮，不依赖彩色品牌色。
- **链接/焦点环 = 单一蓝**：浅色 `#2563eb`，深色 `#60a5fa`。焦点环 `0 0 0 3px` 低透明蓝。
- 删除 `--accent-soft` / `--accent-press` 装饰变量；hover 态用墨色 90% 或固定灰。

### 3.3 语义状态色（仅用于状态）

| 状态 | 浅色 | 深色 |
|---|---|---|
| 成功/已送达 | `#16a34a` | `#4ade80` |
| 失败 | `#dc2626` | `#f87171` |
| 警告/重试 | `#b45309` | `#fbbf24` |
| 信息/进行中 | `#2563eb` | `#60a5fa` |

去掉配套淡底变量（`--success-soft` 等），状态不再带彩色胶囊背景。

### 3.4 字体与密度

- **界面**：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。删除 `--font-display`（Spectral 衬线）全部引用。
- **等宽**：`ui-monospace, "SFMono-Regular", "Cascadia Code", Consolas, monospace`，用于 ID、URL、密钥前缀、代码、配置片段。
- **字号**：正文/表格 13px；辅助/表头 12px；区块标题 13px 600；页标题 18px 600；统计数字 24px + `font-variant-numeric: tabular-nums`。
- **控件高度**：按钮/输入框/选择器 32px（原 40px）；表格行高 44–48px（原 56px）。
- **圆角**：控件 6px；面板/模态 8px；删除 999px 药丸装饰（计数徽章除外）。
- **间距**：页面内容区 padding 32px → 24/32px；卡片内边距 16–20px。
- **动效**：仅保留 `transition: background/color/border-color .15s` 与 spinner；删除 modal-in 位移动画。`prefers-reduced-motion` 保留。

## 4. 布局与导航

- **只保留侧栏布局**：固定 232px，`--surface` 底 + 右侧 1px `--line`。删除 `data-layout` 机制、顶栏布局、`.top-nav` 全部代码。
- **删除 76px 顶栏**：页标题（18px）+ 页面主操作按钮直接放在内容区第一行（Linear/Vercel 式页头）。无独立 sticky bar、无 blur。
- **侧栏结构**：品牌区（图标 + RelayDock，无副标题）→ 导航 → 底部一行小图标按钮（明暗主题切换、刷新数据）。
- **导航项**：高 34px；激活态 = `--hover` 浅灰底 + `--ink` 文字；删除「强调色圆点 + 文本缩进」戏法。投递失败计数保留为朴素灰色小数字（非红色药丸）。
- **内容区**：`max-width: 1100px`，居中偏左（`margin: 0 auto` 保留）。
- **响应式沿用现有断点策略**：≤900px 侧栏抽屉化 + 汉堡按钮；≤680px 底部移动导航（5 项：概览/频道/投递/密钥/接入）+ 内容区紧凑化。只换皮，不改机制。
- **删除 `AppearanceControls`**：预设色块、hex 输入、布局切换全部移除；`appearance.ts` 只保留主题（`rd-theme`）读写；`rd-accent` / `rd-layout` 的 localStorage 键废弃，`index.html` 内联脚本同步精简（只留主题防闪烁）。
- 启动/boot 屏：单色 spinner，无彩色。

## 5. 信息架构：8 页 → 7 页

| 页面 | 变化 |
|---|---|
| 概览 | 结构不变，视觉重做（见 §6.1） |
| 频道 | 结构不变，视觉重做 |
| 路由 | 结构不变，视觉重做 |
| 投递 | 结构不变，视觉重做 |
| **密钥**（原 Agents + 凭据合并） | 上半：Agent API Key 表格（现 Agents 全部功能）；下半：两个实例级区块——管理令牌轮换、主密钥（DEK）轮换（现 Credentials 全部功能与诚实声明文案） |
| 接入 | hero 大色块改为普通面板（等宽 URL + 复制按钮）；客户端配置 tabs 与连接检查保留 |
| 系统 | 删除与接入页重复的「MCP 端点」面板；保留实例状态、渠道能力、安全边界 |

导航顺序：概览、频道、路由、投递、密钥、接入、系统。页标题改为单词式：「概览」「频道」「路由」「投递」「密钥」「接入」「系统」。**删除全部页面副标题**（`pageTitles` 的第二行），页面主操作按钮（如「创建密钥」「新建频道」）放在页头右侧。

## 6. 页面级要点

### 6.1 概览

- 统计条：四个统计项去掉图标芯片与 tone 色，纯排版——12px 灰标签 + 24px tabular-nums 数字。失败数 > 0 时数字用 `--danger` 红，否则与正常同色。
- 最近投递表：沿用表格规范（§7）。「来源」列去掉 `<code>` 胶囊，直接文字。
- 快速发送：面板不变，控件按新密度收紧；级别分段控件保留（`.segments` 换中性样式）。

### 6.2 密钥（合并页）

- 页头：标题「密钥」+ 右侧「创建密钥」主按钮。
- 第一区块：Agent 密钥表格（现有列：Agent/密钥前缀/权限/目的地/最近使用/状态/操作）。工具栏文案「鉴权用哈希，明文以加密形式存储」保留为表格上方一行 12px 灰字。
- 第二区块「管理令牌」、第三区块「主密钥（数据加密密钥）」：现 Credentials 的两个面板原样搬入，含自定义令牌开关、env 令牌仍有效的警告、DEK 轮换确认模态、新令牌一次性展示模态。
- 三个区块上下排列，统一 `.panel` 样式。

### 6.3 接入

- 删除 `.endpoint-hero` accent-soft 大色块：改为标准 `.panel`，区块头「MCP 端点」+ 等宽 URL + 复制图标按钮。
- 客户端 tabs 样式中性化：激活态 = 底部 2px `--ink` 线（非 accent 蓝）。
- 代码块：浅色模式用 `--surface-alt` 浅灰底 + `--ink` 文字（不再用深色块在浅色界面里制造反差）；深色模式用 `#0a0a0a` 底。等宽 12px。
- 「连接检查」「RELAYDOCK_API_KEY 提示」面板保留，换中性样式。

### 6.4 系统

- 删除「MCP 端点」面板（与接入页重复）。
- 实例状态 dl、渠道能力计数、安全边界列表保留，换中性样式。运行正常的 health 点保留（绿点 + 文字，符合状态点规范）。
- 「渠道能力」的 accent-soft 计数胶囊改为 `--hover` 灰底。

### 6.5 登录

- 居中窄卡（380px），白底 1px 边线 8px 圆角，无大投影。
- 删除 eyebrow 与衬线标题：品牌图标 + 「RelayDock」18px + 一句功能说明（「输入管理令牌进入控制台」）。
- 错误提示 `.inline-error` 保留，改中性红字样式。

## 7. 共享组件规范（`styles.css` + `ui.tsx`）

| 组件 | 规范 |
|---|---|
| `.panel` | `--surface` 底 + 1px `--line` + 8px 圆角；无阴影。区块头 `.section-head` 高度 52px，标题 13px/600；区块头的灰色说明文字一律删除，承载约束/安全信息的说明（如凭据页的 env 警告、DEK 说明、密钥存储说明）保留为区块内 12px 灰字 |
| 表格 | 表头 12px `--muted` 常规字重（无大写、无字间距）；td 13px `--ink-2`，标题列 `--ink`；行边框 `--line-soft`；hover `--surface-alt`；行高收紧 |
| 按钮 | 高 32px、6px 圆角、13px/560。primary = `--accent` 实底反色字；secondary = `--surface` 底 1px `--line`；danger = `--danger` 实底；ghost = 透明。hover 无 translateY 位移，仅色深变化 |
| 图标按钮 | 32px，`--muted` 图标，hover `--hover` 底 |
| 表单 | input/select 高 32px、6px 圆角、1px `--line`；焦点 = 蓝边 + 3px 低透明蓝环；label 13px `--ink-2` |
| 状态徽章 | **Badge 组件重写**：14px 圆点（语义色）+ 12px 文字（`--ink-2`，失败用 `--danger`）。删除 `badge-*` 彩色淡底类。sending/processing 保留 spinner |
| 状态点 `.state-dot` | 沿用并统一为新规范 |
| 权限/计数小标签 `.scope-pills` | 保留但改 1px `--line` 描边样式，无底色 |
| 模态 | 8px 圆角、单一 `--shadow-lg`、无入场位移动画；header 52px；底部操作栏 `--surface-alt` |
| Toast | `--surface` 底 + 1px `--line` + 左侧 3px 状态色条 + 8px 圆角 + 适中阴影 |
| 空状态 | 居中图标（无描边瓦片，直接 `--muted` 图标）+ 15px 标题 + 13px 灰字一句 + 主按钮；min-height 降到 220px |
| 开关 `.switch` | 保留结构，on 态用 `--ink`（非彩色） |
| 渠道图标 | `ProviderIcon` 的 `BRAND_HEX` 品牌色表保留（渠道官方色，与主题正交）；`--brand` 回退值改 `#a1a1aa` |
| 路由流节点 `.route-node` | 1px 描边小胶囊保留，序号方块改灰底 |
| 投递时间线 `.attempt` | 结构不变，圆点用语义色 |

## 8. 删除清单

- `appearance.ts`：`ACCENT_PRESETS`、`DEFAULT_ACCENT`、`AccentVars`、`parseHex`/`relativeLuminance`/`contrastRatio`/`pickAccentInk`/`deriveAccentVars`、`applyAccentToDOM`、`applyLayoutToDOM`、`setAccent`、`setLayout`、`Layout`/`AccentPreset` 类型。保留：`ThemeMode`、主题读写与 `cycleTheme`、`useAppearance`（收窄为只含 theme）。
- `components/AppearanceControls.tsx`：预设色块、hex 输入、布局切换全部删除；只留 `ThemeToggle`（可移入 `ui.tsx` 后整文件删除）。
- `index.html`：内联脚本只留 `rd-theme` 防闪烁；删 `rd-accent`/`rd-layout` 读取与颜色推导代码。
- `App.tsx`：`.top-nav`、`data-layout` 分支、76px 顶栏、`pageTitles` 副标题、`Credentials` 独立页（并入密钥页）。
- `styles.css`：`--font-display`、`--accent-soft`/`--accent-press`、`tone-*`、`stats-strip` 图标芯片样式、`.endpoint-hero`、`.eyebrow`、`modal-in` 动画、`backdrop-filter`、`.layout-toggle`/`.accent-swatches`/`.accent-hex` 等外观控件样式。
- 组件 JSX：所有 eyebrow、装饰性副标题、统计图标芯片、`pageTitles` 第二行。

> 注：`tests/appearance.test.ts` 目前覆盖被删的强调色/布局纯函数，本次同步重写该文件：只保留主题（`rd-theme` 读写、`cycleTheme`）相关测试。

## 9. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/web/styles.css` | 全量重写（工作量主体） |
| `src/web/appearance.ts` | 收窄为主题-only |
| `src/web/App.tsx` | 外壳重构：单布局、删顶栏、页头内联、7 页导航、密钥页合并 |
| `src/web/index.html` | 内联脚本精简 |
| `src/web/components/ui.tsx` | Badge 重写为状态点；按钮/模态/空状态换规范；吸收 ThemeToggle |
| `src/web/components/AppearanceControls.tsx` | 删除 |
| `src/web/components/Credentials.tsx` | 删除（内容迁入密钥页） |
| `src/web/components/Agents.tsx` | 改为「密钥」页：接入 Credentials 两个区块 |
| `src/web/components/Overview.tsx` | 统计条纯排版化 |
| `src/web/components/Integrations.tsx` | hero 改普通面板 |
| `src/web/components/SystemPage.tsx` | 删 MCP 端点面板 |
| `src/web/components/Login.tsx` | 简化 |
| `src/web/components/Channels.tsx` / `Routes.tsx` / `Deliveries.tsx` / `ChannelPicker.tsx` | JSX 基本不动，靠共享类换肤；个别装饰元素（图标芯片等）删除 |
| `src/web/components/ProviderIcon.tsx` | `--brand` 回退色改中性灰 |
| `tests/appearance.test.ts` | 重写：只保留主题读写/cycleTheme 测试 |

## 10. 不在范围内

- 不新增功能、不改数据流、不改轮询逻辑、不动服务端与共享类型。
- 不引入新依赖（无组件库、无网络字体、无 CSS 框架）。
- 不改渠道品牌色表。
- 移动端断点机制不改，只换视觉。

## 11. 验收标准

1. 浅色：灰白画布、白面板、墨色文字、1px 边线、无阴影卡片、无衬线字体、无 eyebrow、无彩色图标芯片、无装饰副标题。
2. 深色：近黑画布，同构令牌生效；明暗切换在侧栏底部，刷新后保持。
3. 主按钮为墨色实心；链接/焦点环为单一蓝；状态仅以小圆点+文字表达。
4. 侧栏唯一布局，无外观自定义入口；`localStorage` 只剩 `rd-theme`。
5. 导航 7 项；「密钥」页含 Agent 密钥表格 + 管理令牌 + 主密钥三个区块，原有功能（创建/查看/吊销/轮换/确认模态/一次性展示）全部可用。
6. 系统页无 MCP 端点面板；接入页无大色块 hero。
7. 所有 ID/URL/密钥/代码为等宽字体；统计数字 tabular-nums。
8. `npm run build:web` 通过；`npm run typecheck` 通过；`npm test` 不受影响的通过。
