/**
 * polish.mjs —— 增强提示词：模型解析链 + 外呼润色（方案 §1.1⑦、§2.5 ztk_polish；§5 #1/#4/#9/#12 处置）。
 *
 * 模型调用全部在本插件 server 进程（node）外呼 API；本模块绝不写输入框、无 DOM 访问
 * （§5 #4 形态消失：面板「粘贴 → 润色 → 复制」流由调用侧拿返回文本自行处理）。
 *
 * 模型解析链（与旧链的差异显式声明，方案 §1.1⑦）：
 *   ① 入参 options.modelId 显式指定（≈旧 explicit 档）
 *   ② <ZTK_V2_DIR>/enhance_config.json 热配置持久项（≈旧 config 档；每次调用重读、改文件即生效——
 *      旧现场 zcode_patcher.py:1511 同款行为；文件不存在=跳过此档，首次持久化选择时新建）
 *   ③ provider_config.json 实时供应商/模型清单默认
 *      （供应商凭据的唯一权威来源 = provider_config.json，客户端自己就是从这里发请求——旧注释 :1504 原文口径）
 *   ④ 链尽 → 抛 PolishError{code:'NO_MODEL'} 附引导文案（提示去面板拉取/配置模型），不静默兜底。
 *   旧链 ref/ref-label/label 三档依赖读取客户端界面模型选择器 DOM，插件 server 无 DOM 访问，不复刻（行为变更，如实标注）。
 *   「配置校验」与「实际调用」必须共用 resolvePolishModel 这一个匹配函数（修 §5 #12：旧 enhance_doctor.py:255 与 handler 不同源）。
 *
 * 凭据：默认从 provider_config.json 取目标供应商 access.apiKey 与 api.baseUrl；
 *   env ZTK_POLISH_KEY / ZTK_POLISH_BASE_URL（userConfig polish_key / polish_base_url 经 plugin.json env 注入）
 *   仅作显式覆盖，空字符串 = 不覆盖、完全走 provider_config.json。
 *
 * 重试语义（修 P0-2；旧现场 zcode_patcher.py:1730-1739：重试 Promise 的 r2.on("end") 无条件
 * resolve({success:!1,...})，无 2xx 分支——重试成功被当失败丢弃）：
 *   失败重试一次；重试分支必须复用首试的响应处理逻辑——2xx 必须解析 choices/content 并返回成功结果。
 *   回归测试必须覆盖「首试失败、重试返回 200+choices」→ success（test/ 下用本地假服务器 fixture）。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/* -------------------------------------------------------------------------
 * 内部常量：提示词模板（legacy/zcode_patcher.py:1477-1488 _ENHANCE_SYSTEM_PROMPT /
 * _ENHANCE_USER_TEMPLATE 原文照搬——生产验证过的口径，不在重构中改写文案）。
 * ------------------------------------------------------------------------- */
const SYSTEM_PROMPT =
  'You are a Prompt Engineering Expert specializing in improving user prompts for a development code assistant. ' +
  'Analyze the given prompt and produce a more effective version while keeping its core purpose.\n' +
  'RULES:\n' +
  '1. Language matching is the highest priority: reply in exactly the same language as the user\'s input (Chinese stays Chinese, English stays English, mixed stays mixed).\n' +
  '2. Keep the enhanced prompt concise (roughly under 800 characters).\n' +
  '3. Do NOT answer the request, do NOT explain how, do NOT add guides, do NOT suggest specific technologies unless the user mentioned them.\n' +
  '4. Output only the enhanced prompt — no preface, no commentary, no markdown fences.';

const USER_TEMPLATE =
  'USER INPUT:\n{input}\n\nTASK:\n' +
  'Rewrite the user input into a clearer, more specific prompt for the target AI assistant. Preserve intent, topic, constraints and expected output type.\n' +
  'CRITICAL - LANGUAGE CONSISTENCY: write the enhanced prompt in the same language as the user input; never include language analysis or language labels in the output.\n' +
  'REQUIREMENTS: return only the enhanced prompt text; make a substantive enhancement (clarify task, scope, constraints, expected output); if it is already clear, lightly polish it; keep it complete and concise (no dangling list or trailing colon).';

/** 重试退避（毫秒）。legacy zcode_patcher.py:1736 非 rate 类失败统一 600ms，保持同款。 */
const RETRY_BACKOFF_MS = 600;

/**
 * 润色错误（契约类型：server 据此向面板/命令返回结构化错误，不裸抛字符串）。
 * code 枚举（契约，不得增删改义）：
 *   - 'NO_MODEL'  解析链四档全尽，无可润色模型（附引导文案）
 *   - 'AUTH'      凭据缺失/被拒（401/403）
 *   - 'NETWORK'   网络层失败（超时、连接拒绝）
 *   - 'UPSTREAM'  上游 4xx/5xx（detail.status 携带状态码）
 *   - 'PARSE'     2xx 但响应体不可解析出文本
 * 契约：constructor(code, message, detail) —— detail = { status?: number, modelId?: string, cause?: Error }。
 */
export class PolishError extends Error {
  /**
   * @param {'NO_MODEL'|'AUTH'|'NETWORK'|'UPSTREAM'|'PARSE'} code
   * @param {string} message
   * @param {{ status?: number, modelId?: string, cause?: Error }} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PolishError';
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------
 * 路径与热配置读取（内部）
 * ------------------------------------------------------------------------- */

/** v2 根解析：入参 > ZTK_V2_DIR > 默认 ~/.zcode/v2（knowledge.mjs 全局约定）。 */
function resolveV2Dir(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  const fromEnv = process.env.ZTK_V2_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
  return join(homedir(), '.zcode', 'v2');
}

/** 读 JSON 文件。返回 {status:'ok', data} | {status:'missing'} | {status:'failed', cause}——不抛。 */
async function readJsonFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'failed', cause: err };
  }
  try {
    return { status: 'ok', data: JSON.parse(raw) };
  } catch (err) {
    return { status: 'failed', cause: err };
  }
}

/**
 * 读 enhance_config.json 热配置（每次调用重读，改文件即生效——legacy :1511 同款）。
 * 返回 {} 表示该档跳过（文件不存在 / providerId 与 modelId 未同时给出——legacy ⓪ 档口径）。
 * 读失败/JSON 损坏 → 抛 PARSE 中止（不静默跳档：否则用户「以为选了模型」实际仍走旧档，
 * 正是 legacy save-handler 注释里点名的静默失败陷阱）。
 * @returns {Promise<{providerId?: string, modelId?: string, maxTokens?: number, temperature?: number, reasoningEffort?: string, thinkingBudget?: number}>}
 */
async function readEnhanceConfig(v2Dir) {
  const r = await readJsonFile(join(v2Dir, 'enhance_config.json'));
  if (r.status === 'missing') return {};
  if (r.status === 'failed') {
    throw new PolishError(
      'PARSE',
      'enhance_config.json 读失败或 JSON 损坏（' + join(v2Dir, 'enhance_config.json') + '）：' +
        ((r.cause && r.cause.message) || String(r.cause)) +
        '。请修复该文件（合法 JSON，含 {"providerId":"…","modelId":"…"}）或删除它以恢复默认链。',
      { cause: r.cause }
    );
  }
  let cfg = r.data;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return {}; // 形状不对视为未配置（legacy 同款宽容）
  const providerId = String(cfg.providerId || '').trim();
  const modelId = String(cfg.modelId || '').trim();
  if (!providerId || !modelId) return {}; // 两键必须同时给出（legacy ⓪ 档口径）
  return {
    providerId,
    modelId,
    maxTokens: Number(cfg.maxTokens) || 0,
    temperature: cfg.temperature == null ? undefined : Number(cfg.temperature),
    reasoningEffort: String(cfg.reasoningEffort || '').trim().toLowerCase(),
    thinkingBudget: Number(cfg.thinkingBudget) || 0,
  };
}

/* -------------------------------------------------------------------------
 * provider_config.json 归一化（内部；只读消费视角）
 *
 * 与 puller/provider_config_schema 的分工：本模块是**读侧消费者**，只归一化出候选表
 * （legacy zcode_patcher.py:1520-1540 同款归一化），不做写入路径的强 schema 校验——
 * 写侧强校验（schemaVersion 等）是 provider_config_schema.parseProviderConfig 的职责。
 * 但纪律一致（P0-4 同族）：文件**存在**而读失败/JSON 损坏/依赖的结构键类型非法 → 抛 PARSE
 * 中止，禁止当空配置静默继续；文件不存在 = 合法的「未配置」→ 空候选表。
 * 结构键类型非法的判定线（只判本模块依赖的形状）：config/providerConfigRules/
 * modelConfigRules 为非对象、providerRules/providerModelRules/manualProviderModelRules 为非数组。
 * 单条 rule 缺 providerId/modelId → 跳过该条（legacy :1522 `if(!pid2)continue` 同款）。
 * ------------------------------------------------------------------------- */

/**
 * @typedef {Object} ProviderCandidate
 * @property {string} providerId
 * @property {string} providerName
 * @property {string} apiKey       access.apiKey（可能为空串 → 不可用）
 * @property {string} baseUrl      api.baseUrl（可能为空串 → 不可用）
 * @property {string} apiType      api.type 原文（决定请求形态：含 'anthropic' → anthropic-messages）
 * @property {string[]} modelIds   personalModelIds + providerModelRules/manualProviderModelRules 中该供应商的 modelId（保序去重）
 */

/** 候选可用 = apiKey 与 baseUrl 都非空（legacy usable() 口径：缺一必然 400/401，不如不选）。 */
function isUsableProvider(cand) {
  return !!cand.apiKey.trim() && !!cand.baseUrl.trim();
}

/**
 * 归一化 provider_config.json 为候选表。
 * @param {string} v2Dir
 * @returns {Promise<{order: ProviderCandidate[]}>}
 *   order = providerOrder 优先、未列者按 rule 文件序、builtin:/account: 垫底
 *   （legacy ④ 兜底档的排序纪律：内置/套餐供应商要么没 key 要么归属他人，优先选会再踩 400）。
 * @throws {PolishError} code='PARSE'：文件存在但读失败/JSON 损坏/依赖结构键类型非法。
 */
async function loadProviderCandidates(v2Dir) {
  const path = join(v2Dir, 'provider_config.json');
  const r = await readJsonFile(path);
  if (r.status === 'missing') return { order: [] };
  if (r.status === 'failed') {
    throw new PolishError(
      'PARSE',
      'provider_config.json 读失败或 JSON 损坏（' + path + '）：' +
        ((r.cause && r.cause.message) || String(r.cause)) +
        '。润色不会在配置不可读时静默当空配置继续（P0-4 同族纪律）；请修复该文件后重试。',
      { cause: r.cause }
    );
  }
  // 兼容 {schemaVersion, config:{…}} 与裸 config 对象两种顶层（legacy `d=>d&&d.config?d.config:d` 同款）
  const parsed = r.data;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PolishError('PARSE', 'provider_config.json 顶层不是对象（' + path + '）。', {});
  }
  const cfg = parsed.config !== undefined ? parsed.config : parsed;
  if (cfg === undefined || cfg === null) {
    return { order: [] };
  }
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new PolishError('PARSE', 'provider_config.json 的 config 不是对象（' + path + '）。', {});
  }

  const assertObject = (v, pointer) => {
    if (v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))) {
      throw new PolishError('PARSE', 'provider_config.json 形状非法：' + pointer + ' 应为对象（' + path + '）。', {});
    }
  };
  const assertArray = (v, pointer) => {
    if (v !== undefined && v !== null && !Array.isArray(v)) {
      throw new PolishError('PARSE', 'provider_config.json 形状非法：' + pointer + ' 应为数组（' + path + '）。', {});
    }
  };
  assertObject(cfg.providerConfigRules, '/config/providerConfigRules');
  const pcr = cfg.providerConfigRules || {};
  assertArray(pcr.providerRules, '/config/providerConfigRules/providerRules');
  assertObject(cfg.modelConfigRules, '/config/modelConfigRules');
  const mcr = cfg.modelConfigRules || {};
  assertArray(mcr.providerModelRules, '/config/modelConfigRules/providerModelRules');
  assertArray(mcr.manualProviderModelRules, '/config/modelConfigRules/manualProviderModelRules');

  // providerId → modelId[]（providerModelRules + manualProviderModelRules，保序不去重——合并时统一去重）
  const providerModels = new Map();
  for (const rule of [...(mcr.providerModelRules || []), ...(mcr.manualProviderModelRules || [])]) {
    if (!rule || typeof rule !== 'object') continue;
    const pid = String(rule.providerId || '');
    const mid = String(rule.modelId || '');
    if (!pid || !mid) continue;
    if (!providerModels.has(pid)) providerModels.set(pid, []);
    providerModels.get(pid).push(mid);
  }

  const candidates = [];
  const byId = new Map();
  for (const rule of pcr.providerRules || []) {
    if (!rule || typeof rule !== 'object') continue;
    const pid = String(rule.providerId || '');
    if (!pid || byId.has(pid)) continue;
    const c = rule.config || {};
    const access = c.access || {};
    const api = c.api || {};
    const ids = [];
    const seen = new Set();
    for (const id of [...(Array.isArray(c.personalModelIds) ? c.personalModelIds : []), ...(providerModels.get(pid) || [])]) {
      const s = String(id || '').trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        ids.push(s);
      }
    }
    const cand = {
      providerId: pid,
      providerName: String(rule.providerName || pid),
      apiKey: String(access.apiKey || ''),
      baseUrl: String(api.baseUrl || ''),
      apiType: String(api.type || ''),
      modelIds: ids,
    };
    candidates.push(cand);
    byId.set(pid, cand);
  }

  // 排序视图：providerOrder 优先（文件序），未列者按 rule 序，builtin:/account: 一律垫底（legacy ④ 档纪律）
  const declared = Array.isArray(cfg.providerOrder)
    ? cfg.providerOrder.map((p) => String(p || '')).filter(Boolean)
    : [];
  const declaredSet = new Set(declared);
  const ordered = [];
  for (const pid of declared) if (byId.has(pid)) ordered.push(byId.get(pid));
  for (const cand of candidates) if (!declaredSet.has(cand.providerId)) ordered.push(cand);
  const isBuiltinish = (pid) => /^(builtin:|account:)/.test(pid);
  const order = [
    ...ordered.filter((c) => !isBuiltinish(c.providerId)),
    ...ordered.filter((c) => isBuiltinish(c.providerId)),
  ];
  return { order };
}

/* -------------------------------------------------------------------------
 * 凭据覆盖（userConfig polish_key / polish_base_url 经 plugin.json env 注入；
 * 仅显式覆盖，空字符串 = 完全走 provider_config.json——方案 §1.1⑦ userConfig 行）
 * ------------------------------------------------------------------------- */
function applyCredentialOverrides(resolved) {
  const env = process.env;
  const key = typeof env.ZTK_POLISH_KEY === 'string' ? env.ZTK_POLISH_KEY.trim() : '';
  const base = typeof env.ZTK_POLISH_BASE_URL === 'string' ? env.ZTK_POLISH_BASE_URL.trim() : '';
  return {
    ...resolved,
    apiKey: key || resolved.apiKey,
    baseUrl: base || resolved.baseUrl,
  };
}

/** NO_MODEL 引导文案的引导部分（去向 = 面板拉取/写热配置/设覆盖，§1.1⑦ ④）。 */
function guidanceText(v2Dir) {
  return (
    '引导：① 打开面板「模型拉取」填 baseURL/apiKey 拉取并确认写入 provider_config.json' +
    '（ztk_models_fetch → ztk_provider_config_apply）；' +
    '② 或在 ' + join(v2Dir, 'enhance_config.json') + ' 写 {"providerId":"…","modelId":"…"} 指定默认润色模型（每次调用热读，改文件即生效）；' +
    '③ 或在插件设置里配置 polish_key / polish_base_url 显式覆盖凭据。'
  );
}

/** NO_MODEL 完整文案（前缀 + 引导）。prefix 说明本次是链尽还是显式指定命不中。 */
function noModelMessage(prefix, v2Dir) {
  return prefix + guidanceText(v2Dir);
}

/**
 * 解析本次润色所用模型与凭据（单一匹配函数，校验与调用同源）。
 *
 * 解析链实现细节（与 legacy 六档的对应关系，§1.1⑦）：
 *   ① explicit：options.modelId 支持 "providerId/modelId"（legacy explicit/ref 档的 pid+mid 对）与裸 modelId
 *      （在候选表模型清单里定位所属供应商）两种形态。**解析失败不静默落档**：显式指定是用户意图，
 *      换一个模型静默顶替正是本次重构要消灭的行为——直接抛 NO_MODEL 并在 message 说明命不中的原因。
 *      pid/mid 形态只校验供应商可用性、不校验模型表成员（legacy explicit 档口径：允许中转站模型变体名）。
 *   ② enhance_config：providerId+modelId 同时给出且供应商可用才命中（模型表成员同样不校验——legacy ⓪ 档口径）；
 *      指向的供应商不可用/不存在时**落档到 ③**（legacy ⓪ 档 miss 后继续走兜底，行为保持）。
 *   ③ provider 默认：order 视图里第一个「可用且有 ≥1 模型」的供应商，取其模型表第一项
 *      （personalModelIds 优先、模型 rule 追随——legacy :1673 `Object.keys(models)[0]` 口径）。
 *
 * @async
 * @param {object} [options]
 * @param {string} [options.modelId] - 显式模型（解析链①；面板选择传入）。
 * @param {string} [options.v2Dir] - 覆盖 v2 根（测试注入 fixture；否则读 ZTK_V2_DIR，再否则默认 ~/.zcode/v2）。
 * @returns {Promise<{modelId: string, source: 'explicit'|'enhance_config'|'provider_config', apiKey: string, baseUrl: string, providerId: string, apiType: string}>}
 *   source 标明命中链的哪一档（面板据此回显）。providerId/apiType 为契约四字段之外的增加字段：
 *   polish() 构造请求（anthropic-messages vs chat-completions 形态、回显供应商）必需，
 *   不改变契约既有字段的语义（诚实标注的实现扩展）。
 * @throws {PolishError} code='NO_MODEL'：四档全尽（message 含引导文案）；
 *   code='PARSE'：provider_config.json 存在但形状非法（读失败中止报错，禁止当空配置继续——P0-4 同族纪律）。
 */
export async function resolvePolishModel(options = {}) {
  const v2Dir = resolveV2Dir(options.v2Dir);
  const { order } = await loadProviderCandidates(v2Dir);
  const usable = (c) => c && isUsableProvider(c);

  // ① 显式指定：命不中即抛 NO_MODEL，**不静默落档**（显式指定是用户意图，换模型静默顶替正是
  //    本次重构要消灭的行为）。message 说明命不中的具体原因 + 引导文案。
  const explicitRaw = typeof options.modelId === 'string' ? options.modelId.trim() : '';
  if (explicitRaw) {
    let reason = '';
    const slash = explicitRaw.indexOf('/');
    if (slash > 0) {
      const pid = explicitRaw.slice(0, slash);
      const mid = explicitRaw.slice(slash + 1);
      const cand = order.find((c) => c.providerId === pid);
      if (usable(cand)) {
        return applyCredentialOverrides({
          modelId: mid,
          source: 'explicit',
          apiKey: cand.apiKey,
          baseUrl: cand.baseUrl,
          providerId: cand.providerId,
          apiType: cand.apiType,
        });
      }
      reason = cand
        ? '供应商「' + pid + '」缺 apiKey/baseUrl，不可用'
        : '供应商「' + pid + '」不在 provider_config.json 中';
    } else {
      const hit = order.find((c) => usable(c) && c.modelIds.includes(explicitRaw));
      if (hit) {
        return applyCredentialOverrides({
          modelId: explicitRaw,
          source: 'explicit',
          apiKey: hit.apiKey,
          baseUrl: hit.baseUrl,
          providerId: hit.providerId,
          apiType: hit.apiType,
        });
      }
      reason = order.some((c) => c.modelIds.includes(explicitRaw))
        ? '模型「' + explicitRaw + '」在清单中，但所属供应商缺 apiKey/baseUrl'
        : '模型「' + explicitRaw + '」不在任何供应商的模型清单中，无法定位所属供应商';
    }
    throw new PolishError(
      'NO_MODEL',
      noModelMessage('显式指定的润色模型不可用：' + reason + '。', v2Dir),
      { modelId: explicitRaw }
    );
  }

  // ② enhance_config.json 热配置（每次调用重读；指向不可用供应商时落档 ③——legacy 口径）
  const cfg = await readEnhanceConfig(v2Dir);
  if (cfg.providerId && cfg.modelId) {
    const cand = order.find((c) => c.providerId === cfg.providerId);
    if (usable(cand)) {
      return applyCredentialOverrides({
        modelId: cfg.modelId,
        source: 'enhance_config',
        apiKey: cand.apiKey,
        baseUrl: cand.baseUrl,
        providerId: cand.providerId,
        apiType: cand.apiType,
      });
    }
  }

  // ③ provider_config.json 默认：order 视图里第一个「可用且有模型」的供应商 + 其模型表第一项
  //   （builtin:/account: 已在 order 视图中垫底）
  const def = order.find((c) => isUsableProvider(c) && c.modelIds.length > 0);
  if (def) {
    return applyCredentialOverrides({
      modelId: def.modelIds[0],
      source: 'provider_config',
      apiKey: def.apiKey,
      baseUrl: def.baseUrl,
      providerId: def.providerId,
      apiType: def.apiType,
    });
  }

  // ④ 链尽：抛 NO_MODEL + 引导文案（不静默兜底）
  throw new PolishError(
    'NO_MODEL',
    noModelMessage(
      '没有可用的润色模型：解析链已全尽（显式未指定；enhance_config ' +
        (cfg.providerId ? '指向不可用的「' + cfg.providerId + '」' : '未配置') +
        '；provider_config.json 中没有 apiKey+baseUrl 齐全且带模型的供应商）。',
      v2Dir
    ),
    {}
  );
}

/* -------------------------------------------------------------------------
 * 请求构造与响应处理（legacy :1659-1712 形态照搬；响应处理为**单一函数**，
 * 首试与重试共用——P0-2 修复的核心结构）
 * ------------------------------------------------------------------------- */

/** api.type → 请求形态（legacy zkind() 口径：含 anthropic → anthropic-messages；其余统一 chat-completions 形态）。 */
function requestKindOf(apiType) {
  return String(apiType || '').toLowerCase().indexOf('anthropic') >= 0
    ? 'anthropic-messages'
    : 'chat-completions';
}

/** 候选地址列表（legacy :1676-1678：baseURL 末尾去斜杠；不含 /v1 则补；openai 形态保留裸拼接备选；去重保序——§5 #11 纪律）。 */
function endpointCandidates(baseUrl, kind) {
  const u = String(baseUrl || '').replace(/\/+$/, '');
  if (kind === 'anthropic-messages') {
    return [ (u.endsWith('/v1') ? u : u + '/v1') + '/messages' ];
  }
  return [
    (u.endsWith('/v1') ? u : u + '/v1') + '/chat/completions',
    u + '/chat/completions',
  ];
}

/**
 * 从 2xx 响应体提取润色文本（legacy :1707-1712 逐分支照搬）：
 *   choices[0].message.content → choices[0].text → content[].text 连接（anthropic 形态）→ output_text（responses 形态）。
 */
function extractReplyText(j) {
  let out = '';
  if (j && Array.isArray(j.choices) && j.choices[0]) {
    const m0 = j.choices[0].message || {};
    out = String(m0.content || '');
    if (!out && typeof j.choices[0].text === 'string') out = j.choices[0].text;
  }
  if (!out && j && Array.isArray(j.content)) out = j.content.map((c) => String((c && c.text) || '')).join('');
  if (!out && j && typeof j.output_text === 'string') out = j.output_text;
  return String(out || '').trim();
}

/** 非 2xx 时从响应体尽力取出人读错误信息（legacy :1717 同款尽力而为）。 */
function extractErrorMessage(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const m = (j && ((j.error && (j.error.message || j.error)) || j.message)) || '';
    return typeof m === 'string' ? m : JSON.stringify(m);
  } catch {
    return String(bodyText || '').slice(0, 200);
  }
}

/**
 * 响应处理（**首试与重试共用同一函数**——修 P0-2 的结构性保证，不靠两处写一样的代码）。
 * @returns {{text: string}} 2xx 且解析出非空文本。
 * @throws {PolishError} AUTH（401/403）/ UPSTREAM（其余非 2xx，detail.status 携带状态码）/ PARSE（2xx 但解析不出文本）。
 */
function processResponse(status, bodyText, modelId) {
  if (status >= 200 && status < 300) {
    let j = null;
    try {
      j = JSON.parse(bodyText);
    } catch (err) {
      throw new PolishError('PARSE', '响应解析失败（HTTP ' + status + '）：' + ((err && err.message) || err), {
        status,
        modelId,
        cause: err,
      });
    }
    const text = extractReplyText(j);
    if (!text) {
      throw new PolishError('PARSE', '模型返回了空内容（HTTP ' + status + '）', { status, modelId });
    }
    return { text };
  }
  const msg = extractErrorMessage(bodyText);
  if (status === 401 || status === 403) {
    throw new PolishError(
      'AUTH',
      '凭据被拒（HTTP ' + status + (msg ? '：' + msg : '') + '）。API Key 无效、过期或无权限（注意密钥可能必须来自该 endpoint 的同源账号）。',
      { status, modelId }
    );
  }
  throw new PolishError('UPSTREAM', 'HTTP ' + status + (msg ? '：' + msg : ''), { status, modelId });
}

/** 单次外呼（fetch + 超时中断；网络层异常统一归 NETWORK——含超时/连接拒绝）。 */
async function attemptOnce(url, payload, headers, timeoutMs, modelId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: ac.signal,
    });
    const bodyText = await res.text();
    return processResponse(res.status, bodyText, modelId); // 抛出的 PolishError 原样上抛
  } catch (err) {
    if (err instanceof PolishError) throw err;
    const reason = err && err.name === 'AbortError' ? '请求超时（' + timeoutMs + 'ms）' : (err && err.message) || String(err);
    throw new PolishError('NETWORK', '外呼失败：' + reason, { modelId, cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/** 瞬时失败判定（stub 契约口径：NETWORK 或 UPSTREAM≥500 才重试；429/其余 4xx 不重试）。 */
function isRetryable(err) {
  return err instanceof PolishError && (err.code === 'NETWORK' || (err.code === 'UPSTREAM' && err.detail && err.detail.status >= 500));
}

const sleep = (ms) => new Promise((z) => setTimeout(z, ms));

/**
 * 润色主入口（server.mjs 的 ztk_polish 工具直接委托本函数；面板粘贴流与 /polish 命令共用）。
 *
 * 调用循环（P0-2 修复的落点）：按候选地址逐个尝试；瞬时失败（NETWORK / UPSTREAM≥500）在
 * **最后一个候选地址**上退避 600ms 后原地重试一次；重试与首试走同一个 attemptOnce →
 * processResponse——重试拿到 2xx 必然解析 choices/content 并返回成功（旧 bug 的回归重点）。
 *
 * @async
 * @param {string} draft - 用户草稿原文（非空字符串；空串抛 code='NO_MODEL' 之外的标准 TypeError 由调用侧先验，本函数假定非空）。
 * @param {object} [options]
 * @param {string} [options.modelId] - 显式模型（解析链①）。
 * @param {string} [options.effortLevel] - 思考档位（可选；透传给上游 reasoning/effort 参数）。
 * @param {string} [options.v2Dir] - 覆盖 v2 根（测试注入 fixture）。
 * @param {number} [options.timeoutMs=120000] - 外呼超时。
 * @returns {Promise<{text: string, modelId: string, effortLevel: string|null, elapsedMs: number}>}
 *   text = 润色后文本（仅返回，绝不自动写回任何输入框）。
 * @throws {PolishError} code ∈ {'NO_MODEL','AUTH','NETWORK','UPSTREAM','PARSE'}，见 PolishError 契约。
 *   重试语义：瞬时失败（NETWORK/UPSTREAM≥500）重试一次；重试 2xx 必须按成功解析返回（P0-2 修复项，见模块头）。
 */
export async function polish(draft, options = {}) {
  if (typeof draft !== 'string' || !draft.trim()) {
    // 契约假定调用侧已先验；此处仅防御式同款校验（标准 TypeError，不是 PolishError）。
    throw new TypeError('polish(draft): draft 必须是非空字符串');
  }
  const startedAt = Date.now();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000;
  const v2Dir = resolveV2Dir(options.v2Dir);

  // 解析链与凭据：与校验同源（resolvePolishModel 是唯一匹配函数——§5 #12）
  const resolved = await resolvePolishModel({ modelId: options.modelId, v2Dir });

  // 思考档位：入参 effortLevel > enhance_config.reasoningEffort（legacy :1669-1671 热配置口径）
  const cfg = await readEnhanceConfig(v2Dir); // 已在解析链读过一次；重读保持「每次调用热读」语义且与链②一致
  const effort = String(options.effortLevel || '').trim().toLowerCase() || cfg.reasoningEffort || '';
  const kind = requestKindOf(resolved.apiType);

  // 请求体（legacy :1660-1692 参数口径：maxTokens 下限 256 默认 2048；temperature 默认 0.3）
  const cfgMax = Math.max(256, Number(cfg.maxTokens) || 2048);
  const cfgTemp =
    cfg.temperature == null || Number.isNaN(Number(cfg.temperature)) ? 0.3 : Number(cfg.temperature);
  const user = USER_TEMPLATE.split('{input}').join(draft);
  let body;
  if (kind === 'anthropic-messages') {
    body = { model: resolved.modelId, max_tokens: cfgMax, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] };
    const tb = Number(cfg.thinkingBudget) || 0;
    if (effort || tb > 0) {
      const budget = Math.max(1024, Math.min(32768, tb || 8192));
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(cfgMax, budget + 1024);
    }
  } else {
    body = {
      model: resolved.modelId,
      stream: false,
      temperature: cfgTemp,
      max_tokens: cfgMax,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    };
    if (effort) body.reasoning_effort = effort;
  }
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + resolved.apiKey,
    'x-api-key': resolved.apiKey,
  };

  // —— 调用循环：多候选地址 + 末位原地重试一次；重试复用首试响应处理（P0-2）——
  const candidates = [...new Set(endpointCandidates(resolved.baseUrl, kind))];
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const isLast = i === candidates.length - 1;
    try {
      const r = await attemptOnce(candidates[i], payload, headers, timeoutMs, resolved.modelId);
      return {
        text: r.text,
        modelId: resolved.modelId,
        effortLevel: effort || null,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err; // 不可重试：立即失败（AUTH/4xx/PARSE）
      if (!isLast) continue; // 还有候选地址：先换地址（legacy 换地址优先于退避重试）
      await sleep(RETRY_BACKOFF_MS);
      // ★ 原地重试一次——同一 attemptOnce/processResponse：2xx 必解析 choices/content 返回成功
      const r2 = await attemptOnce(candidates[i], payload, headers, timeoutMs, resolved.modelId);
      return {
        text: r2.text,
        modelId: resolved.modelId,
        effortLevel: effort || null,
        elapsedMs: Date.now() - startedAt,
      };
      // 重试仍失败 → attemptOnce 抛出的 PolishError 直接向上（不再重试）
    }
  }
  throw lastErr; // 循环正常走完才会到这（continue 耗尽候选）；防御式兜底
}
