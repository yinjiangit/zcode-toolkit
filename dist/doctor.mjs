/**
 * doctor.mjs —— SessionStart 哨兵（方案 §2.5 doctor 规格、§2.3-3 死链修复、§3.2 自愈唯一动作）。
 *
 * 形态：node 单文件（hooks/hooks.json → node "${CLAUDE_PLUGIN_ROOT}/dist/doctor.mjs"，timeoutMs 120000），
 * 常态 <1s；**任何异常 → stderr 记录 + exit 0 + 尽力写 sidecar，绝不阻断会话**（契约，硬性）。
 * 输出 sidecar：<ZTK_STATE_DIR>/doctor.json（ZTK_STATE_DIR 默认 ~/.zcode/zcode-toolkit）。
 *
 * 五项检查（§2.5 ①-⑤，含 G0-a/评审落地细节）：
 *   ① db.sqlite 可读 + schema_migration 顶部迁移 id 在知识表内
 *      （判定引用 src/knowledge.mjs 的 KNOWN_SCHEMA_MIGRATIONS / isKnownSchema，以 id 列为准——
 *      id 伴随的 app_version 是 db 内部版本 0.16.5，不是客户端版本 3.15.2，g0a 勘误）；
 *      并核对列分布事实「turn_usage 无 query_source、model_usage 有」（KNOWN_TABLE_COLUMN_BASELINE）——
 *      它是 tps 过滤 SQL 的存在前提。
 *   ② provider_config.json 探测 + 与 env 指针一致性：
 *      可读性 + 父目录可写性（fs.access(dir, W_OK) 目录级探测——**探测动作本身不写任何文件、不留垃圾**）；
 *      与 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 指向一致性（该变量在 ZCode 派生子进程 env 存在〔评审实测〕，
 *      插件 server/hook 进程是否继承【待验证 G0-d】——只记录存在与否，不据此 fail）。
 *   ③ getHostCapabilities() 能力协商结果记录（官方 mcpappdev SKILL.md:18 / app.ts:19 用法）；
 *      hook 进程无 MCP 请求上下文 → 依次尝试：进程内宿主 API（globalThis.getHostCapabilities）→
 *      server 进程协商后落盘的能力 sidecar <stateDir>/host_capabilities.json（server 实现者契约）；
 *      都不可得 → 明示不支持（V3），记 degraded 不 fail。
 *   ④ showcase / zcode-guide 当前版本记录（ui.surfaces 协议漂移预警，§2.3-8）：从插件缓存目录只读读取版本号，
 *      与 knowledge.KNOWN_PLUGIN_VERSIONS 对照，未知识化版本记 warn。
 *   ⑤ 旧补丁残留检测：ZCode resources/ 内 *-patch.json / *.bak / *.bak.meta.json / *.bak.stale-* / zp-lock
 *      任一存在 → residueDetected=true，banner 引导文案固定为：
 *      「检测到旧补丁残留 → 先运行 migrate（ztk_migrate，先 --check 预演）→ 再升级/安装新版」
 *      （§1.3 顺序约束：先 migrate、后升级插件——缓存是否存活不依赖，migrate 用 vendor 的 legacy 副本）。
 *
 * 路径注入：opts.dbPath / opts.v2Dir / opts.stateDir / opts.pluginsCacheDir / opts.resourcesDir
 *   > 对应环境变量（ZTK_DB_PATH / ZTK_V2_DIR / ZTK_STATE_DIR / ZTK_PLUGINS_CACHE_DIR / ZTK_RESOURCES_DIR）
 *   > 默认真实路径（resourcesDir 默认从标准安装位置发现 ZCode 安装根，仅只读枚举，
 *   **任何代码路径禁止写安装目录**；ZTK_PLUGINS_CACHE_DIR/ZTK_RESOURCES_DIR 为本实现为 CLI/测试注入
 *   追加的 env 覆盖，语义与其余 ZTK_* 一致）。
 * 测试一律注入 fixture 路径。
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  KNOWN_SCHEMA_MIGRATIONS,
  KNOWN_TABLE_COLUMN_BASELINE,
  KNOWN_PLUGIN_VERSIONS,
  isKnownSchema,
} from './knowledge.mjs';

const DOCTOR_SIDECAR_NAME = 'doctor.json';
const CAPABILITIES_SIDECAR_NAME = 'host_capabilities.json';
const RESIDUE_BANNER_TEXT =
  '检测到旧补丁残留 → 先运行 migrate（ztk_migrate，先 --check 预演）→ 再升级/安装新版';
/** doctor④订阅的插件（§2.3-8 长期观望清单）。 */
const WATCHED_PLUGINS = ['showcase', 'zcode-guide'];

/* -------------------------------------------------------------------------
 * 路径解析（入参 > ZTK_* env > 默认真实路径；默认值仅指向，探测动作只读）
 * ------------------------------------------------------------------------- */

/**
 * 解析单个可注入路径：显式入参 > 环境变量 > 默认值。
 * @param {string|undefined} explicit
 * @param {string} envName
 * @param {string} dflt
 * @returns {string}
 */
function resolvePathOpt(explicit, envName, dflt) {
  if (explicit) return explicit;
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv) return fromEnv;
  return dflt;
}

/**
 * 默认真实路径集（win32 标准安装位置；resources/ 只读枚举，任何代码路径禁止写安装目录）。
 * @returns {{dbPath:string, v2Dir:string, stateDir:string, pluginsCacheDir:string, resourcesDir:string}}
 */
function defaultPaths() {
  const zcodeHome = path.join(os.homedir(), '.zcode');
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return {
    dbPath: path.join(zcodeHome, 'cli', 'db', 'db.sqlite'),
    v2Dir: path.join(zcodeHome, 'v2'),
    stateDir: path.join(zcodeHome, 'zcode-toolkit'),
    pluginsCacheDir: path.join(zcodeHome, 'cli', 'plugins', 'cache'),
    resourcesDir: path.join(localAppData, 'Programs', 'ZCode', 'resources'),
  };
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

/** win32 路径大小写不敏感比较（本插件目标平台 win32；其余平台精确比较）。 */
function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/* -------------------------------------------------------------------------
 * 五项检查（每项返回 {id, status, detail}；runDoctor 统一兜异常 → status='fail'）
 * ------------------------------------------------------------------------- */

/**
 * ① db.sqlite 只读哨兵：顶部迁移 id 白名单判定 + 列分布事实核对。
 * 判定引用 knowledge.isKnownSchema / KNOWN_TABLE_COLUMN_BASELINE（不得在本模块重写白名单）。
 * @param {string} dbPath
 * @param {DoctorReport} report - 就地写 report.schemaTopId（①的原始观测）。
 * @returns {{id:number, status:string, detail:string}}
 */
function checkDb(dbPath, report) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const top = db
      .prepare('SELECT id, app_version FROM schema_migration ORDER BY id DESC LIMIT 1')
      .get();
    report.schemaTopId = top && top.id != null ? String(top.id) : null;

    const tuCols = db.prepare('PRAGMA table_info(turn_usage)').all().map((c) => c.name);
    const muCols = db.prepare('PRAGMA table_info(model_usage)').all().map((c) => c.name);
    const tuHasQs = tuCols.includes('query_source');
    const muHasQs = muCols.includes('query_source');
    const tuBase = KNOWN_TABLE_COLUMN_BASELINE.turn_usage;
    const muBase = KNOWN_TABLE_COLUMN_BASELINE.model_usage;
    const colFact =
      `turn_usage ${tuCols.length} 列${tuCols.length !== tuBase.columnCount ? `（基线 ${tuBase.columnCount}）` : ''}` +
      `${tuHasQs ? '（含 query_source）' : '（无 query_source）'}、` +
      `model_usage ${muCols.length} 列${muCols.length !== muBase.columnCount ? `（基线 ${muBase.columnCount}）` : ''}` +
      `${muHasQs ? '（含 query_source）' : '（无 query_source）'}`;
    const dbTail = path.basename(dbPath);

    if (!isKnownSchema(report.schemaTopId)) {
      return {
        id: 1,
        status: 'degraded',
        detail:
          `schema 漂移：顶部迁移 id=${report.schemaTopId} 不在知识表（${KNOWN_SCHEMA_MIGRATIONS.length} 项内）` +
          `——TPS 将走降级文案（数据源暂不可用），会话照常；${colFact}；db=${dbTail}`,
      };
    }
    if (tuHasQs !== tuBase.hasQuerySource || muHasQs !== muBase.hasQuerySource) {
      return {
        id: 1,
        status: 'degraded',
        detail:
          `列分布事实漂移（tps 过滤 SQL 前提失效）：${colFact}，基线=turn_usage 无 / model_usage 有 query_source` +
          `；顶部迁移 id=${report.schemaTopId}；db=${dbTail}`,
      };
    }
    return {
      id: 1,
      status: 'ok',
      detail:
        `db 可读（${dbTail}）：顶部迁移 id=${report.schemaTopId}` +
        `（app_version ${top && top.app_version ? top.app_version : '?'}，知识表 ${KNOWN_SCHEMA_MIGRATIONS.length} 项内）；` +
        `列分布事实成立——${colFact}`,
    };
  } finally {
    try {
      db.close();
    } catch {
      /* 只读连接关闭失败不影响判定 */
    }
  }
}

/**
 * ② provider_config.json 探测：可读性 + 父目录可写性（W_OK 目录级探测，不写任何文件、不留垃圾）
 * + 与 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE env 指针一致性记录（只记录，不据此 fail）。
 * @param {string} v2Dir
 * @param {DoctorReport} report - 读 report.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE。
 * @returns {{id:number, status:string, detail:string}}
 */
function checkProviderConfig(v2Dir, report) {
  const file = path.join(v2Dir, 'provider_config.json');
  const facts = [];

  let readable = false;
  try {
    fs.accessSync(file, fs.constants.R_OK);
    readable = true;
  } catch {
    /* 记录事实即可 */
  }
  facts.push(`provider_config.json ${readable ? '可读' : '不存在/不可读'}（…/${path.basename(v2Dir)}/）`);

  let dirWritable = false;
  try {
    fs.accessSync(v2Dir, fs.constants.W_OK);
    dirWritable = true;
  } catch {
    /* 记录事实即可 */
  }
  facts.push(`父目录${dirWritable ? '可写（W_OK 目录级探测，未写任何文件）' : '不可写'}`);

  const envPtr = report.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  if (envPtr) {
    facts.push(`env 指针${samePath(envPtr, file) ? '一致' : '不一致'}：${envPtr}`);
  } else {
    facts.push('env 指针 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 未设置（G0-d：hook/server 进程是否继承待验证，仅记录）');
  }

  return { id: 2, status: readable && dirWritable ? 'ok' : 'warn', detail: facts.join('；') };
}

/**
 * ③ getHostCapabilities 能力协商结果记录（V3）。hook 进程无 MCP 请求上下文，依次尝试：
 * 进程内宿主 API（globalThis.getHostCapabilities）→ server 落盘的能力 sidecar → 明示不支持（degraded 不 fail）。
 * @param {string} stateDir - 能力 sidecar（host_capabilities.json）所在根（与 doctor.json 同目录）。
 * @param {object} opts - runDoctor 入参（读取可注入的 opts.getHostCapabilities）。
 * @returns {Promise<{id:number, status:string, detail:string}>}
 */
async function checkHostCapabilities(stateDir, opts) {
  const probe =
    typeof opts.getHostCapabilities === 'function'
      ? opts.getHostCapabilities
      : typeof globalThis.getHostCapabilities === 'function'
        ? () => globalThis.getHostCapabilities()
        : null;
  if (probe) {
    try {
      const caps = await probe();
      return { id: 3, status: 'ok', detail: `getHostCapabilities 协商成功：${summarizeCaps(caps)}` };
    } catch (err) {
      return {
        id: 3,
        status: 'degraded',
        detail: `getHostCapabilities 调用失败（${errText(err)}）——V3：缺失能力明示不支持，不 fail`,
      };
    }
  }
  const sidecarPath = path.join(stateDir, CAPABILITIES_SIDECAR_NAME);
  try {
    const caps = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    return { id: 3, status: 'ok', detail: `server 能力 sidecar（${CAPABILITIES_SIDECAR_NAME}）：${summarizeCaps(caps)}` };
  } catch {
    /* 无 sidecar → 明示不支持 */
  }
  return {
    id: 3,
    status: 'degraded',
    detail:
      'getHostCapabilities 在 SessionStart hook 进程不可用（能力协商发生在插件 server 进程，V3），' +
      `且未见 server 能力 sidecar（${CAPABILITIES_SIDECAR_NAME}）——ui.surfaces 缺失能力将由 server 明示不支持`,
  };
}

/** 能力对象摘要：只取键名 + 截断的紧凑 JSON（宿主能力非敏感，但仍限长）。 */
function summarizeCaps(caps) {
  if (!caps || typeof caps !== 'object') return String(caps);
  const keys = Object.keys(caps);
  const compact = JSON.stringify(caps);
  const shown = compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
  return `能力键 [${keys.join(', ')}] ${shown}`;
}

/**
 * ④ showcase / zcode-guide 版本记录（§2.3-8 ui.surfaces 协议漂移预警）。
 * 扫描 <pluginsCacheDir>/<marketplace>/<pluginName>/<version>/ 目录（版本号目录名即版本记录），
 * 与 knowledge.KNOWN_PLUGIN_VERSIONS 对照：未知识化版本记 warn；未安装记事实不 warn。
 * @param {string} pluginsCacheDir
 * @returns {{id:number, status:string, detail:string}}
 */
function checkPluginVersions(pluginsCacheDir) {
  const found = {};
  try {
    for (const mkt of fs.readdirSync(pluginsCacheDir, { withFileTypes: true })) {
      if (!mkt.isDirectory()) continue;
      for (const name of WATCHED_PLUGINS) {
        if (found[name]) continue;
        const versions = listVersionDirs(path.join(pluginsCacheDir, mkt.name, name));
        if (versions.length > 0) {
          found[name] = { marketplace: mkt.name, version: versions[versions.length - 1], versions };
        }
      }
    }
  } catch (err) {
    return { id: 4, status: 'warn', detail: `插件缓存目录不可读（${pluginsCacheDir}）：${errText(err)}` };
  }

  const parts = [];
  let drift = false;
  for (const name of WATCHED_PLUGINS) {
    const hit = found[name];
    if (!hit) {
      parts.push(`${name}=未发现（未安装）`);
      continue;
    }
    const known = KNOWN_PLUGIN_VERSIONS[name];
    if (known === hit.version) {
      parts.push(`${name}=${hit.version}（已知，@${hit.marketplace}）`);
    } else {
      drift = true;
      parts.push(
        `${name}=${hit.version}（未知识化，已知版本 ${known ?? '无'}，@${hit.marketplace}）` +
          '——ui.surfaces 协议漂移预警（§2.3-8）',
      );
    }
  }
  return { id: 4, status: drift ? 'warn' : 'ok', detail: parts.join('；') };
}

/** 列出插件目录下的语义化版本目录（升序；非版本目录忽略）。 */
function listVersionDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name))
      .map((e) => e.name)
      .sort(compareVersionNames);
  } catch {
    return [];
  }
}

function compareVersionNames(a, b) {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** ⑤ 残留判定：§2.5 doctor⑤四类 + .bak.meta.json sidecar（§1.3 步骤 6 清单同族，官方安装零命中）。 */
function isResidueFile(name) {
  return (
    name.endsWith('-patch.json') ||
    name.endsWith('.bak') ||
    name.endsWith('.bak.meta.json') ||
    name.includes('.bak.stale-') ||
    name.endsWith('zp-lock')
  );
}

/**
 * ⑤ 旧补丁残留检测（resources/ 只读枚举）。检出 → report.residueDetected=true + banner 引导 migrate。
 * @param {string} resourcesDir
 * @param {DoctorReport} report - 就地写 residueDetected / banner。
 * @returns {{id:number, status:string, detail:string}}
 */
function checkResidue(resourcesDir, report) {
  const hits = [];
  try {
    for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
      if (entry.isFile() && isResidueFile(entry.name)) hits.push(entry.name);
    }
  } catch (err) {
    return {
      id: 5,
      status: 'warn',
      detail: `resources 目录不可读（${resourcesDir}）：${errText(err)}——残留检测未执行`,
    };
  }
  if (hits.length > 0) {
    report.residueDetected = true;
    report.banner = { level: 'warn', text: RESIDUE_BANNER_TEXT };
    const sample = hits.slice(0, 4).join('、');
    return {
      id: 5,
      status: 'warn',
      detail:
        `检出旧补丁残留 ${hits.length} 项（${sample}${hits.length > 4 ? '…' : ''}）` +
        '——先 migrate 后升级（§1.3 顺序约束；migrate 用 vendor 的 legacy 副本，不依赖插件缓存存活）',
    };
  }
  return { id: 5, status: 'ok', detail: `无旧补丁残留（${resourcesDir}）` };
}

/* -------------------------------------------------------------------------
 * 导出 API
 * ------------------------------------------------------------------------- */

/**
 * 运行五项哨兵检查（纯采集 + 判定，不写 sidecar——sidecar 由 writeSidecar 单独负责，便于测试）。
 *
 * @async
 * @param {object} [opts]
 * @param {string} [opts.dbPath] - 覆盖 db 路径（测试注入 fixture）。
 * @param {string} [opts.v2Dir] - 覆盖 v2 根（测试注入 fixture）。
 * @param {string} [opts.stateDir] - 覆盖 state 根（③读取能力 sidecar 用；sidecar 写入见 writeSidecar）。
 * @param {string} [opts.pluginsCacheDir] - 覆盖插件缓存根（默认 ~/.zcode/cli/plugins/cache，只读）。
 * @param {string} [opts.resourcesDir] - 覆盖 ZCode resources 目录（测试注入 fixture；只读）。
 * @param {function} [opts.getHostCapabilities] - ③的可注入能力协商探针（宿主 API 形态；缺省走
 *   globalThis.getHostCapabilities → 能力 sidecar → degraded 明示）。
 * @returns {Promise<DoctorReport>} 结构如下（字段名即契约）：
 *   DoctorReport = {
 *     ranAt: number,                          // epoch ms
 *     schemaTopId: string | null,             // schema_migration 顶部行 id（①的原始观测）
 *     checks: Array<{                         // 五项，id 1..5 固定
 *       id: 1|2|3|4|5,
 *       status: 'ok' | 'warn' | 'degraded' | 'fail',
 *       detail: string,                       // 人读明细（含版本号/路径尾号，不含 apiKey 等敏感值）
 *     }>,
 *     residueDetected: boolean,               // ⑤结果；true 时 banner 必非空
 *     banner: { level: 'info' | 'warn', text: string } | null,
 *     env: { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: string | null },  // ②的 G0-d 观测记录
 *   }
 *   降级语义：①schema 漂移（顶部 id 不在知识表 / 列分布事实漂移）→ checks[0].status='degraded'
 *   （不是 fail——TPS 走降级文案，会话照常）；⑤检出残留 → residueDetected=true + banner 引导 migrate；
 *   单项检查自身抛错 → 该项 status='fail'，runDoctor 整体不抛（内部兜底），错误文本进 detail。
 * @throws {never} 本函数契约上不抛（所有异常内部捕获进 checks）。CLI 侧再兜一层：见文件尾 main 守卫。
 */
export async function runDoctor(opts = {}) {
  const dflt = defaultPaths();
  const paths = {
    dbPath: resolvePathOpt(opts.dbPath, 'ZTK_DB_PATH', dflt.dbPath),
    v2Dir: resolvePathOpt(opts.v2Dir, 'ZTK_V2_DIR', dflt.v2Dir),
    stateDir: resolvePathOpt(opts.stateDir, 'ZTK_STATE_DIR', dflt.stateDir),
    pluginsCacheDir: resolvePathOpt(opts.pluginsCacheDir, 'ZTK_PLUGINS_CACHE_DIR', dflt.pluginsCacheDir),
    resourcesDir: resolvePathOpt(opts.resourcesDir, 'ZTK_RESOURCES_DIR', dflt.resourcesDir),
  };

  /** @type {DoctorReport} */
  const report = {
    ranAt: Date.now(),
    schemaTopId: null,
    checks: [],
    residueDetected: false,
    banner: null,
    env: {
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || null,
    },
  };

  const probes = [
    () => checkDb(paths.dbPath, report),
    () => checkProviderConfig(paths.v2Dir, report),
    () => checkHostCapabilities(paths.stateDir, opts),
    () => checkPluginVersions(paths.pluginsCacheDir),
    () => checkResidue(paths.resourcesDir, report),
  ];
  for (let i = 0; i < probes.length; i++) {
    try {
      report.checks.push(await probes[i]());
    } catch (err) {
      // 契约：单项检查自身抛错 → 该项 fail，整体不抛（如 db 不可达 → ①fail，错误文本进 detail）
      report.checks.push({ id: i + 1, status: 'fail', detail: `检查异常：${errText(err)}` });
    }
  }
  return report;
}

/**
 * 写 sidecar 到 <ZTK_STATE_DIR>/doctor.json（tmp + rename 原子写；目录不存在则 mkdir -p）。
 *
 * @async
 * @param {DoctorReport} report - runDoctor 的返回值。
 * @param {object} [opts]
 * @param {string} [opts.stateDir] - 覆盖 state 根（测试注入 fixture；否则 ZTK_STATE_DIR，再否则默认
 *   ~/.zcode/zcode-toolkit——注意这是插件自有目录，不是 v2 根）。
 * @returns {Promise<{ path: string }>} 实际写入路径。
 * @throws {Error} 写失败（CLI main 会捕获并 exit 0，不阻断会话；测试中正常断言）。
 */
export async function writeSidecar(report, opts = {}) {
  const dflt = defaultPaths();
  const stateDir = resolvePathOpt(opts.stateDir, 'ZTK_STATE_DIR', dflt.stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  const target = path.join(stateDir, DOCTOR_SIDECAR_NAME);
  const tmp = path.join(stateDir, `.${DOCTOR_SIDECAR_NAME}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return { path: target };
}

/* -------------------------------------------------------------------------
 * CLI 入口（hooks 直接运行本文件；dist/doctor.mjs 为本文件发布拷贝）。
 * 契约：任何异常 → stderr 记录 + exit 0。stdout 属于 hook 协议通道，错误只进 stderr。
 * 实现者注意：不得在此处对 ~/.zcode 之外的任何路径做写动作。
 * ------------------------------------------------------------------------- */
async function main() {
  let report;
  try {
    report = await runDoctor();
  } catch (err) {
    // 兜底：runDoctor 契约上不抛；万一抛，仍构造最小 report 让 sidecar 记录错误（fatal 字段为紧急路径专用）
    console.error('[zcode-toolkit doctor] runDoctor 异常：', errText(err));
    report = {
      ranAt: Date.now(),
      schemaTopId: null,
      checks: [],
      residueDetected: false,
      banner: null,
      env: {
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || null,
      },
      fatal: errText(err),
    };
  }
  try {
    await writeSidecar(report);
  } catch (err) {
    console.error('[zcode-toolkit doctor] sidecar 写失败：', errText(err));
  }
  process.exit(0);
}

// 直接执行守卫（被 import 时不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
