const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const page = (body: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>RelayDock</title>
<style>
:root{color-scheme:light dark;
  --bg:#f5f7f6;--surface:#ffffff;--line:#e2e7e4;--ink:#1c2523;--muted:#6d7a75;
  --accent:#16745f;--accent-ink:#ffffff;--danger:#b44138;--soft:#eef3f1}
:root[data-theme="dark"]{
  --bg:#0f1613;--surface:#171f1c;--line:#28332e;--ink:#e5ece8;--muted:#8fa199;
  --accent:#3aa98a;--accent-ink:#08130f;--danger:#e07b6f;--soft:#1e2823}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0f1613;--surface:#171f1c;--line:#28332e;--ink:#e5ece8;--muted:#8fa199;
  --accent:#3aa98a;--accent-ink:#08130f;--danger:#e07b6f;--soft:#1e2823}}
*{box-sizing:border-box}
body{margin:0;padding:20px 16px;min-height:100vh;display:flex;justify-content:center;
  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  background:var(--bg);color:var(--ink)}
main{width:100%;max-width:520px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
h1{font-size:15px;font-weight:650;margin:0;color:var(--muted)}
#mode{border:1px solid var(--line);background:var(--surface);color:var(--muted);
  width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:15px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px}
.q{font-size:16px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0 0 18px}
.options{display:grid;gap:8px;margin-bottom:14px}
.options button{width:100%;min-height:46px;padding:10px 14px;font-size:15px;text-align:left;cursor:pointer;
  border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink)}
.options button:hover{border-color:var(--accent);color:var(--accent)}
textarea{width:100%;min-height:88px;padding:12px;font:inherit;font-size:15px;resize:vertical;
  border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);outline:none}
textarea:focus{border-color:var(--accent)}
.send{width:100%;margin-top:10px;min-height:46px;font-size:15px;font-weight:650;cursor:pointer;
  border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink)}
.divider{display:flex;align-items:center;gap:10px;margin:4px 0 12px;color:var(--muted);font-size:12px}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--line)}
.note{margin-top:14px;color:var(--muted);font-size:12px;text-align:center}
.state{text-align:center;padding:36px 20px}
.state .icon{font-size:34px}
.state h2{font-size:17px;margin:12px 0 6px}
.state p{color:var(--muted);font-size:13px;margin:0}
</style>
<script>try{var t=localStorage.rdTheme;if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head><body><main>
<header><h1>RelayDock</h1><button id="mode" type="button" aria-label="切换明暗" onclick="
  var d=document.documentElement,dark=d.dataset.theme?d.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
  d.dataset.theme=dark?'light':'dark';try{localStorage.rdTheme=d.dataset.theme}catch(e){}">◐</button></header>
${body}
</main></body></html>`;

/** 回复表单页：选项按钮直接提交，或自由输入；纯 HTML 提交，无 JS 依赖 */
export function renderReplyForm(question: string, options: string[] = []): string {
  const optionButtons = options.length
    ? `<div class="options">${options.map((option) => `<button type="submit" name="reply" value="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}</div><div class="divider">或自由输入</div>`
    : '';
  return page(`<div class="card"><p class="q">${escapeHtml(question)}</p>
<form method="post">${optionButtons}
<textarea name="replyText" placeholder="输入回复…"${options.length ? '' : ' required'}></textarea>
<button class="send" type="submit">发送回复</button>
</form></div>
<p class="note">Agent 正在等待，此链接一次有效。</p>`);
}

export function renderReplyResult(kind: 'done' | 'gone'): string {
  return kind === 'done'
    ? page('<div class="card state"><div class="icon">✅</div><h2>回复已送达</h2><p>Agent 将继续执行，可以关闭此页面。</p></div>')
    : page('<div class="card state"><div class="icon">⌛</div><h2>链接已失效</h2><p>该提问已被回复或已过期。</p></div>');
}
