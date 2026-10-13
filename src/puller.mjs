/**
 * puller.mjs —— 模型拉取 + provider_config.json 安全写入（IO 层）
 * （方案 §1.1⑧、§2.5 ztk_models_fetch / ztk_provider_config_apply；§5 #2/#3/#5/#10/#11/C1 处置）。
 *
 * 分工边界：合并规则与形状校验的唯一实现在 src/provider_config_schema.mjs（纯函数）；
 * 本模块只做网络拉取 + 读/备份/原子写的 IO 编排，**不得**在本模块重写任何合并规则。
 *
 * 拉取形态（方案 §1.1⑧）：
 *   - 协议类型 protocol ∈ {'anthropic-messages','chat-completions','responses'} —— 面板**显式下拉三选**，
 *     detectFormKind 全文档扫描整体退役（修 B4/§5 #5：旧 zcode-model-puller.js:511-527 无作用域扫描可写错协议）。
 *   - server 单点拉取天然去重 + [...new Set(list)] 双保险（修 §5 #11：旧无桥回退路径 filter(Boolean) 无 Set 去重）。
 *   - 采集网关 default_effort 并随模型条目带出（修 B11/§5 #10：旧 :872 注释自称采集实际只消费 efforts/context/output）。
 *
 * 写入纪律（安全写三原则 + 门控）：
 *   - 只写 <ZTK_V2_DIR>/provider_config.json，**不同步 config.json**（行为变更，方案 §1.1⑧ 显式声明，G0-b 判据）。
 *   - ① 读失败（占用/损坏/**文件不存在**）→ 中止报错，禁止当空配置整体重建覆盖（P0-4 教训）
 *   - ② 备份失败 → 中止；备份写到 <ZTK_STATE_DIR>/backups/provider_config.<时间戳>.<唯一后缀>.json（不污染 v2 根）
 *   - ③ tmp + rename 原子写（V10：Windows 文件锁下失败重试提示，不做破坏性动作）
 *   - 并发防护（修 S1）：进程内互斥（promise 链串行）+ 跨进程锁文件 provider_config.json.ztk-lock
 *     （'wx' 排他创建，超龄破除）；rename 前 mtime 复核，外部改动则重读重合并；tmp/备份名带
 *     pid+毫秒+随机后缀，同秒并发不碰撞。
 *   - ztk_provider_config_apply 工具调用本身即「用户显式确认」（面板确认流勾选后发起）；本模块不另设交互。
 *   - 路径注入：opts.v2Dir > ZTK_V2_DIR > 默认 ~/.zcode/v2；opts.stateDir > ZTK_STATE_DIR > 默认 ~/.zcode/zcode-toolkit。
 *     测试一律注入 fixture 路径，绝不触真实 ~/.zcode/v2。
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  ProviderConfigParseError,
  parseProviderConfig,
  mergeProviderConfig,
  serializeProviderConfig,
} from './provider_config_schema.mjs';

/**
 * 拉取/写入错误（契约类型）。code 枚举（不得增删改义）：
 *   - 'NETWORK'       网络层失败（超时、连接拒绝）
 *   - 'AUTH'          凭据缺失/被拒（401/403）
 *   - 'UPSTREAM'      上游 4xx/5xx（detail.status 携带状态码）
 *   - 'PARSE'         2xx 但响应体不可解析出模型清单
 *   - 'READ_FAILED'   provider_config.json 读失败/形状非法（中止，禁止重建覆盖）
 *   - 'BACKUP_FAILED' 备份失败（中止）
 *   - 'WRITE_FAILED'  原子写失败（中止；不残留半成品——tmp 文件清理后抛）
 *   - 'INVALID_INPUT' selected 入参形状非法
 * 契约：constructor(code, message, detail) —— detail = { status?: number, path?: string, cause?: Error }。
 */
export class PullError extends Error {
  /**
   * @param {'NETWORK'|'AUTH'|'UPSTREAM'|'PARSE'|'READ_FAILED'|'BACKUP_FAILED'|'WRITE_FAILED'|'INVALID_INPUT'} code
   * @param {string} message
   * @param {{ status?: number, path?: string, cause?: Error }} [detail]
   */
  constructor(code, message, detail = {}) {
    super(code + ': ' + message);
    this.name = 'PullError';
    this.code = code;
    this.detail = detail;
  }
}

/** 协议三选（与 provider_config_schema.mjs 同一清单；此处仅做入参门禁，不做协议探测）。 */
const PROTOCOLS = ['anthropic-messages', 'chat-completions', 'responses'];

/** 解析 v2 根：opts.v2Dir > ZTK_V2_DIR > 默认 ~/.zcode/v2（测试一律注入，绝不默认触真实路径跑测试）。 */
function resolveV2Dir(opts) {
  return opts.v2Dir || process.env.ZTK_V2_DIR || join(homedir(), '.zcode', 'v2');
}

/** 解析 state 根：opts.stateDir > ZTK_STATE_DIR > 默认 ~/.zcode/zcode-toolkit（插件自有目录，非 v2 根）。 */
function resolveStateDir(opts) {
  return opts.stateDir || process.env.ZTK_STATE_DIR || join(homedir(), '.zcode', 'zcode-toolkit');
}

/** yyyyMMdd-HHmmss（本地时间）时间戳，用于备份文件名。 */
function backupStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/**
 * 唯一后缀：pid + 毫秒（36 进制）+ 随机 3 字节——同秒并发的 tmp/备份名不碰撞（修 S1：
 * 秒级 backupStamp 同秒两次调用写同一路径，备份相互覆盖 + tmp 双写可交错出损坏 JSON）。
 */
function uniqueStamp() {
  return `${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/* ---------------------------- 并发写防护（修 S1） ---------------------------- */

/** 跨进程锁默认参数：等锁上限 10s；持锁超 30s 视为持有者崩溃残留，允许破锁。 */
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 60;

/**
 * 跨进程互斥锁：排他创建（'wx'）<v2Dir>/provider_config.json.ztk-lock（app.asar.zp-lock 同思路）。
 * 占用方等待重试；超龄（> staleMs）锁判崩溃残留直接破除；超时抛 WRITE_FAILED（本次未写入任何字节）。
 * @returns {Promise<void>} 获得锁；调用方必须在 finally 里 unlink 锁文件。
 */
async function acquireConfigLock(lockPath, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8');
      await handle.close();
      return;
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        /* 已被占用 → 判龄后等待重试 */
      } else {
        throw e;
      }
    }
    let held = true;
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        await unlink(lockPath).catch(() => {}); // 崩溃残留 → 破锁重建
        continue;
      }
    } catch {
      held = false; // 恰好被释放 → 立即重试
    }
    if (!held) continue;
    if (Date.now() >= deadline) {
      throw new PullError(
        'WRITE_FAILED',
        `provider_config.json 写入锁等待超时（${lockPath} 被其它进程持有超过 ${timeoutMs}ms；若确认无写入进行中可手工删除该锁文件后重试）——已中止，本次未写入`,
        { path: lockPath },
      );
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

/** 进程内互斥：串行化本进程内并发的 applyProviderConfig（promise 链；跨进程由锁文件兜底）。 */
let applyChain = Promise.resolve();
function serializeApply(fn) {
  const next = applyChain.then(fn, fn);
  applyChain = next.catch(() => {});
  return next;
}

/**
 * 从 /v1/models 条目对象里提取网关透出的元数据（workbuddy2api 等网关风格，旧 :871 注释点名的键 +
 * 旧消费端 m.context/m.output/m.efforts 别名兼容）。字符串条目 → 无元数据。
 */
function extractModelMeta(item, modelId) {
  const entry = { modelId };
  if (item === null || typeof item !== 'object') return entry;
  const positiveInt = (v) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const contextWindow =
    positiveInt(item.context_length) ??
    positiveInt(item.context_window) ??
    positiveInt(item.max_context_tokens) ??
    positiveInt(item.context);
  const outputLimit =
    positiveInt(item.max_output_tokens) ?? positiveInt(item.max_tokens) ?? positiveInt(item.output);
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  if (outputLimit !== undefined) entry.outputLimit = outputLimit;
  const rawEfforts = Array.isArray(item.supported_efforts)
    ? item.supported_efforts
    : Array.isArray(item.efforts)
      ? item.efforts
      : null;
  if (rawEfforts) {
    const efforts = [...new Set(rawEfforts.map((x) => String(x).trim()).filter(Boolean))];
    if (efforts.length > 0) entry.efforts = efforts;
  }
  const d = item.default_effort ?? item.default_reasoning_effort;
  if (typeof d === 'string' && d.trim()) entry.defaultEffort = d.trim();
  return entry;
}

/**
 * 从网关拉取模型清单（server.mjs 的 ztk_models_fetch 工具直接委托本函数）。
 *
 * @async
 * @param {{ baseUrl: string, apiKey: string, protocol: 'anthropic-messages'|'chat-completions'|'responses' }} input
 *   协议由面板显式下拉提供；本函数不做任何自动协议探测。
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000] - 外呼超时。
 * @returns {Promise<{ models: Array<{
 *   modelId: string,
 *   contextWindow?: number, outputLimit?: number,
 *   efforts?: string[], defaultEffort?: string,   // defaultEffort 采集自网关（修 B11）
 * }>, fetchedAt: number }>}
 *   models 已去重（[...new Set] 按 modelId）且保序（网关返回序）。
 * @throws {PullError} code ∈ {'NETWORK','AUTH','UPSTREAM','PARSE'}。
 */
export async function fetchModels(input, opts = {}) {
  const { baseUrl, apiKey, protocol } = input || {};
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new PullError('INVALID_INPUT', 'baseUrl 必填（非空字符串）');
  }
  if (typeof apiKey !== 'string') {
    throw new PullError('INVALID_INPUT', 'apiKey 必须是字符串（可为空串，由网关决定是否放行）');
  }
  if (!PROTOCOLS.includes(protocol)) {
    throw new PullError(
      'INVALID_INPUT',
      `protocol 必须显式三选一：${PROTOCOLS.join(' / ')}（得到 ${JSON.stringify(protocol)}；禁止自动探测）`,
    );
  }
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 30000;

  // 端点规约：baseUrl 去尾斜杠；已以 /v1 结尾 → 拼 /models，否则拼 /v1/models（旧 :1001 同款）
  const clean = baseUrl.trim().replace(/\/+$/, '');
  const url = clean.endsWith('/v1') ? `${clean}/models` : `${clean}/v1/models`;

  // 双凭据头与旧实现一致：Authorization: Bearer + x-api-key（中转站/anthropic 网关通吃）
  const headers = { Accept: 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new PullError('NETWORK', `网络层失败（${url}）: ${e.message}`, { cause: e });
  }
  if (res.status === 401 || res.status === 403) {
    throw new PullError('AUTH', `凭据缺失/被拒（HTTP ${res.status}）`, { status: res.status });
  }
  if (!(res.status >= 200 && res.status < 300)) {
    throw new PullError('UPSTREAM', `上游返回 HTTP ${res.status}（请检查 baseURL 是否指向模型网关）`, {
      status: res.status,
    });
  }
  let body;
  try {
    body = await res.text();
  } catch (e) {
    throw new PullError('NETWORK', `读取响应体失败: ${e.message}`, { cause: e });
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new PullError('PARSE', `响应体非 JSON: ${body.slice(0, 120)}`, { cause: e });
  }
  const rawList = Array.isArray(data && data.data)
    ? data.data
    : Array.isArray(data && data.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : null;
  if (!rawList) {
    throw new PullError('PARSE', '响应体无可识别的模型清单（data/models/根数组均缺失）');
  }

  // 去重 + 保序（修 §5 #11）：[...new Set] 语义按 modelId，首见位置保留
  const seen = new Set();
  const models = [];
  for (const item of rawList) {
    const modelId =
      typeof item === 'string'
        ? item.trim()
        : item !== null && typeof item === 'object'
          ? String(item.id ?? item.name ?? '').trim()
          : '';
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push(extractModelMeta(item, modelId));
  }
  if (models.length === 0) {
    throw new PullError('PARSE', '模型清单为空（2xx 但未解析出任何条目）');
  }
  return { models, fetchedAt: Date.now() };
}

/** rename 的 Windows 文件锁短重试（EBUSY/EPERM/EACCES，3 次 × 150ms；仍失败由调用方清理 tmp 后抛 WRITE_FAILED）。 */
async function renameWithRetry(from, to) {
  const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE.has(e && e.code)) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastErr;
}

/**
 * 按合并策略写入 provider_config.json（server.mjs 的 ztk_provider_config_apply 工具直接委托本函数；
 * 调用即用户确认，见模块头门控说明）。
 *
 * 流程契约：**跨进程锁 + 进程内互斥（修 S1）** → 读（失败即抛 READ_FAILED，禁止空配置重建）
 * → provider_config_schema.parseProviderConfig → provider_config_schema.mergeProviderConfig（纯合并，
 * 规则见该模块 JSDoc）→ 备份到 <stateDir>/backups/provider_config.<秒级时间戳>.<唯一后缀>.json
 * （失败即抛 BACKUP_FAILED）→ provider_config_schema.serializeProviderConfig → 同目录 tmp（唯一名）
 * + rename 原子写（失败抛 WRITE_FAILED 并清理 tmp）。rename 前复核文件 mtime 与读取时一致——
 * 读取后被外部（如客户端自身，不经我们的锁）改动则重读重合并（≤3 次），仍不稳定即中止不写。
 * 残余窗口说明（如实）：mtime 复核与 rename 之间的毫秒级窗口无法绝对消除；跨进程锁已覆盖全部
 * ztk 写者，复核覆盖到 rename 前一刻的不持锁外部写者。
 *
 * @async
 * @param {object} selected - 拉取确认结果，形状与 mergeProviderConfig 的 selected 入参一致
 *   （见 src/provider_config_schema.mjs JSDoc：providerId 必填为精确匹配键、models[] 带 defaultEffort 等）。
 * @param {object} [opts]
 * @param {string} [opts.v2Dir] - 覆盖 v2 根（测试注入 fixture）。
 * @param {string} [opts.stateDir] - 覆盖 state 根（测试注入 fixture；备份落点）。
 * @param {number} [opts.lockTimeoutMs=10000] - 跨进程锁等待上限（测试可调小）。
 * @param {number} [opts.staleLockMs=30000] - 锁文件超龄破除阈值（测试可调小）。
 * @returns {Promise<{ written: true, backupPath: string, summary: object }>}
 *   summary = mergeProviderConfig 返回的 summary（providerRuleCreated / addedModels / skippedExisting /
 *   apiKeyWritten——面板据此回显「新增 N 模型 / 跳过 M 已存在 / key 未覆盖」）。
 *   写失败/部分失败直接抛错，不返回降级成功（修 §5 #3：旧 writeZCodeConfig 丢弃 res.warn 仍报成功）。
 * @throws {PullError} code ∈ {'READ_FAILED','BACKUP_FAILED','WRITE_FAILED','INVALID_INPUT'}。
 */
export async function applyProviderConfig(selected, opts = {}) {
  // 进程内串行（并发两次调用不再「都报成功、后写者抹掉先写者」）；跨进程由锁文件互斥
  return serializeApply(() => applyProviderConfigSerialized(selected, opts));
}

/** 锁内主流程（applyProviderConfig 的实现；勿直接调用——绕过进程内互斥）。 */
async function applyProviderConfigSerialized(selected, opts = {}) {
  const v2Dir = resolveV2Dir(opts);
  const stateDir = resolveStateDir(opts);
  const configPath = join(v2Dir, 'provider_config.json');
  const lockPath = `${configPath}.ztk-lock`;

  await acquireConfigLock(lockPath, {
    timeoutMs: typeof opts.lockTimeoutMs === 'number' && opts.lockTimeoutMs > 0 ? opts.lockTimeoutMs : LOCK_TIMEOUT_MS,
    staleMs: typeof opts.staleLockMs === 'number' && opts.staleLockMs >= 0 ? opts.staleLockMs : LOCK_STALE_MS,
  });
  try {
    let raw;
    let serialized;
    let backupPath;
    let readMtimeMs;
    let parsed;
    let summary;

    // 读 → 合并 → 备份 → tmp（每轮以「读时 mtime」为基线；写盘后复核，被外部改动则整轮重来）
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      // ① 读失败（不存在/占用/权限）一律中止——绝不把读不到当空配置重建覆盖
      try {
        raw = await readFile(configPath, 'utf8');
      } catch (e) {
        throw new PullError(
          'READ_FAILED',
          `provider_config.json 读取失败（${configPath}）: ${e.message}——已中止，绝不按空配置重建覆盖`,
          { path: configPath, cause: e },
        );
      }
      try {
        readMtimeMs = (await stat(configPath)).mtimeMs;
      } catch (e) {
        throw new PullError('READ_FAILED', `provider_config.json stat 失败: ${e.message}`, {
          path: configPath,
          cause: e,
        });
      }

      // ② 形状校验（JSON 损坏/结构非法同样中止）
      try {
        parsed = parseProviderConfig(raw, { path: configPath });
      } catch (e) {
        if (e instanceof ProviderConfigParseError) {
          throw new PullError(
            'READ_FAILED',
            `provider_config.json 形状非法（pointer ${e.detail.pointer}）: ${e.message}——已中止，禁止重建覆盖`,
            { path: configPath, cause: e },
          );
        }
        throw e;
      }

      // ③ 纯合并（发生在任何落盘动作之前：selected 非法时不产生半成品）
      let merged;
      try {
        merged = mergeProviderConfig(parsed, selected);
      } catch (e) {
        if (e instanceof ProviderConfigParseError) {
          throw new PullError('READ_FAILED', `合并前兜底校验失败: ${e.message}`, {
            path: configPath,
            cause: e,
          });
        }
        throw new PullError('INVALID_INPUT', `selected 入参非法: ${e.message}`, {
          path: configPath,
          cause: e,
        });
      }
      serialized = serializeProviderConfig(merged.next);
      summary = merged.summary;

      // ④ 备份原文件（本轮实际读到的原文；唯一名防同秒碰撞）；失败即中止，原文件分毫未动
      const backupDir = join(stateDir, 'backups');
      backupPath = join(backupDir, `provider_config.${backupStamp()}.${uniqueStamp()}.json`);
      try {
        await mkdir(backupDir, { recursive: true });
        await writeFile(backupPath, raw, 'utf8');
      } catch (e) {
        throw new PullError(
          'BACKUP_FAILED',
          `备份失败（${backupPath}）: ${e.message}——已中止，原文件未改动`,
          { path: backupPath, cause: e },
        );
      }

      // ⑤ tmp + rename 前置：唯一名 tmp 写盘，随后复核 mtime——读取后被外部改动则丢弃本轮重来
      const tmpPath = `${configPath}.${uniqueStamp()}.ztk-tmp`;
      try {
        await writeFile(tmpPath, serialized, 'utf8');
        const mtimeNow = (await stat(configPath)).mtimeMs;
        if (mtimeNow !== readMtimeMs) {
          await unlink(tmpPath).catch(() => {});
          if (attempt >= MAX_ATTEMPTS) {
            throw new PullError(
              'WRITE_FAILED',
              `provider_config.json 在读取后被外部连续改动（${attempt} 次检测到变更），已中止未写入——请稍后重试`,
              { path: configPath },
            );
          }
          continue; // 重读重合并（下一轮备份/ tmp 以新原文为准）
        }
        // ⑥ 原子写（同目录保证同卷 rename 原子性）；失败清理 tmp 后抛，不残留半成品
        await renameWithRetry(tmpPath, configPath);
      } catch (e) {
        if (e instanceof PullError) throw e;
        await unlink(tmpPath).catch(() => {});
        throw new PullError(
          'WRITE_FAILED',
          `原子写失败（${configPath}）: ${e.message}——原文件未受损；若 ZCode 正打开该文件（Windows 文件锁），请关闭设置页/模型弹窗后重试`,
          { path: configPath, cause: e },
        );
      }
      break;
    }

    return { written: true, backupPath, summary };
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
