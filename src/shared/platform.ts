import type { DeploymentPlatform, ProviderId } from './types.js';

export interface CompatibilityEndpoint {
  id: string;
  name: string;
  method: string;
  path: string;
  auth: string;
  description: string;
  docsUrl: string;
  provider?: ProviderId;
}

export interface PlatformProfile {
  label: string;
  freeTier?: string;
  docsUrl?: string;
  limits: Array<{ label: string; value: string; note?: string }>;
  updateHint: string;
  usageNote: string;
}

export const COMPATIBILITY_ENDPOINTS: CompatibilityEndpoint[] = [
  { id: 'mcp', name: 'MCP', method: 'POST', path: '/mcp', auth: 'Bearer Agent Key', description: 'Streamable HTTP，供 Codex、Claude Code、Cursor 等 Agent 使用。', docsUrl: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http' },
  { id: 'rest', name: 'Walkie REST', method: 'POST', path: '/api/v1/notify', auth: 'Bearer Agent Key', description: '原生通知 API，支持目的地、严重级别、回调与幂等键。', docsUrl: '/#integrations', provider: 'walkie' },
  { id: 'serverchan', name: 'Server酱', method: 'GET / POST', path: '/send/<AgentKey>.send', auth: 'URL 中的 Agent Key', description: '兼容 title、desp、tags、short 与 destination 参数。', docsUrl: 'https://sct.ftqq.com/sendkey', provider: 'serverchan' },
  { id: 'bark', name: 'Bark', method: 'GET / POST', path: '/push', auth: 'Bark Device Key / Agent Key', description: '兼容 V2 JSON、旧式路径、批量推送和常用 Bark 参数。', docsUrl: 'https://github.com/Finb/bark-server/blob/master/docs/API_V2.md', provider: 'bark' },
  { id: 'gotify', name: 'Gotify', method: 'POST', path: '/message?token=<AgentKey>', auth: 'Agent Key', description: '兼容 title、message、priority 和 extras 的消息入口。', docsUrl: 'https://gotify.net/docs/pushmsg', provider: 'gotify' },
  { id: 'pushplus', name: 'PushPlus', method: 'GET / POST', path: '/send', auth: 'token=Agent Key', description: '兼容 token、title、content、template 和 topic 参数。', docsUrl: 'https://www.pushplus.plus/doc/guide/api.html', provider: 'pushplus' },
  { id: 'ntfy', name: 'ntfy', method: 'POST', path: '/ntfy/<destination>', auth: 'Bearer Agent Key', description: '将服务地址设为本站 /ntfy，支持文本正文与 Title、Priority、Tags、Click 头。', docsUrl: 'https://docs.ntfy.sh/publish/', provider: 'ntfy' }
];

export const PLATFORM_PROFILES: Record<DeploymentPlatform, PlatformProfile> = {
  'cloudflare-workers': {
    label: 'Cloudflare Workers', freeTier: 'Workers Free', docsUrl: 'https://developers.cloudflare.com/workers/platform/limits/',
    limits: [
      { label: 'Worker 请求', value: '100,000 / 天', note: '00:00 UTC 重置' },
      { label: 'CPU', value: '10 ms / 请求' },
      { label: 'Durable Object 请求', value: '100,000 / 天' },
      { label: 'DO 计算时长', value: '13,000 GB-s / 天' },
      { label: 'DO SQLite', value: '读取 5M 行/天，写入 100K 行/天', note: '账户总计 5 GB；免费版单对象上限 1 GB' }
    ],
    updateHint: 'Cloudflare Workers 不能应用内更新；在本地拉取新版本后运行 npm run deploy:cf。',
    usageNote: '配置 Account Analytics:Read Token 后自动读取 Worker、Durable Objects 与 SQLite 存储指标。Cloudflare 暂未提供 DO SQLite 账户级行读写聚合 API，因此行读写额度仅展示官方上限，不伪造实时值。'
  },
  vercel: {
    label: 'Vercel Functions', freeTier: 'Hobby（Fluid Compute）', docsUrl: 'https://vercel.com/docs/plans/hobby',
    limits: [
      { label: '函数调用', value: '1,000,000 / 月' },
      { label: 'Active CPU', value: '4 CPU 小时 / 月' },
      { label: 'Provisioned Memory', value: '360 GB 小时 / 月' },
      { label: 'Edge 请求', value: '1,000,000 / 月' },
      { label: '数据传输', value: 'Fast 100 GB / 月，Origin 10 GB / 月', note: 'Hobby 公平使用指引' },
      { label: 'Cron', value: '每天最多一次', note: '触发时间精度 ±59 分钟' },
      { label: '部署', value: '100 / 天' }
    ],
    updateHint: 'Vercel 不能应用内更新；更新 Git 仓库后由 Vercel 重新构建部署。',
    usageNote: '配置 Vercel Access Token 后自动显示 FOCUS 返回的全部当前月指标；可识别的 Hobby 指标自动匹配免费额度。Turso 账户用量需要单独的 Turso Platform API Token，Vercel Token 无法读取。'
  },
  docker: {
    label: 'Docker', limits: [],
    updateHint: 'Docker 不能应用内替换镜像；拉取或构建新镜像后执行 docker compose up -d --build。',
    usageNote: 'Docker 没有统一免费额度；资源限制由宿主机、镜像平台和上游通知服务决定。'
  },
  node: {
    label: 'Node.js', limits: [],
    updateHint: 'Git 源码部署可在工作区干净且可快进时应用内更新；其他安装方式请手动重新部署。',
    usageNote: 'Node.js 没有统一平台额度；下方软限制用于控制通知量。'
  }
};
