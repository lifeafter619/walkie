# RelayDock 前端视觉重设计

- **日期：** 2026-08-14
- **状态：** 已确认（待实现）
- **范围：** `src/web/` 表现层。无后端改动、无 API 改动、无新依赖。
- **目标：** 去掉"通用 AI 仪表盘味儿"，换成温暖、可读、有编辑感的视觉语言；同时让主题色成为用户可配置项。

## 1. 背景与问题

当前前端（`src/web/styles.css` + `src/web/App.tsx` + 11 个组件）呈现强烈的"AI 生成仪表盘"特征：

- 千篇一律的绿色主题（`--green: #16745f`、深绿侧栏 `#14221f`），几乎所有 AI 生成的控制台都用这套。
- 无处不在的大写小标签眉题（`NOTIFICATION FABRIC`、`RELAYDOCK / ADMIN`、`STREAMABLE HTTP`），过度"专业感"反而显模板。
- 统计条上的彩色图标方块（绿/蓝/琥珀/红各一块），是最典型的仪表盘套路。
- 字号偏小拥挤（9–11px 居多），为了"紧凑专业"牺牲可读性。
- 焦点环、强调色、链接全部硬编码为绿色 `#5f9e8e` / `#16745f`，无法整体换肤。

## 2. 设计方向（已与用户确认）

经视觉对比（三方向：Ops Console / Warm Editorial / Technical Blueprint），用户选定 **Warm Editorial · 温暖留白**：

- 暖白画布、墨色文字、大间距、克制的强调色。
- 像可读的产品页，少"赛博感"。参考 Stripe / Plausible。
- **强调色由用户配置**（预设色块 + 自定义 hex），默认 Clay `#c2603f`。
- **外壳布局也可由用户配置**，默认 A（浅色侧边栏），可选 B（顶部导航）。

## 3. 设计令牌（Design Tokens）

整个外观由 CSS 自定义属性驱动。强调色**不**硬编码在任何地方——所有彩色元素引用 `--accent` / `--accent-ink` / `--accent-soft`，换一个变量即全站换肤。

### 3.1 亮色基底（固定，与强调色无关）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--app-bg` | `#faf7f2` | 画布（暖白） |
| `--surface` | `#ffffff` | 卡片/面板 |
| `--surface-side` | `#f5f1ea` | 侧栏（略深的暖白） |
| `--surface-alt` | `#f8f5f0` | 表格头/次级面 |
| `--hover` | `#f5f1ea` | 悬停底色 |
| `--ink` | `#2c2823` | 主文字（墨褐） |
| `--ink-2` | `#6b6353` | 次文字 |
| `--muted` | `#9a8f7d` | 弱化文字 |
| `--faint` | `#c7bda9` | 占位符 |
| `--line` | `#efe8dc` | 分隔线 |
| `--line-soft` | `#f3ede2` | 轻分隔线 |

### 3.2 强调色（用户可配置，默认 Clay）

| 令牌 | 默认值 | 用途 |
|---|---|---|
| `--accent` | `#c2603f` | 主按钮/链接/logo/焦点环/选中态 |
| `--accent-ink` | `#ffffff` | 强调色上的文字（自动对比计算） |
| `--accent-soft` | `#f7e7df` | 强调色淡底（标签/选中背景） |
| `--accent-press` | `#a8522f` | 主按钮按下态 |

**对比度自适应：** 设 `--accent` 后，根据相对亮度自动选 `--accent-ink`（浅色强调用墨色文字，深色强调用白字），确保按钮、logo 等始终可读。

### 3.3 语义色（固定，承载含义不承载品牌）

去掉旧的彩色统计图标方块；统计图标改用单一中性色。语义色仍保留，但全部为低饱和：

- 成功/已送达 `#5a7a52`，淡底 `#eef2e8`
- 失败 `#b8552f`，淡底 `#f7e9e2`（暖红，非刺眼纯红）
- 警告 `#b8862f`，淡底 `#f3ead4`
- 信息 `#5b7a9a`，淡底 `#e6ecf2`

### 3.4 暗色模式：暖暗

不是中性灰暗，而是暖调近黑：

- `--app-bg: #1a1714`、`--surface: #242020`、`--surface-side: #201c19`、`--ink: #ede7df`
- 强调色 picker 的色块与 hex 在暗色下同样生效。
- 代码块底色 `#241f1c`（暖暗），文字 `#d5c9bd`。

### 3.5 预设强调色（picker 中展示的色块）

`Clay #c2603f`（默认）、`Ochre #b8862f`、`Forest #3d6b4f`、`Ink #2c2823`、`Plum #7a5c8f`、`Slate #5b7a9a`。用户可点选其一，或用 hex 输入框 / 系统取色器自定义。

## 4. 字体与密度

### 4.1 字体栈

- **界面文字：** `Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`（沿用）。
- **标题与统计数值：** 衬线显示字体 `Spectral, "Source Serif Pro", Georgia, serif`，用于页面 H1、统计大数字、登录标题（已与用户确认）。正文/标签仍用无衬线。**仅系统安全栈，无网络依赖**，回退到 Georgia。
- **代码：** `"Cascadia Code", "SFMono-Regular", Consolas, monospace`（沿用）。

### 4.2 字号与间距

- 正文 13–14px（原 12）；标签 12px（原 10）；页面 H1 22px（原 19）；统计数值 26px（原 21）。
- **移除所有 `text-transform: uppercase` 眉题**（`NOTIFICATION FABRIC`、`RELAYDOCK / ADMIN`、`STREAMABLE HTTP` 等）——这是 AI 模板感的核心来源。改用普通小号文字或直接删除。
- 表单间距 16px（原 13）；面板内边距 22px；段落节奏整体放松。
- 圆角统一上调：卡片 12px、按钮 9px、输入 8px、药丸 999px（替换原来零碎的 4–7px）。

## 5. 外壳布局

### 5.1 默认布局 A：浅色侧边栏

- 侧栏为暖白 `--surface-side: #f5f1ea`，仅以 1px 发丝线与主区分隔。**亮色模式下无深色侧栏。**
- 品牌标记为小号墨色方块（非绿色）。
- 导航选中态 = 白色"浮起"卡片 + 柔和阴影 + 一个小强调点，**而非**左侧色条或填充色块。
- 侧栏底部放置**外观设置区**：主题（系统/亮/暗，沿用）、强调色 picker、布局切换（侧栏/顶部）。

### 5.2 布局 B：顶部导航（用户可选）

- 无侧栏，导航横向排在顶部。内容区铺满全宽。
- 7 个导航项桌面端够排；窄屏折成汉堡。
- 强调色 picker 收成顶栏右侧一个小药丸。

### 5.3 窄屏

- 桌面用所选布局；≤900px 侧栏抽屉化、顶部栏出现汉堡按钮；≤680px 出现底部移动导航（沿用现有模式）。

## 6. 外观偏好系统

**机制：** 新增 `<AccentProvider>` / `useAppearance` hook：

- 读 `localStorage`：`rd-theme`（已有）、`rd-accent`（新）、`rd-layout`（新，`'sidebar' | 'top'`）。
- 写 `--accent` / `--accent-ink` / `--accent-soft` / `--accent-press` 到 `:root`（或 `data-theme` 容器），换色即时生效。
- 布局偏好决定 `App.tsx` 渲染侧栏外壳还是顶部外壳。
- 现有 `ThemeToggle` 扩展为**外观控件**（主题 + 强调色 + 布局），位于侧栏底部 / 顶栏右侧。

**持久化：** 全部本地 `localStorage`，不涉及服务端，不需要登录态同步。

## 7. 组件重样式

不为 11 个文件逐个临摹，而是**在共享 class 层**重写，各页继承：

| 组件/类 | 改动 |
|---|---|
| 卡片 `.panel` | 白底 + 暖边 + 12px 圆角 + 极淡阴影；分区头去掉粗下边线 |
| 表格 `th/td` | 去掉大写字间距表头；表头 11px 常规弱化；行高 56px；悬停暖底 |
| 徽章 `.badge` | 药丸 999px，语义色淡底 + 同色字；旋转 loader 保留 |
| 按钮 `.button` | 主按钮 = `--accent` 实底 + `--accent-ink`；次按钮 = 白底暖边；ghost 透明。min-height 40px，9px 圆角 |
| 表单 `input/select/textarea` | 40px 高，8px 圆角，焦点环用 `--accent` 低透明度（替换硬编码绿 `#5f9e8e`） |
| 分段控件 `.segments` | 暖色"下沉轨道"处理 |
| 模态 `.modal` | 暖卡片 + 16px 圆角 + 柔阴影；底部操作栏融合而非硬线 |
| 提示 `.toast` | 由深色块 `#172520` 改为暖面卡片 + 左侧按类型强调色条 |
| 空状态 `.empty` | 更大更静，墨色描边图标瓦 |
| 代码块 `.integration-code` / `.endpoint-sample pre` | 暖暗底 `#241f1c` + 暖文字，匹配调色板 |

### 7.1 需显式处理的特殊表面

- **渠道选择网格** `.picker-tile`：瓦片改暖卡片，选中/聚焦态用 `--accent`。
- **路由流节点** `.route-node` 与**投递尝试时间线** `.attempt`：暖卡片 + 暖分隔，时间线圆点用语义色而非硬编码绿 `#63a692`。
- **接入页 endpoint hero** `.endpoint-hero`：当前是硬编码深绿块 `#153029`——改为 `--accent` 淡底的暖卡片或干净描边卡片。
- **登录页** `.login-shell` / `.login-panel`：去掉深绿背景，改暖白居中卡片；标题用衬线；移除 `RELAYDOCK / ADMIN` 大写眉题。
- **品牌标记** `.brand-mark`：由绿底 `#207865` 改为 `--accent` 实底或墨色。

### 7.2 ProviderIcon 品牌色

`ProviderIcon.tsx` 的 `BRAND_HEX` 品牌色表**保留不动**——这些是渠道官方品牌色，用于渠道图标触发器边框装饰，与强调色体系正交。仅其 `--brand` 回退值 `'5f9e8e'` 改为中性灰 `'6b6353'`。

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/web/styles.css` | **全量重写令牌与组件类**（工作量主体） |
| `src/web/App.tsx` | 外壳重构：浅色侧栏、布局切换、picker 挂载点；移除大写眉题 |
| `src/web/components/ui.tsx` | `ThemeToggle` → 外观控件（主题+强调色+布局）；新增 `useAppearance` / `AccentProvider` |
| `src/web/components/Login.tsx` | 暖白登录、衬线标题、去眉题 |
| `src/web/components/Overview.tsx` | 统计图标去彩色化、间距 |
| `src/web/components/Channels.tsx` | 去硬编码色、暖卡片 |
| `src/web/components/ChannelPicker.tsx` | 瓦片暖化、选中态用 `--accent` |
| `src/web/components/Routes.tsx` | 流节点/时间线暖化 |
| `src/web/components/Deliveries.tsx` | 表格/详情暖化 |
| `src/web/components/Integrations.tsx` | endpoint hero 改暖卡片、去大写眉题 |
| `src/web/components/SystemPage.tsx` | 系统网格暖化 |
| `src/web/components/Agents.tsx` | 沿用共享类，轻量调整 |
| `src/web/components/ProviderIcon.tsx` | `--brand` 回退色改中性灰 |

## 9. 不在范围内

- 不新增功能、不改导航项、不改数据流、不动服务端。
- 不引入新依赖（无新 npm 包；字体用系统安全栈）。
- 不改 API、不改数据库、不改共享类型。
- 不动 `src/server/`、`src/worker/`、`src/shared/`（除可能的无关既有改动）。

## 10. 验收标准

1. 亮色模式：暖白画布、墨色文字、无深色侧栏、无大写眉题、无彩色统计图标方块。
2. 强调色：侧栏底部/顶栏可切换预设色与自定义 hex，换色后按钮/链接/焦点环/徽章/logo 即时统一变色，刷新后保持。
3. 布局：可在设置中切换侧栏/顶部导航，刷新后保持。
4. 暗色模式：暖调近黑，强调色 picker 同样可用。
5. 字号整体更松更可读；圆角统一；所有焦点环由 `--accent` 派生。
6. 登录页、接入页 hero、路由时间线、渠道选择网格、代码块均按 §7 暖化。
7. `npm run build:web`（vite build）通过；`npm run typecheck` 通过；现有测试不受影响。
