import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { VERSION } from '../shared/version.js';
import { PLATFORM_PROFILES } from '../shared/platform.js';
import type { DeploymentPlatform } from '../shared/types.js';

const execFileAsync = promisify(execFile);

/** 版本检查与应用内更新。仅 Node 运行时支持真正应用更新；Workers 只能检查。 */

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  /** 更新说明（release body 摘要或 tag 名） */
  releaseNotes?: string;
  releaseUrl?: string;
  /** 当前运行时是否支持应用内应用 */
  canApply: boolean;
  applyHint?: string;
}

export interface UpdateApplyResult {
  success: boolean;
  message: string;
  /** 是否需要重启才能生效 */
  needsRestart: boolean;
}

const CURRENT_VERSION = VERSION;

/**
 * 检查更新：从 GitHub releases API 获取最新版本。
 * @param repo GitHub 仓库（owner/name），通过环境变量 UPDATE_REPO 配置，默认 lifeafter619/walkie
 */
export async function checkUpdate(repo?: string, platform: DeploymentPlatform = 'node'): Promise<UpdateCheckResult> {
  const repoName = repo ?? process.env.UPDATE_REPO ?? 'lifeafter619/walkie';
  const apiUrl = `https://api.github.com/repos/${repoName}/releases/latest`;
  try {
    const response = await fetch(apiUrl, {
      headers: { 'user-agent': 'walkie-update-checker', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      return { currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, hasUpdate: false, canApply: false, applyHint: `无法获取版本信息（HTTP ${response.status}）。请确认 UPDATE_REPO 环境变量是否正确指向 GitHub 仓库。` };
    }
    const release = await response.json() as { tag_name: string; html_url: string; body?: string };
    const latestVersion = release.tag_name.replace(/^v/, '');
    // 仅在 tag 是合法语义化版本时才比较；非法格式（如 "latest"、日期）不视为更新
    const hasUpdate = isSemver(latestVersion) && isSemver(CURRENT_VERSION) && compareVersions(latestVersion, CURRENT_VERSION) > 0;
    const canApply = canApplyUpdate(platform);
    return {
      currentVersion: CURRENT_VERSION,
      latestVersion,
      hasUpdate,
      releaseNotes: release.body?.slice(0, 500),
      releaseUrl: release.html_url,
      canApply,
      applyHint: canApply ? undefined : PLATFORM_PROFILES[platform].updateHint
    };
  } catch (error) {
    return { currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, hasUpdate: false, canApply: false, applyHint: `检查更新失败：${error instanceof Error ? error.message : '网络错误'}` };
  }
}

/**
 * 应用更新：在 Node 独立部署（git clone）下执行 git pull + 重新构建 + 重启。
 * Docker 与 Workers 不支持应用内更新。
 */
export async function applyUpdate(platform: DeploymentPlatform = 'node'): Promise<UpdateApplyResult> {
  if (!canApplyUpdate(platform)) {
    return { success: false, message: PLATFORM_PROFILES[platform].updateHint, needsRestart: false };
  }

  const cwd = process.cwd();
  if (!existsSync(path.join(cwd, '.git'))) {
    return { success: false, message: '当前目录不是 git 仓库，无法自动更新。请手动 git pull 后重新构建。', needsRestart: false };
  }

  try {
    // 拉取最新代码
    const { stdout: pullOutput } = await execFileAsync('git', ['pull', '--ff-only'], { cwd, timeout: 30_000 });
    if (pullOutput.includes('Already up to date')) {
      return { success: true, message: '代码已是最新，无需更新。', needsRestart: false };
    }

    // 重新安装依赖并构建。--include=dev 确保 vite/tsc 等构建工具到位，
    // 否则在 NODE_ENV=production 下 npm ci 会跳过 devDependencies 导致构建失败。
    // Windows 上 npm 是 npm.cmd，必须经 shell 才能 spawn（Node 已移除隐式 .cmd 解析）；参数全为常量，无注入面
    const shell = process.platform === 'win32';
    await execFileAsync('npm', ['ci', '--include=dev'], { cwd, timeout: 180_000, shell });
    await execFileAsync('npm', ['run', 'build:web'], { cwd, timeout: 120_000, shell });
    await execFileAsync('npm', ['run', 'build:server'], { cwd, timeout: 120_000, shell });

    return { success: true, message: '更新已下载并构建完成。服务器即将自动重启以应用新版本。', needsRestart: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `应用更新失败：${message}。请检查日志或手动 git pull && npm run build。`, needsRestart: false };
  }
}

/** 当前运行时是否支持应用内更新 */
function canApplyUpdate(platform: DeploymentPlatform): boolean {
  return platform === 'node' && existsSync(path.join(process.cwd(), '.git'));
}

/** 语义化版本比较：>0 表示 a 更新，<0 表示 b 更新，=0 相同 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 校验是否为合法语义化版本（X.Y.Z，仅数字），拒绝 "latest"、日期、预发布标签等 */
function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

export { CURRENT_VERSION };
