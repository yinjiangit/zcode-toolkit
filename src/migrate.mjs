/**
 * migrate.mjs —— 旧补丁清退 runbook 实现（方案 §1.3 全流程 + §1.2 vendor 纪律 + 安全门控）。
 *
 * 【安全边界——硬性契约，违反即缺陷】
 *   - 对 ZCode 安装目录（resources/）的一切访问在 checkMigrate 中只读；
 *   - 任何破坏性动作（revert、垃圾清退、WANT_FILE 删除、看护进程终止）只存在于 runMigrate，
 *     且必须 opts.confirm === true 才执行——否则先于任何变更抛 MigrateGateError；
 *   - 本仓库工作流内绝不执行 --confirm（评审/CI/测试一律 checkMigrate + fixture 路径；
 *     测试对 fixture 路径传 confirm:true 验证门控与备份，绝不触真实安装目录）；
 *   - py 子进程只经 node:child_process 调用 vendor 副本 legacy/zcode_patcher.py（连同其
 *     legacy/_console.py 依赖，§1.2 vendor 纪律），显式枚举 6 个 asar 旗标：
 *     --usage-chart --model-width --tps-footer --thought-slider --model-puller --enhance-prompt
 *     （**禁用 --all**：其 reasoning_config 还原分支在存在 provider_config.json.reasoning-bak
 *     时会复制覆盖现行配置，旧现场 zcode_patcher.py:2640-2654——§1.3 步骤 2 双保险①）；
 *     另以无参数形态补一次内核还原检查（zcode.cjs ≤3.11 档位透传，§1.3 尾注）。
 *
 * §1.3 runbook 步骤映射（唯一顺序：先 migrate、后升级插件）：
 *   步骤 1 前置检查 A（进程）：ZCode 完全退出（tasklist 无 ZCode.exe）；python / apply_after_exit /
 *     autopilot 看护进程检出并（confirm 后）终止；WANT_FILE 队列删除
 *     （旧定义 skills/zcode-tokenspeed/scripts/_watchdog.want，apply_after_exit.py:31；
 *     扫描对象=已安装旧插件缓存目录与仓库 legacy 布局，路径全部可注入）。
 *   步骤 2 前置检查 B（配置保护）：备份 <v2Dir>/provider_config.json 到
 *     <stateDir>/backups/provider_config.pre-migrate.<时间戳>.json（备份在 state 根，不写 v2）；
 *     若存在 provider_config.json.reasoning-bak → diff 它与现行文件，差异非空时要求用户显式确认
 *     （report.reasoningBakDiff 非空 + gate 拒绝，直到 opts.ackReasoningBak === true）。
 *   步骤 3 预演：py legacy/zcode_patcher.py <六旗标> --check 与 --revert --dry-run，
 *     输出清单核对（哪些旗标「已打/未打/将还原」）；py 不可用 → 标记 fallbackReinstall 路径（步骤 7）。
 *   步骤 4 还原（confirm 后）：按选定旗标集执行 revert。只有旧 patcher 同时掌握 .bak 链与
 *     patch.json 内 original_b64 的完整逆序（链为首次建立序、非静态序——评审意见 #11，禁止手工挑 .bak 覆盖）。
 *   步骤 5 校验：app.asar sha256 == 1d9d350217a18b35f64e55066d90f44fc7db2e330fead6bb0745df2747ea3500
 *     （链头真原始，3.15.2 专属；客户端版本 ≠ 3.15.2 → 本校验目标失效，直接报告走步骤 7）。
 *   步骤 6 清退垃圾（confirm 后）：精确清单删除（plannedCleanupArtifacts()），逐项列出、
 *     与旧 patcher prune_artifacts collect 清单（:2807-2819）交叉核对防手写漂移；不用通配递归（C13）。
 *   步骤 7 兜底（永远可用，只报告不执行）：ZCode 重装/升级一次——resources\app.asar 在安装清单内全量覆盖。
 *   步骤 8 v2 根残留排查：provider_config.json.pre-fix.*.bak / .reasoning-bak / .puller-bak 等
 *     **列出路径与时间戳，绝不自动删除**（评审意见 #12）。
 *   步骤 9 切换指引：全绿 → 卸载旧插件 → 安装/升级新插件 → 首启 doctor 全绿。
 *
 * 路径注入（测试一律 fixture）：opts.resourcesDir / opts.v2Dir / opts.stateDir /
 *   opts.pluginsCacheDir / opts.legacyPatcherPath / opts.repoRoot / opts.pythonCmd
 *   > 对应环境变量（ZTK_RESOURCES_DIR / ZTK_V2_DIR / ZTK_STATE_DIR / ZTK_PLUGINS_CACHE_DIR /
 *     ZTK_LEGACY_PATCHER / PYTHON_BIN）> 默认真实路径。
 * 可测试性注入：opts.zcodeRunning / opts.listProcesses（无参 async，默认 tasklist / PowerShell
 *   只读采集）；opts.patcherEnv / opts.patcherCwd（py 子进程 env/cwd——测试以 cwd=stub 目录
 *   让旧 patcher 内置的 tasklist 预检读到哑 tasklist.exe，见 runCmd 注释）。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ============================================================================
 * 常量（契约锚点，测试直接断言）
 * ========================================================================== */

/**
 * §1.3 步骤 2 双保险①：迁移还原只显式枚举这 6 个 asar 级旗标。
 * **绝不包含 reasoning_config、绝不拼 --all**——旧 patcher 的 ALL_PATCH_FLAGS
 * （zcode_patcher.py:137-145）含 reasoning_config，其 revert 分支在存在
 * provider_config.json.reasoning-bak 时会 copyfile 覆盖现行配置（:2640-2654）。
 */
export const ASAR_PATCH_FLAGS = Object.freeze([
  '--usage-chart',
  '--model-width',
  '--tps-footer',
  '--thought-slider',
  '--model-puller',
  '--enhance-prompt',
]);

/** §1.3 步骤 5：链头真原始 app.asar 指纹（app.asar.tps.bak.meta.json 实测，3.15.2 专属）。 */
export const EXPECTED_PRISTINE_SHA256 =
  '1d9d350217a18b35f64e55066d90f44fc7db2e330fead6bb0745df2747ea3500';

/** 该指纹仅对客户端 3.15.2 有效；其它版本（含读不出）校验目标失效 → 步骤 7 重装兜底。 */
export const SHA256_APPLIES_TO_VERSION = '3.15.2';

/**
 * zcode_patcher.py `prune_artifacts()` 的 collect 清单**硬编码镜像**（来源行号即注释）。
 * 旧文件改动时必须两处同步——test/migrate.test.mjs 以此常量与 plannedCleanupArtifacts()
 * 做集合交叉核对（防手写漂移，§1.3 步骤 6）。
 * 模式语义与 pathlib.Path.glob 一致：`*` 不跨目录分隔符。{asar} 为 app.asar 占位。
 */
export const PRUNE_ARTIFACTS_COLLECT = Object.freeze({
  // :2807（默认档，每个 asar 所在目录）
  asarFolderDefault: Object.freeze(['{asar}*.stale-*', '{asar}*.tps-tmp', '{asar}.*.tmp']),
  // :2809-2810（--deep：连当前备份与 sidecar 一起清——迁移时还原已完成，等价采纳）
  asarFolderDeep: Object.freeze(['{asar}*.bak', '{asar}*.bak.meta.json', '{asar}*-patch.json']),
  // :2812（内核备份，resources/glm/）
  glmDefault: Object.freeze(['zcode.cjs.bak', 'zcode.cjs.bak.meta.json']),
  // :2814（--deep 的 glm 归档）
  glmDeep: Object.freeze(['zcode.cjs.bak.stale-*']),
  // :2818-2819（--deep 的 v2 配置备份——**迁移不采纳进删除清单**：§1.3 步骤 8 只列出
  // 不自动删，评审意见 #12；此处保留仅为交叉核对完整性）
  v2Deep: Object.freeze([
    'provider_config.json.reasoning-bak',
    'config.json.puller-bak',
    'provider_config.json.puller-bak',
    'provider_config.json.tmp',
  ]),
});

/**
 * 门控错误：runMigrate 未收到 opts.confirm === true（或 reasoning-bak 差异未获显式确认）时抛出，
 * 先于任何文件系统/进程变更——这是破坏性动作的唯一闸门。
 * 契约：constructor(message, pending) —— pending: string[] 列出待用户确认的事项。
 */
export class MigrateGateError extends Error {
  /**
   * @param {string} message
   * @param {string[]} pending - 待确认事项清单（UI 据此逐条展示）。
   */
  constructor(message, pending = []) {
    super(message);
    this.name = 'MigrateGateError';
    this.pending = pending;
  }
}

/* ============================================================================
 * 内部工具
 * ========================================================================== */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 旧 patcher 六旗标各自输出小节的标题（main() steps 表 zcode_patcher.py:3013-3034）。 */
const SECTION_FLAG = new Map([
  ['用量页去截断补丁', '--usage-chart'],
  ['模型弹窗加宽补丁', '--model-width'],
  ['TPS 统计栏注入', '--tps-footer'],
  ['思考强度滑条注入', '--thought-slider'],
  ['模型拉取按钮注入', '--model-puller'],
  ['增强提示词注入', '--enhance-prompt'],
]);

/** §1.3 步骤 1：看护进程特征（apply_after_exit.py / autopilot.py / zcode_patcher 直跑 / 队列文件）。 */
const WATCHDOG_RE = /apply_after_exit|autopilot|zcode_patcher|_watchdog/i;

/** v2 根残留模式（§1.3 步骤 8：列出绝不删；pre-fix 模式为本会话 ls 实测命名）。 */
const V2_RESIDUE_PATTERNS = [
  'provider_config.json.pre-fix*.bak',
  'provider_config.json.reasoning-bak',
  'provider_config.json.puller-bak',
  'config.json.puller-bak',
  'provider_config.json.tmp',
];

/** glob(`*` 不跨分隔符) → RegExp；migrate 与测试共用（导出仅为测试交叉核对，勿作他用）。 */
export function globToRegExp(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*/g, '[^/\\\\]*') + '$');
}

/** @returns {boolean} name 是否命中 glob 模式。 */
export function matchesGlob(pattern, name) {
  return globToRegExp(pattern).test(name);
}

/** 本地时间戳 YYYYMMDD-HHmmss（备份文件名用）。 */
function timestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 路径注入解析：opts（含 runMigrate 的 opts.paths 嵌套形态）> 环境变量 > 默认真实路径。
 * @private
 */
function resolvePaths(opts = {}) {
  const o = { ...opts, ...(opts.paths || {}) };
  const env = opts.env || process.env;
  const home = env.USERPROFILE || os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return {
    env,
    resourcesDir:
      o.resourcesDir || env.ZTK_RESOURCES_DIR ||
      path.join(localAppData, 'Programs', 'ZCode', 'resources'),
    v2Dir: o.v2Dir || env.ZTK_V2_DIR || path.join(home, '.zcode', 'v2'),
    stateDir: o.stateDir || env.ZTK_STATE_DIR || path.join(home, '.zcode', 'zcode-toolkit'),
    // 默认值含 cache 段——与 doctor.mjs defaultPaths() 对齐（真实布局 ~/.zcode/cli/plugins/cache/
    // <marketplace>/<plugin>/<version>/…，实测 ls 本机缓存；少 cache 段则 WANT_FILE 扫描永不命中）。
    pluginsCacheDir:
      o.pluginsCacheDir || env.ZTK_PLUGINS_CACHE_DIR || path.join(home, '.zcode', 'cli', 'plugins', 'cache'),
    legacyPatcherPath:
      o.legacyPatcherPath || env.ZTK_LEGACY_PATCHER || path.join(REPO_ROOT, 'legacy', 'zcode_patcher.py'),
    repoRoot: o.repoRoot || REPO_ROOT,
  };
}

/** 只读文件读取（不存在/读失败 → null）。 */
function readTextOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 逐行 diff 摘要（§1.3 步骤 2 双保险②：reasoning-bak 与现行配置差异，最多 maxEntries 条）。 */
function diffLines(aText, bText, maxEntries = 20) {
  const a = (aText ?? '').split(/\r?\n/);
  const b = (bText ?? '').split(/\r?\n/);
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < maxEntries; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) continue;
    if (i < a.length) out.push(`-L${i + 1}: ${av}`);
    if (i < b.length) out.push(`+L${i + 1}: ${bv}`);
  }
  if (n > 0 && out.length >= maxEntries) out.push(`…（差异超 ${maxEntries} 条，已截断；共 ${n} 行对齐）`);
  return out;
}

/* ---------------------------- 子进程执行（node:child_process） ---------------------------- */

/**
 * 执行命令（cmdStr 按空白切分为 argv；PYTHON_BIN 带空格路径时用 opts.pythonCmd 数组形态规避）。
 * UTF-8 解码（对 py 子进程同时注入 PYTHONIOENCODING=utf-8 / PYTHONUTF8=1，规避 cp936 管道编码）。
 * cwd 用于测试：旧 patcher 真还原分支内置 tasklist 预检（zcode_patcher.py:2890-2904），本机
 * ZCode 常驻运行——fixture 测试以 cwd 指向含哑 tasklist.exe 的 stub 目录绕开（Windows exe
 * 解析顺序 current dir 先于 System32），绝不影响真实安装目录。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runCmd(cmdParts, args = [], { timeoutMs = 120000, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    const argv = [...cmdParts, ...args];
    try {
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd,
        env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) child.kill();
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        settled = true; clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err) });
      });
      child.on('close', (code) => {
        settled = true; clearTimeout(timer);
        resolve({ code: code ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
    }
  });
}

/** 命令可用性探测（--version 退出码 0 即可用）。 */
async function probeCmd(cmdStr) {
  const parts = cmdStr.split(/\s+/);
  const r = await runCmd(parts, ['--version'], { timeoutMs: 15000 });
  return r.code === 0;
}

/**
 * python 解释器解析：opts.pythonCmd（string 或 argv 数组，跳过探测直用）
 * > PYTHON_BIN > 候选链 ['py -3.13','py -3.12','py']（§1.3 写 py -3.12；本机实测 py -3.13 可用，
 * 任务书指定优先 py -3.13——两者皆探测，取先命中者）。
 * @returns {Promise<{ parts: string[], cmd: string } | null>} 不可用 → null。
 */
async function resolvePythonCmd(opts = {}, env = process.env) {
  if (opts.pythonCmd) {
    const parts = Array.isArray(opts.pythonCmd) ? [...opts.pythonCmd] : String(opts.pythonCmd).split(/\s+/);
    return { parts, cmd: parts.join(' ') };
  }
  const candidates = [];
  if (env.PYTHON_BIN) candidates.push(env.PYTHON_BIN);
  candidates.push('py -3.13', 'py -3.12', 'py');
  for (const c of candidates) {
    if (await probeCmd(c)) return { parts: c.split(/\s+/), cmd: c }; // eslint-disable-line no-await-in-loop
  }
  return null;
}

/* ---------------------------- §1.3 步骤 1：进程检查（只读采集器） ---------------------------- */

/** tasklist 检出 ZCode.exe（与旧 patcher zcode_running() 同判据；只读）。 */
async function zcodeRunningImpl() {
  if (process.platform !== 'win32') return false;
  const r = await runCmd(['tasklist'], ['/FI', 'IMAGENAME eq ZCode.exe', '/FO', 'CSV', '/NH'],
    { timeoutMs: 20000 });
  return r.code === 0 && /ZCode\.exe/i.test(r.stdout);
}

/**
 * 列出 python 系进程（PID/名称/命令行，PowerShell CIM 只读查询；失败返回 []）。
 * 测试经 opts.listProcesses 注入假实现。
 */
async function listProcessesImpl() {
  if (process.platform !== 'win32') return [];
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe' or Name='pythonw.exe' or Name='py.exe'\" " +
    '| Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const r = await runCmd(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    [], { timeoutMs: 30000 });
  if (r.code !== 0 || !r.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((p) => p && p.ProcessId != null)
      .map((p) => ({ pid: Number(p.ProcessId), name: String(p.Name || ''), commandline: String(p.CommandLine || '') }));
  } catch {
    return [];
  }
}

/**
 * WANT_FILE 扫描（§1.3 步骤 1：旧插件缓存布局 + 仓库 legacy 布局；只读）。
 * 两种布局的 scripts/ 相对位置不同，逐根声明（修 V1：对 repoRoot 多拼一层 skills/zcode-tokenspeed
 * 会生成 skills/<plugin>/skills/<plugin>/scripts/…，永不命中）：
 *   - 已安装旧插件缓存（pluginsCacheDir 默认 ~/.zcode/cli/plugins/cache，实测布局）：
 *       cache/zcode-toolkit/zcode-tokenspeed/<version>/skills/zcode-tokenspeed/scripts/_watchdog.want
 *   - 仓库旧布局（直接跑过看护的开发机）：repoRoot/skills/<plugin>/scripts/_watchdog.want
 */
function findWantFiles({ pluginsCacheDir, repoRoot }) {
  const found = [];
  const roots = [
    {
      dir: path.join(pluginsCacheDir, 'zcode-toolkit', 'zcode-tokenspeed'),
      scriptsRel: path.join('skills', 'zcode-tokenspeed', 'scripts'),
    },
    {
      dir: path.join(repoRoot, 'skills'),
      scriptsRel: 'scripts',
    },
  ];
  for (const { dir, scriptsRel } of roots) {
    let dirs;
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const want = path.join(dir, ent.name, scriptsRel, '_watchdog.want');
      try {
        if (fs.statSync(want).isFile()) found.push(want);
      } catch { /* 缺项不报错 */ }
    }
  }
  return found;
}

/* ---------------------------- §1.3 步骤 5：asar 指纹与版本（只读） ---------------------------- */

/** 流式 sha256（app.asar 数百 MB，不整读内存）。 */
async function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = fs.createReadStream(p, { highWaterMark: 4 << 20 });
    stream.on('data', (c) => h.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 读 asar 头 package.json 的 version（node 复刻 zcode_patcher.asar_version :311-321）。
 * 头布局与 _repack_asar :2022-23 逐字节一致：pack('<4I', 4, 8+len+pad, 4+len+pad, len) + json + pad。
 * @returns {string | null} 读不出 → null。
 */
function readAsarVersion(asarPath) {
  try {
    const fd = fs.openSync(asarPath, 'r');
    try {
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, 0) !== 16) return null;
      const f0 = head.readUInt32LE(0);
      const f1 = head.readUInt32LE(4);
      const f3 = head.readUInt32LE(12);
      if (f0 !== 4 || !(f3 > 0) || f3 >= (1 << 28)) return null;
      const jsonBuf = Buffer.alloc(f3);
      fs.readSync(fd, jsonBuf, 0, f3, 16);
      const header = JSON.parse(jsonBuf.toString('utf8'));
      const entry = findAsarEntry(header, 'package.json');
      if (!entry) return null;
      const off = 8 + f1 + Number(entry.offset);
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, off);
      const m = buf.toString('utf8').match(/"version"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function findAsarEntry(header, entryPath) {
  let node = header;
  for (const part of entryPath.split('/')) {
    const files = node.files || {};
    if (!(part in files)) return null;
    node = files[part];
  }
  return node;
}

/* ---------------------------- §1.3 步骤 6：清退清单 ---------------------------- */

/**
 * 精确清退清单（§1.3 步骤 6 基线 + prune_artifacts 交叉核对结果的代码化；C13：禁止通配递归）。
 * 返回相对 resources/ 的文件名列表（实现者逐项 stat 后删除，缺项记 skipped 不报错）：
 *   6× app.asar.{chart,enhance,puller,slider,tps,width}-patch.json   （prune :2810 app.asar*-patch.json）
 *   4× app.asar.{enhance,puller,slider,tps}.bak 与同名 .bak.meta.json（prune :2809-2810）
 *   模式 app.asar.*.bak.stale-* 与 .meta.json（prune :2807 app.asar*.stale-* 的 §1.3 实测命名拆分）
 *   1× app.asar.zp-lock（§1.3 实测基线；prune 清单外、迁移专有——补丁器自管文件锁）
 *   app.asar*.tps-tmp / app.asar.*.tmp（prune :2807 临时残留）
 *   3× glm/zcode.cjs.bak{,.meta.json,.stale-*}（prune :2812/:2814 内核备份）
 * 注意：v2 根的 reasoning-bak / puller-bak 等**不在本清单**（步骤 8 只列出，绝不自动删）。
 *
 * @returns {string[]} 精确文件名/模式清单（含 `*` 的项为模式，实现者枚举后逐项删除）。
 */
export function plannedCleanupArtifacts() {
  const ASAR = 'app.asar';
  const patchJsons = ['chart', 'enhance', 'puller', 'slider', 'tps', 'width']
    .map((s) => `${ASAR}.${s}-patch.json`);
  const baks = ['enhance', 'puller', 'slider', 'tps'].map((s) => `${ASAR}.${s}.bak`);
  const bakMetas = baks.map((n) => `${n}.meta.json`);
  return Object.freeze([
    ...patchJsons,
    ...baks,
    ...bakMetas,
    `${ASAR}.*.bak.stale-*`,            // prune :2807 {asar}*.stale-*（时间戳运行期枚举）
    `${ASAR}.*.bak.stale-*.meta.json`,  // 同上（stale 的 meta 伴生文件）
    `${ASAR}.zp-lock`,                  // 迁移专有（prune 清单外，§1.3 实测）
    `${ASAR}*.tps-tmp`,                 // prune :2807
    `${ASAR}.*.tmp`,                    // prune :2807
    'glm/zcode.cjs.bak',                // prune :2812
    'glm/zcode.cjs.bak.meta.json',      // prune :2812
    'glm/zcode.cjs.bak.stale-*',        // prune :2814
  ]);
}

/** plannedCleanupArtifacts() 与磁盘求交（步骤 6 预演；只读）。模式项枚举目录后逐名匹配。 */
function buildCleanupPlan(resourcesDir) {
  const plan = [];
  const dirsRead = new Map(); // dir → string[]（避免重复 readdir）
  const listDir = (dir) => {
    if (!dirsRead.has(dir)) {
      let names = null;
      try {
        names = fs.readdirSync(dir);
      } catch {
        names = null;
      }
      dirsRead.set(dir, names);
    }
    return dirsRead.get(dir);
  };
  for (const item of plannedCleanupArtifacts()) {
    const dir = path.posix.dirname(item) === '.' ? resourcesDir : path.join(resourcesDir, path.posix.dirname(item));
    const base = path.posix.basename(item);
    if (!base.includes('*')) {
      try {
        if (fs.statSync(path.join(dir, base)).isFile()) plan.push(item);
      } catch { /* 缺项记 skipped 不报错 */ }
    } else {
      const names = listDir(dir);
      if (!names) continue;
      const re = globToRegExp(base);
      for (const name of names) {
        if (re.test(name)) {
          try {
            if (fs.statSync(path.join(dir, name)).isFile()) plan.push(path.posix.join(path.posix.dirname(item), name));
          } catch { /* 过程中消失则跳过 */ }
        }
      }
    }
  }
  return [...new Set(plan)].sort();
}

/* ---------------------------- §1.3 步骤 8：v2 残留（只列出） ---------------------------- */

function scanV2Residues(v2Dir) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(v2Dir);
  } catch {
    return out;
  }
  const res = V2_RESIDUE_PATTERNS.map(globToRegExp);
  for (const name of names) {
    if (!res.some((re) => re.test(name))) continue;
    try {
      const st = fs.statSync(path.join(v2Dir, name));
      if (st.isFile()) out.push({ path: path.join(v2Dir, name), mtimeMs: st.mtimeMs });
    } catch { /* 忽略单项失败 */ }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* ---------------------------- §1.3 步骤 3：legacy patcher 预演 ---------------------------- */

/**
 * 把 patcher 输出按「=== 小节标题」切块，映射回六旗标。
 * 命中判据：check 小节含「已打」（check 分支状态字）或 revert 预演小节含「将」（将还原/将移除/将替换）。
 */
function parseFlagsPlanned(checkOut, revertDryRunOut) {
  const sectionsOf = (text) => {
    const map = new Map();
    let cur = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^===\s+(.+?)，/);
      if (m && SECTION_FLAG.has(m[1])) {
        cur = SECTION_FLAG.get(m[1]);
        if (!map.has(cur)) map.set(cur, '');
        continue;
      }
      if (cur) map.set(cur, map.get(cur) + line + '\n');
    }
    return map;
  };
  const checkSec = sectionsOf(checkOut);
  const revSec = sectionsOf(revertDryRunOut);
  return ASAR_PATCH_FLAGS.filter((flag) => {
    const c = checkSec.get(flag) || '';
    const r = revSec.get(flag) || '';
    return c.includes('已打') || r.includes('将');
  });
}

/**
 * 步骤 3 预演：六旗标 --check + --revert --dry-run + 无参数形态内核 --check（§1.3 尾注）。
 * @param {object} paths - resolvePaths 结果。
 * @param {object} opts - pythonCmd / patcherEnv / patcherCwd（子进程 env/cwd 覆盖，测试注入用）。
 * @returns {Promise<object|null>} py 不可用 → null。
 */
async function runPatcherPreflight(paths, opts = {}) {
  const py = await resolvePythonCmd(opts, paths.env);
  if (!py) return null;
  if (!fs.existsSync(paths.legacyPatcherPath)) return null;
  const installRoot = path.dirname(paths.resourcesDir);
  const childEnv = { ...(opts.patcherEnv || {}) };
  const cwd = opts.patcherCwd || undefined;
  const base = [paths.legacyPatcherPath, installRoot, ...ASAR_PATCH_FLAGS];
  const check = await runCmd(py.parts, [...base, '--check'], { env: childEnv, cwd });
  const rev = await runCmd(py.parts, [...base, '--revert', '--dry-run'], { env: childEnv, cwd });
  const kernel = await runCmd(py.parts, [paths.legacyPatcherPath, installRoot, '--check'], { env: childEnv, cwd });
  return {
    pyAvailable: true,
    pythonCmd: py.cmd,
    checkOut: check.stdout + (check.stderr ? `\n[stderr]\n${check.stderr}` : ''),
    revertDryRunOut: rev.stdout + (rev.stderr ? `\n[stderr]\n${rev.stderr}` : ''),
    kernelCheckOut: kernel.stdout + (kernel.stderr ? `\n[stderr]\n${kernel.stderr}` : ''),
    exitCodes: { check: check.code, revertDryRun: rev.code, kernelCheck: kernel.code },
    flagsPlanned: parseFlagsPlanned(check.stdout, rev.stdout),
  };
}

/* ============================================================================
 * checkMigrate —— 只读预检（§1.3 步骤 1-3 检查部分 + 步骤 6 清单预演 + 步骤 8 排查）
 * ========================================================================== */

/**
 * 只读预检（§1.3 步骤 1-3 的检查部分 + 步骤 6 清单预演 + 步骤 8 排查）。
 * **绝不修改任何文件、绝不终止任何进程**——本函数是本工作流内允许运行的唯一 migrate 入口。
 *
 * @async
 * @param {object} [opts] - 见模块头路径注入（resourcesDir/v2Dir/stateDir/pluginsCacheDir/
 *   legacyPatcherPath/pythonCmd/patcherEnv）+ 可测试性注入（zcodeRunning / listProcesses，
 *   均为无参 async 函数，默认走 tasklist / PowerShell 真实只读采集）。
 * @returns {Promise<MigrateReport>} 结构如下（字段名即契约，server 的 ztk_migrate 工具与 CLI 复用）：
 *   MigrateReport = {
 *     ranAt: number,
 *     zcodeRunning: boolean,               // 步骤 1：tasklist 检出 ZCode.exe
 *     watchdogProcesses: { name: string, pid: number }[],   // 步骤 1：python/apply_after_exit/autopilot 检出
 *     wantFilePresent: boolean,            // 步骤 1：_watchdog.want 是否存在
 *     providerConfigBackupPlan: string | null,   // 步骤 2：拟备份到的目标路径（尚未写）
 *     reasoningBakDiff: string[] | null,   // 步骤 2：.reasoning-bak 与现行 diff 摘要（null=无该文件）
 *     dryRun: {                            // 步骤 3：py 预演输出解析（py 不可用为 null）
 *       checkOut: string, revertDryRunOut: string,
 *       flagsPlanned: string[],            // 命中的六旗标
 *       pyAvailable: boolean,
 *     } | null,
 *     asarSha256: string | null,           // 当前 live app.asar 指纹（只读）
 *     expectedSha256: '1d9d350217a18b35f64e55066d90f44fc7db2e330fead6bb0745df2747ea3500',
 *     clientVersionApplies: boolean,       // 客户端 == 3.15.2 时 sha256 校验目标有效
 *     cleanupPlan: string[],               // 步骤 6 预演：实际存在的待删项（plannedCleanupArtifacts ∩ 磁盘）
 *     v2Residues: { path: string, mtimeMs: number }[],   // 步骤 8：pre-fix.*.bak 等列出（绝不删）
 *     fallbackReinstall: boolean,          // py 不可用或版本失配 → 步骤 7 兜底建议
 *   }
 *   附加观测字段（additive，不破坏上述契约）：clientVersion / wantFiles / notes / switchReady /
 *   dryRun.kernelCheckOut / dryRun.pythonCmd / dryRun.exitCodes。
 * @throws {Error} 仅基础设施错误（如 opts 注入的目录不可读）；业务检查结果全部进 report，不用异常表达。
 */
export async function checkMigrate(opts = {}) {
  const paths = resolvePaths(opts);
  const ranAt = Date.now();
  const notes = [];

  // —— 步骤 1：进程（只读采集；动作部分在 runMigrate）——
  const zcodeRunning = opts.zcodeRunning ? await opts.zcodeRunning() : await zcodeRunningImpl();
  const procs = opts.listProcesses ? await opts.listProcesses() : await listProcessesImpl();
  const watchdogProcesses = (procs || [])
    .filter((p) => WATCHDOG_RE.test(p.commandline || '') || WATCHDOG_RE.test(p.name || ''))
    .map((p) => ({ name: p.name || `pid:${p.pid}`, pid: Number(p.pid) }));
  const wantFiles = findWantFiles(paths);

  // —— 步骤 2：配置保护（只算计划与 diff；写备份的动作在 runMigrate）——
  const pcPath = path.join(paths.v2Dir, 'provider_config.json');
  const backupRel = `provider_config.pre-migrate.${timestamp(new Date(ranAt))}.json`;
  const providerConfigBackupPlan = fs.existsSync(pcPath)
    ? path.join(paths.stateDir, 'backups', backupRel)
    : null;
  if (!providerConfigBackupPlan) notes.push(`步骤2：${pcPath} 不存在，无需备份`);
  const rbPath = `${pcPath}.reasoning-bak`;
  const reasoningBakDiff = fs.existsSync(rbPath)
    ? diffLines(readTextOrNull(rbPath), readTextOrNull(pcPath))
    : null;
  if (reasoningBakDiff && reasoningBakDiff.length === 0) {
    notes.push('步骤2：.reasoning-bak 与现行配置逐行一致（无回滚风险差异）');
  }

  // —— 步骤 3：legacy patcher 预演（子进程只读模式：--check / --revert --dry-run）——
  const dryRun = await runPatcherPreflight(paths, opts);
  if (!dryRun) {
    notes.push('步骤3：py 解释器不可用（候选 py -3.13 / py -3.12 / py，可用 PYTHON_BIN 覆盖）'
      + '→ 跳过预演/还原，按步骤 7 重装兜底');
  }

  // —— 步骤 5 前置观测：live 指纹与客户端版本（只读）——
  const asarPath = path.join(paths.resourcesDir, 'app.asar');
  const asarSha256 = fs.existsSync(asarPath) ? await sha256File(asarPath) : null;
  const clientVersion = asarSha256 !== null ? readAsarVersion(asarPath) : null;
  const clientVersionApplies = clientVersion === SHA256_APPLIES_TO_VERSION;
  if (clientVersion !== null && !clientVersionApplies) {
    notes.push(`步骤5：客户端版本 ${clientVersion} ≠ ${SHA256_APPLIES_TO_VERSION}，sha256 校验目标失效 → 步骤 7`);
  }

  // —— 步骤 6 预演：清退清单 ∩ 磁盘（只读）——
  const cleanupPlan = buildCleanupPlan(paths.resourcesDir);

  // —— 步骤 8：v2 根残留（只列出，绝不删）——
  const v2Residues = scanV2Residues(paths.v2Dir);

  const fallbackReinstall = !dryRun || !clientVersionApplies;

  return {
    ranAt,
    zcodeRunning,
    watchdogProcesses,
    wantFilePresent: wantFiles.length > 0,
    providerConfigBackupPlan,
    reasoningBakDiff,
    dryRun,
    asarSha256,
    expectedSha256: EXPECTED_PRISTINE_SHA256,
    clientVersionApplies,
    cleanupPlan,
    v2Residues,
    fallbackReinstall,
    // —— 附加观测（additive）——
    clientVersion,
    wantFiles,
    notes,
    switchReady: false, // checkMigrate 只盘点；switchReady 由 runMigrate 完成后复核赋值
  };
}

/* ============================================================================
 * runMigrate —— 执行完整清退（§1.3 步骤 1-8 的动作部分 + 步骤 9 指引）
 * ========================================================================== */

/**
 * 执行完整清退（§1.3 步骤 1-8 的动作部分 + 步骤 9 指引）。
 *
 * @async
 * @param {object} [opts]
 * @param {boolean} [opts.confirm=false] - **必须显式 true** 才执行任何破坏性动作；否则抛 MigrateGateError
 *   且不产生任何变更（本仓库工作流/测试永不传 true——见模块头安全边界；例外：测试对
 *   **fixture 注入路径**传 true 验证门控与备份，绝不触真实安装目录）。
 * @param {boolean} [opts.ackReasoningBak=false] - reasoning-bak 与现行配置存在差异时的第二道显式确认。
 * @param {object} [opts.paths] - 见模块头路径注入（与 checkMigrate 同名同义，亦接受平铺形态）。
 * @returns {Promise<{ report: MigrateReport, actions: string[] }>}
 *   actions = 实际执行的动作留痕（终止的 pid、删除的文件、备份路径、revert 输出摘要、sha256 校验结论）。
 * @throws {MigrateGateError} confirm 缺失 / reasoning-bak 差异未确认——先于任何变更抛出。
 * @throws {Error} 步骤 5 校验不过（还原后 sha256 ≠ 链头真原始且版本适用）→ 报告走重装兜底，
 *   不继续步骤 6（实现者注意：此错误发生时不得已删除任何 resources/ 条目——清退必须在校验通过之后）。
 */
export async function runMigrate(opts = {}) {
  const paths = resolvePaths(opts);

  // —— 闸门 1（主闸门）：confirm 缺失 → 先于任何变更抛出 ——
  if (opts.confirm !== true) {
    throw new MigrateGateError(
      'migrate 未获 --confirm：不执行任何变更（还原/清退/终止看护/删 WANT_FILE/备份均未发生）',
      [
        '先跑 --check / --dry-run 核对报告（本仓库工作流内到此为止）',
        '确要执行：CLI 手动加 --confirm（步骤 2 起的破坏性动作由此唯一闸门保护）',
      ],
    );
  }

  const report = await checkMigrate(opts);
  const actions = [];
  const py = await resolvePythonCmd(opts, paths.env);
  const childEnv = { ...(opts.patcherEnv || {}) };
  const cwd = opts.patcherCwd || undefined;
  const installRoot = path.dirname(paths.resourcesDir);

  // —— 闸门 2：reasoning-bak 差异需第二道显式确认（§1.3 步骤 2 双保险②）——
  if (report.reasoningBakDiff && report.reasoningBakDiff.length > 0 && opts.ackReasoningBak !== true) {
    throw new MigrateGateError(
      '存在 provider_config.json.reasoning-bak 且与现行配置有差异：继续迁移前必须逐行核对（否则旧档位配置可能回滚现行供应商配置）',
      [
        '差异摘要（- = .reasoning-bak 侧，+ = 现行 provider_config.json 侧）：',
        ...report.reasoningBakDiff.map((l) => `  ${l}`),
        '确认无回滚风险后加 --ack-reasoning-bak 重试',
      ],
    );
  }

  // —— 步骤 1 动作：ZCode 必须已退出；终止看护进程；删 WANT_FILE 队列 ——
  if (report.zcodeRunning) {
    throw new Error('步骤1：检测到 ZCode.exe 正在运行——请完全退出 ZCode 后重跑 migrate（运行中 app.asar 被锁、配置会被回写）');
  }
  for (const p of report.watchdogProcesses) {
    const r = await runCmd(['taskkill'], ['/F', '/PID', String(p.pid)], { timeoutMs: 20000, env: childEnv });
    actions.push(`步骤1：终止看护进程 pid=${p.pid} (${p.name}) → taskkill 退出码 ${r.code}${r.code === 0 ? '' : `: ${r.stderr.trim()}`}`);
  }
  for (const f of report.wantFiles) {
    fs.rmSync(f, { force: true });
    actions.push(`步骤1：删除 WANT_FILE 队列 ${f}`);
  }

  // —— 步骤 2 动作：时间戳备份（写 stateDir/backups，绝不写 v2 根）——
  if (report.providerConfigBackupPlan) {
    const pcPath = path.join(paths.v2Dir, 'provider_config.json');
    fs.mkdirSync(path.dirname(report.providerConfigBackupPlan), { recursive: true });
    fs.copyFileSync(pcPath, report.providerConfigBackupPlan);
    actions.push(`步骤2：备份 ${pcPath} → ${report.providerConfigBackupPlan}`);
  }

  // —— 步骤 3/4：py 不可用 → 不还原、不清退，转步骤 7 兜底 ——
  let verified = false;
  if (!py || !fs.existsSync(paths.legacyPatcherPath) || !report.dryRun) {
    actions.push('步骤3/4：py 或 legacy/zcode_patcher.py 不可用 → 跳过还原与清退，走步骤 7 重装兜底'
      + '（ZCode 重装/升级一次即可全量覆盖 resources\\app.asar 为官方原字节）');
  } else {
    // 步骤 4：六旗标 revert（显式枚举，绝不用 --all——见 ASAR_PATCH_FLAGS 注释）
    const revArgs = [paths.legacyPatcherPath, installRoot, ...ASAR_PATCH_FLAGS, '--revert'];
    const rev = await runCmd(py.parts, revArgs, { env: childEnv, cwd });
    actions.push(`步骤4：legacy patcher 六旗标 revert 退出码 ${rev.code}（${py.cmd} ${revArgs.slice(1).join(' ')}）`);
    if (rev.code !== 0) {
      throw new Error(`步骤4：revert 未全部成功（退出码 ${rev.code}）——不进入校验/清退。摘要：\n${tail(rev.stdout, 15)}`);
    }
    // §1.3 尾注：无参数形态补一次内核还原（zcode.cjs ≤3.11 档位透传；无备份时为无害跳过）
    const krev = await runCmd(py.parts, [paths.legacyPatcherPath, installRoot, '--revert'], { env: childEnv, cwd });
    actions.push(`步骤4-内核：无参数形态内核还原退出码 ${krev.code}${krev.code === 0 ? '（无备份时为「跳过」）' : `：${tail(krev.stdout, 5)}`}`);

    // —— 步骤 5：校验（还原后 live 指纹）——
    const asarPath = path.join(paths.resourcesDir, 'app.asar');
    const after = fs.existsSync(asarPath) ? await sha256File(asarPath) : null;
    if (report.clientVersionApplies) {
      if (after !== EXPECTED_PRISTINE_SHA256) {
        throw new Error(`步骤5：校验不过——还原后 app.asar sha256=${after} ≠ 链头真原始 ${EXPECTED_PRISTINE_SHA256}。`
          + '按 §1.3 步骤 7 走重装兜底（ZCode 重装/升级一次全量覆盖 resources\\app.asar）。'
          + '注意：本校验在清退（步骤 6）之前失败，未删除任何 resources/ 条目。');
      }
      verified = true;
      actions.push(`步骤5：校验通过 app.asar sha256 == ${EXPECTED_PRISTINE_SHA256}`);
    } else {
      actions.push(`步骤5：客户端版本 ${report.clientVersion ?? '未知'} ≠ ${SHA256_APPLIES_TO_VERSION}——sha256 校验目标失效，`
        + '不做指纹断言、不清退（残留与备份由重装兜底全量覆盖），走步骤 7 指引');
    }
  }

  // —— 步骤 6：清退（**仅在校验通过后**；逐项删除，缺项记 skipped）——
  if (verified) {
    const existing = buildCleanupPlan(paths.resourcesDir);
    const deleted = [];
    const skipped = [];
    for (const item of existing) {
      const full = path.join(paths.resourcesDir, ...item.split('/'));
      try {
        fs.rmSync(full, { force: true });
        deleted.push(item);
      } catch {
        skipped.push(item);
      }
    }
    actions.push(`步骤6：清退 ${deleted.length} 项（清单=zcode_patcher.py prune_artifacts :2807-2819 交叉核对版；不通配递归）`);
    for (const d of deleted) actions.push(`步骤6：已删 resources/${d}`);
    if (skipped.length) actions.push(`步骤6：skipped（删除失败，人工复核）：${skipped.join(', ')}`);
  } else {
    actions.push('步骤6：跳过（步骤 5 校验未通过或 py 不可用——清退必须在校验通过之后）');
  }

  // —— 步骤 7/8/9：指引（只报告，不执行）——
  actions.push('步骤7（兜底，永远可用）：ZCode 重装或触发一次升级——resources\\app.asar 在安装清单内全量覆盖为官方原字节，不依赖任何旧代码');
  const final = await checkMigrate(opts); // 复核后状态（全绿判据）
  final.switchReady = verified
    && final.cleanupPlan.length === 0
    && !final.wantFilePresent
    && final.watchdogProcesses.length === 0
    && !final.zcodeRunning;
  if (final.v2Residues.length) {
    actions.push('步骤8（列出，绝不自动删）：v2 根残留由你决定是否手工清理：'
      + final.v2Residues.map((r) => `${r.path} (mtime ${new Date(r.mtimeMs).toISOString()})`).join('；'));
  }
  if (final.switchReady) {
    actions.push('步骤9（全绿，切换指引）：① 卸载旧插件 → ② 安装/升级新插件（市场内原位升级——必须在 migrate 完成之后，§1.3 顺序约束）'
      + ' → ③ 首启确认 doctor 全绿');
  } else {
    actions.push('步骤9：尚未全绿（switchReady=false）——按上方步骤 5/7 指引处理后重跑 --check 复核');
  }
  return { report: final, actions };
}

/** 输出尾部 n 行（错误摘要用）。 */
function tail(text, n) {
  const lines = String(text || '').trim().split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

/* ============================================================================
 * CLI 入口：node src/migrate.mjs [--check | --dry-run | --confirm] [--ack-reasoning-bak] [--json]
 * 旗标语义（任务书）：--check 只读盘点 / --dry-run 预演输出 / --confirm 唯一破坏性模式。
 * 路径一律可注入（ZTK_RESOURCES_DIR / ZTK_V2_DIR / ZTK_STATE_DIR / ZTK_PLUGINS_CACHE_DIR /
 * ZTK_LEGACY_PATCHER / PYTHON_BIN）。
 * ========================================================================== */

const USAGE = `用法：node src/migrate.mjs [--check | --dry-run | --confirm] [--ack-reasoning-bak] [--json]

  --check   只读盘点（默认）：§1.3 步骤 1-3 检查 + 步骤 6 清单预演 + 步骤 8 排查，绝不改动
  --dry-run 预演输出：在 --check 报告之上，逐条打印若加 --confirm 将执行的动作（仍不执行）
  --confirm 执行清退（唯一破坏性模式；需 ZCode 已退出，reasoning-bak 差异另需 --ack-reasoning-bak）
  --json    机器可读输出（MigrateReport JSON）
  路径注入：ZTK_RESOURCES_DIR / ZTK_V2_DIR / ZTK_STATE_DIR / ZTK_PLUGINS_CACHE_DIR /
            ZTK_LEGACY_PATCHER / PYTHON_BIN（py 候选链：py -3.13 → py -3.12 → py）`;

function plannedActionLines(report) {
  const lines = [];
  if (report.zcodeRunning) lines.push('将中止：检测到 ZCode.exe 运行中——runMigrate 会先拒绝（请先完全退出 ZCode）');
  for (const p of report.watchdogProcesses) lines.push(`将终止看护进程：pid=${p.pid} (${p.name})`);
  for (const f of report.wantFiles) lines.push(`将删除 WANT_FILE：${f}`);
  if (report.providerConfigBackupPlan) lines.push(`将备份 provider_config.json → ${report.providerConfigBackupPlan}`);
  else lines.push('（provider_config.json 不存在：无备份动作）');
  if (report.reasoningBakDiff && report.reasoningBakDiff.length) {
    lines.push('将要求 --ack-reasoning-bak（.reasoning-bak 与现行配置存在差异）：');
    for (const l of report.reasoningBakDiff) lines.push(`    ${l}`);
  }
  if (report.dryRun) {
    lines.push(`将以六旗标执行 revert：${ASAR_PATCH_FLAGS.join(' ')}（不用 --all）`
      + `；命中的旗标：${report.dryRun.flagsPlanned.length ? report.dryRun.flagsPlanned.join(' ') : '（无，均已未打）'}`);
  } else {
    lines.push('py 不可用 → 不执行 revert/清退，仅给出步骤 7 重装兜底指引');
  }
  lines.push(`校验目标：sha256 == ${report.expectedSha256}${report.clientVersionApplies ? '' : `（客户端 ${report.clientVersion ?? '未知'} ≠ ${SHA256_APPLIES_TO_VERSION}：校验失效 → 走重装兜底，不清退）`}`);
  for (const c of report.cleanupPlan) lines.push(`将删除 resources/${c}（仅在校验通过后执行）`);
  for (const r of report.v2Residues) lines.push(`仅列出绝不删：${r.path} (mtime ${new Date(r.mtimeMs).toISOString()})`);
  lines.push('兜底（步骤 7，永远可用）：ZCode 重装/升级一次全量覆盖 resources\\app.asar');
  lines.push('切换（步骤 9）：全绿后 卸载旧插件 → 安装/升级新插件 → 首启 doctor 全绿');
  return lines;
}

function renderReport(report) {
  const L = [];
  L.push(`=== ztk-migrate 只读盘点 ${new Date(report.ranAt).toISOString()} ===`);
  L.push(`[1] 进程：ZCode.exe ${report.zcodeRunning ? '运行中（迁移前必须完全退出）' : '未运行'}；`
    + `看护进程 ${report.watchdogProcesses.length} 个${report.watchdogProcesses.length ? `（${report.watchdogProcesses.map((p) => `pid=${p.pid}`).join(',')}）` : ''}；`
    + `WANT_FILE ${report.wantFilePresent ? '存在' : '不存在'}`);
  L.push(`[2] 配置保护：${report.providerConfigBackupPlan ? `拟备份 → ${report.providerConfigBackupPlan}` : 'provider_config.json 不存在，无需备份'}；`
    + `.reasoning-bak ${report.reasoningBakDiff === null ? '不存在' : (report.reasoningBakDiff.length ? `差异 ${report.reasoningBakDiff.length} 条（需 --ack-reasoning-bak）` : '存在但与现行一致')}`);
  if (report.dryRun) {
    L.push(`[3] 预演（${report.dryRun.pythonCmd}）：六旗标 check/revert-dry-run 退出码 `
      + `${report.dryRun.exitCodes.check}/${report.dryRun.exitCodes.revertDryRun}；命中 ${report.dryRun.flagsPlanned.length}/6`);
  } else {
    L.push('[3] 预演：py 不可用（候选 py -3.13 / py -3.12 / py，可用 PYTHON_BIN 覆盖）→ 步骤 7 兜底');
  }
  L.push(`[5] 校验目标：live sha256=${report.asarSha256 ?? '（app.asar 缺失）'}；`
    + `期望 ${report.expectedSha256}（客户端 ${report.clientVersion ?? '未知'}${report.clientVersionApplies ? '，适用' : `，不适用（≠${SHA256_APPLIES_TO_VERSION}）`}）`);
  L.push(`[6] 清退清单（已存在的 ${report.cleanupPlan.length} 项）`);
  for (const c of report.cleanupPlan) L.push(`      ${c}`);
  L.push(`[8] v2 残留（仅列出，${report.v2Residues.length} 项，绝不自动删）`);
  for (const r of report.v2Residues) L.push(`      ${r.path} (mtime ${new Date(r.mtimeMs).toISOString()})`);
  L.push(`[7] 兜底建议：${report.fallbackReinstall ? '需要（py 不可用或版本失配）——' : '暂不需要——'}ZCode 重装/升级一次即可`);
  return L;
}

/** @returns {Promise<number>} 进程退出码（0 正常；2 用法/门控；3 校验不过）。
 * io：{ out(s), err(s), paths（路径注入）, opts（其余 checkMigrate/runMigrate opts 透传，
 *       如测试注入 zcodeRunning / listProcesses）, env（路径 env 覆盖）}。 */
export async function cliMain(argv = process.argv.slice(2), io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + '\n'));
  const err = io.err || ((s) => process.stderr.write(s + '\n'));
  const baseOpts = { ...(io.paths || {}), ...(io.opts || {}), ...(io.env ? { env: io.env } : {}) };
  const flags = { check: false, dryRun: false, confirm: false, ackReasoningBak: false, json: false, help: false };
  for (const a of argv) {
    if (a === '--check') flags.check = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--confirm') flags.confirm = true;
    else if (a === '--ack-reasoning-bak') flags.ackReasoningBak = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else {
      err(`未知旗标：${a}\n${USAGE}`);
      return 2;
    }
  }
  const modes = [flags.check, flags.dryRun, flags.confirm].filter(Boolean).length;
  if (modes > 1) {
    err(`--check / --dry-run / --confirm 互斥（给了 ${modes} 个）\n${USAGE}`);
    return 2;
  }
  if (flags.help) {
    out(USAGE);
    return 0;
  }

  try {
    if (flags.confirm) {
      const { report, actions } = await runMigrate({
        ...baseOpts,
        confirm: true,
        ackReasoningBak: flags.ackReasoningBak,
      });
      if (flags.json) out(JSON.stringify({ report, actions }, null, 2));
      else for (const a of actions) out(a);
      return report.switchReady ? 0 : 3;
    }
    const report = await checkMigrate(baseOpts);
    const lines = renderReport(report);
    if (flags.dryRun) lines.push('--- 若加 --confirm 将执行（预演，不执行）---', ...plannedActionLines(report));
    if (flags.json) out(JSON.stringify(report, null, 2));
    else for (const l of lines) out(l);
    return 0;
  } catch (e) {
    if (e instanceof MigrateGateError) {
      err(`[MigrateGateError] ${e.message}`);
      for (const p of e.pending) err(`  · ${p}`);
      return 2;
    }
    err(`[migrate] ${e && e.message ? e.message : e}`);
    return 3;
  }
}

// 直接执行守卫（被 import 时不触发 CLI）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cliMain();
}
