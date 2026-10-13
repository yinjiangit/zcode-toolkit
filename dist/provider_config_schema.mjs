/**
 * provider_config_schema.mjs —— provider_config.json 形状测绘的代码化 + 合并策略（纯函数，零 IO）
 * （方案 §1.1⑧「写入目标 JSON 形状」「合并策略」两行的唯一实现源；§6 阶段 1 任务项）。
 *
 * 形状测绘（本机 11KB 现文件实测，方案 §1.1⑧ / 附录 A-16）：
 *   顶层：{ schemaVersion: number, config: {...} }
 *   config.providerOrder: string[]
 *   config.providerConfigRules.providerRules[]: {
 *     providerId: string, providerName: string,
 *     config: {
 *       group: string,
 *       access: { type: string, apiKey: string },
 *       api:    { type: string, baseUrl: string },
 *       personalModelIds: string[],
 *       modelOrder: string[],
 *     },
 *   }
 *   config.modelConfigRules.providerModelRules[]: {
 *     modelId: string, providerId: string,
 *     config: {
 *       properties: { contextWindow: number, /* …其余属性原样保留 *\/ },
 *       optionSpecs: { reasoningLevel: { values: string[], map: string /* CEL 字符串 *\/ } },
 *     },
 *   }
 *   config.modelConfigRules.manualProviderModelRules[]: 同 providerModelRules 形状（用户手工覆盖区）
 *   实测 invariant：optionSpecs.reasoningLevel 只有 values + map，**无 default 键**——
 *   默认档由 values 排序承载（「末位即默认」，宿主行为【待验证 V7】）。
 *
 * 实测补充 invariant（本机现文件二次核直读，2026-10-13）：
 *   - providerId 以 'account:' 开头的套餐/登录态供应商：rule 只有 { providerId, config{ personalModelIds,
 *     modelOrder } }，无 providerName/group/access/api，且**不出现在 providerOrder**（归宿主账号体系管）。
 *   - 普通 api.type 实测值域：'openai-chat-completions' | 'openai-responses' | 'anthropic-messages'
 *     —— protocol → api.type 映射据此推导。
 *   - account: rule 的 modelOrder 可包含 personalModelIds 之外的服务端下发模型（实测 1 vs 3），
 *     两个列表各自独立保序追加、互不裁剪/互不重建。
 *
 * 本模块是纯模块：不 import node:fs、不读不写任何文件。IO（原子写/备份）在 puller.mjs；
 * 测试直接用 fixture JSON 字符串驱动，绝不触真实 ~/.zcode/v2。
 */

/**
 * 形状非法错误（读失败/损坏必须中止，禁止当空配置整体重建覆盖——P0-4 纪律在解析层的体现）。
 * 契约：constructor(message, detail) —— detail = { path?: string, pointer: string }，pointer 为 JSON 指针式定位
 * （如 '/config/providerConfigRules'），供面板把错误指到具体字段。
 */
export class ProviderConfigParseError extends Error {
  /**
   * @param {string} message
   * @param {{ path?: string, pointer: string }} detail
   */
  constructor(message, detail) {
    super(message);
    this.name = 'ProviderConfigParseError';
    this.detail = detail;
  }
}

/** 协议三选（§1.1⑧ 显式下拉，禁止自动探测——修 B4/§5 #5）。 */
const PROTOCOLS = ['anthropic-messages', 'chat-completions', 'responses'];

/** protocol → provider_config api.type（值域来自本机现文件实测：openai-* / anthropic-messages）。 */
const PROTOCOL_TO_API_TYPE = {
  'anthropic-messages': 'anthropic-messages',
  'chat-completions': 'openai-chat-completions',
  'responses': 'openai-responses',
};

/**
 * reasoningLevel.map（CEL 字符串）按协议取默认——沿用旧 zcode-model-puller.js:880-882 的两分支字面值
 * （anthropic → thinking 开关 + effort；其余 → reasoning_effort 透传）。仅在条目缺失 map 时兜底写入，
 * 不反向覆盖既有 map（与 api.type 同一守卫哲学）。
 */
const MAP_BY_PROTOCOL = {
  'anthropic-messages':
    "reasoningLevel=='off' ? {'thinking':{'type':'disabled'}} : {'thinking':{'type':'adaptive'},'output_config':{'effort':reasoningLevel}}",
  'chat-completions': "{'reasoning_effort':reasoningLevel}",
  'responses': "{'reasoning_effort':reasoningLevel}",
};

/** 网关未透出 efforts 时的保守档位模板（旧 zcode-model-puller.js:875 同款）。 */
const DEFAULT_EFFORT_VALUES = ['off', 'low', 'high', 'max'];

/** @returns {boolean} v 是否普通对象（非 null/数组）。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 抛形状非法错误（统一带上 meta.path 与 JSON 指针）。 */
function failShape(message, pointer, meta) {
  throw new ProviderConfigParseError(message, { path: meta && meta.path, pointer });
}

/**
 * 结构校验（parse 与 merge 共用的兜底防御）。
 * 宽严边界：stub 契约点名的必抛项——根对象/schemaVersion(number)/config、providerOrder（若存在必须数组）、
 * providerRules、providerModelRules、manualProviderModelRules 数组性、rule 的 providerId/modelId 关键键。
 * 未知字段一律原样保留不裁剪（兼容宿主演进）；providerOrder 允许整个缺失（merge 会回填），
 * 但存在且非数组必须抛——静默当空回填等于丢弃既有顺序数据（P0-4 同源风险）。
 */
function assertValidProviderConfig(config, meta = {}) {
  if (!isPlainObject(config)) failShape('配置根必须是 JSON 对象', '', meta);
  if (typeof config.schemaVersion !== 'number' || !Number.isFinite(config.schemaVersion)) {
    failShape('schemaVersion 缺失或非 number', '/schemaVersion', meta);
  }
  if (!isPlainObject(config.config)) failShape('config 缺失或非对象', '/config', meta);
  const c = config.config;
  if (c.providerOrder !== undefined && !Array.isArray(c.providerOrder)) {
    failShape('providerOrder 存在但非数组', '/config/providerOrder', meta);
  }
  if (!isPlainObject(c.providerConfigRules)) {
    failShape('providerConfigRules 缺失或非对象', '/config/providerConfigRules', meta);
  }
  const rules = c.providerConfigRules.providerRules;
  if (!Array.isArray(rules)) {
    failShape('providerRules 非数组', '/config/providerConfigRules/providerRules', meta);
  }
  rules.forEach((rule, i) => {
    const base = `/config/providerConfigRules/providerRules/${i}`;
    if (!isPlainObject(rule)) failShape(`providerRules[${i}] 非对象`, base, meta);
    if (typeof rule.providerId !== 'string' || !rule.providerId.trim()) {
      failShape(`providerRules[${i}] 缺 providerId`, `${base}/providerId`, meta);
    }
    if (rule.config !== undefined && rule.config !== null && !isPlainObject(rule.config)) {
      failShape(`providerRules[${i}].config 非对象`, `${base}/config`, meta);
    }
  });
  if (!isPlainObject(c.modelConfigRules)) {
    failShape('modelConfigRules 缺失或非对象', '/config/modelConfigRules', meta);
  }
  const mcr = c.modelConfigRules;
  if (!Array.isArray(mcr.providerModelRules)) {
    failShape('providerModelRules 非数组', '/config/modelConfigRules/providerModelRules', meta);
  }
  if (!Array.isArray(mcr.manualProviderModelRules)) {
    failShape('manualProviderModelRules 非数组', '/config/modelConfigRules/manualProviderModelRules', meta);
  }
  const checkModelRule = (arr, name) => {
    arr.forEach((rule, i) => {
      const base = `/config/modelConfigRules/${name}/${i}`;
      if (!isPlainObject(rule)) failShape(`${name}[${i}] 非对象`, base, meta);
      if (typeof rule.modelId !== 'string' || !rule.modelId.trim()) {
        failShape(`${name}[${i}] 缺 modelId`, `${base}/modelId`, meta);
      }
      if (typeof rule.providerId !== 'string' || !rule.providerId.trim()) {
        failShape(`${name}[${i}] 缺 providerId`, `${base}/providerId`, meta);
      }
      if (rule.config !== undefined && rule.config !== null && !isPlainObject(rule.config)) {
        failShape(`${name}[${i}].config 非对象`, `${base}/config`, meta);
      }
    });
  };
  checkModelRule(mcr.providerModelRules, 'providerModelRules');
  checkModelRule(mcr.manualProviderModelRules, 'manualProviderModelRules');
}

/**
 * 解析并校验 provider_config.json 文本（不合规即抛错，绝不静默容错降级为空对象）。
 *
 * @param {string} rawJson - 文件原文（UTF-8 文本）。
 * @param {object} [meta] - { path?: string } 仅用于错误定位回显。
 * @returns {object} 校验通过的配置对象（结构如模块头测绘；未知字段原样保留，不裁剪——兼容宿主演进）。
 * @throws {ProviderConfigParseError} JSON 语法错误、缺 schemaVersion/config、providerRules/
 *   providerModelRules/manualProviderModelRules 非数组、rule 缺 providerId/modelId 等关键键。
 *   调用方（puller）收到本错误必须中止写入并向用户报错，禁止重建覆盖。
 */
export function parseProviderConfig(rawJson, meta = {}) {
  if (typeof rawJson !== 'string') failShape('输入必须是字符串（UTF-8 文件原文）', '', meta);
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    failShape(`JSON 语法错误: ${e.message}`, '', meta);
  }
  assertValidProviderConfig(parsed, meta);
  return parsed;
}

/** selected（拉取确认结果）形状校验——入参错误直接抛普通 Error，不产生半成品。 */
function assertValidSelected(selected) {
  if (!isPlainObject(selected)) throw new Error('selected 必须是对象');
  if (typeof selected.providerId !== 'string' || !selected.providerId.trim()) {
    throw new Error('selected.providerId 必填（非空字符串；rule 匹配键 = providerId 精确匹配）');
  }
  if (typeof selected.baseUrl !== 'string' || !selected.baseUrl.trim()) {
    throw new Error('selected.baseUrl 必填（非空字符串）');
  }
  if (!PROTOCOLS.includes(selected.protocol)) {
    throw new Error(
      `selected.protocol 必须显式三选一：${PROTOCOLS.join(' / ')}（得到 ${JSON.stringify(selected.protocol)}；禁止自动探测）`,
    );
  }
  if (!Array.isArray(selected.models)) throw new Error('selected.models 必须是数组');
  selected.models.forEach((m, i) => {
    if (!isPlainObject(m)) throw new Error(`selected.models[${i}] 必须是对象`);
    if (typeof m.modelId !== 'string' || !m.modelId.trim()) {
      throw new Error(`selected.models[${i}].modelId 必填（非空字符串）`);
    }
    if (m.efforts !== undefined && !Array.isArray(m.efforts)) {
      throw new Error(`selected.models[${i}].efforts 若提供必须是 string[]`);
    }
    if (m.defaultEffort !== undefined && typeof m.defaultEffort !== 'string') {
      throw new Error(`selected.models[${i}].defaultEffort 若提供必须是 string`);
    }
    for (const k of ['contextWindow', 'outputLimit']) {
      if (m[k] !== undefined && (typeof m[k] !== 'number' || !Number.isFinite(m[k]))) {
        throw new Error(`selected.models[${i}].${k} 若提供必须是有限 number`);
      }
    }
  });
  if (selected.providerName !== undefined && typeof selected.providerName !== 'string') {
    throw new Error('selected.providerName 若提供必须是 string');
  }
  if (selected.apiKey !== undefined && typeof selected.apiKey !== 'string') {
    throw new Error('selected.apiKey 若提供必须是 string');
  }
  if (selected.apiType !== undefined && typeof selected.apiType !== 'string') {
    throw new Error('selected.apiType 若提供必须是 string');
  }
}

/**
 * 计算 reasoningLevel.values：网关档位去重保序 → 无档位用保守模板 → 补 'off'（无思考档）→
 * defaultEffort 挪到**末位**（「末位即默认」，修 B11/§5 #10；不写 default 键）。
 */
function computeReasoningValues(efforts, defaultEffort) {
  let base = Array.isArray(efforts)
    ? [...new Set(efforts.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  if (base.length === 0) base = [...DEFAULT_EFFORT_VALUES];
  if (!base.includes('off')) base = ['off', ...base];
  const d = typeof defaultEffort === 'string' ? defaultEffort.trim() : '';
  if (d) {
    base = base.filter((x) => x !== d);
    base.push(d);
  }
  return base;
}

/**
 * 纯合并：把一次拉取确认结果合并进现有配置，返回新配置对象（不修改入参，不落盘）。
 *
 * 合并策略（方案 §1.1⑧，逐条对应必修项）：
 *   - rule 匹配键 = providerId **精确匹配**，不做 baseURL 模糊兜底（修 C1：旧 model_pull.py:301-308/:327-329
 *     可把一个供应商的模型写进共享同 baseURL 的另一供应商规则；回归测试必须覆盖「两供应商共享 baseURL」场景）。
 *   - 新增供应商：push 新 providerRule + providerOrder 追加（不重排既有顺序）。
 *   - 已有供应商：仅向 personalModelIds / modelOrder 追加缺失项，保序，不整体重建。
 *   - apiKey 仅目标 rule 的 access.apiKey 无值/空时写入（修 P1-2：旧 zcode_patcher.py:1350 无条件反向覆盖）。
 *   - optionSpecs：写入 providerModelRules 中 (modelId, providerId) 对应条目；reasoningLevel 只写
 *     values + map，不写 default 键；defaultEffort 的载体 = 把对应档排到 values **末位**（修 B11/§5 #10）。
 *   - manualProviderModelRules 为用户手工覆盖区：本函数不改动该数组。
 *
 * @param {object} existing - parseProviderConfig 的合法返回值。
 * @param {object} selected - 拉取确认结果，形状：
 *   {
 *     providerId: string,            // 必填，精确匹配键
 *     providerName?: string,
 *     baseUrl: string,
 *     apiKey?: string,               // 仅目标 rule 无 key 时才会被采用
 *     apiType?: string,              // 如缺省且目标 rule 为新建，默认按 protocol 推导
 *     protocol: 'anthropic-messages'|'chat-completions'|'responses',
 *     models: Array<{
 *       modelId: string,
 *       contextWindow?: number,
 *       outputLimit?: number,
 *       efforts?: string[],          // 网关档位清单
 *       defaultEffort?: string,      // 网关默认档 → 排 values 末位
 *     }>,
 *   }
 * @returns {{ next: object, summary: {
 *     providerId: string,
 *     providerRuleCreated: boolean,
 *     addedModels: string[],         // 新写入 personalModelIds/modelOrder 的 modelId（保序列）
 *     skippedExisting: string[],     // 已存在跳过的 modelId
 *     apiKeyWritten: boolean,        // 本次是否实际写入 apiKey（false=已有 key 不反覆盖）
 *   } }}
 * @throws {ProviderConfigParseError} existing 形状非法（调用方应先 parseProviderConfig，此处兜底防御）。
 * @throws {Error} selected 形状非法（缺 providerId/models/modelId 等必填键）——入参错误直接抛，不产生半成品。
 */
export function mergeProviderConfig(existing, selected) {
  assertValidProviderConfig(existing, {});
  assertValidSelected(selected);

  const next = structuredClone(existing); // 不修改入参
  const cfg = next.config;
  if (!Array.isArray(cfg.providerOrder)) cfg.providerOrder = [];
  const rules = cfg.providerConfigRules.providerRules;
  const modelRules = cfg.modelConfigRules.providerModelRules;
  // 手工覆盖区：命中的 (providerId, modelId) 不写自动条目（manual 优先，数组本身绝不改动）
  const manualKeys = new Set(
    cfg.modelConfigRules.manualProviderModelRules.map((m) => `${m.providerId}\u0000${m.modelId}`),
  );

  const pid = selected.providerId.trim();
  const isAccount = pid.startsWith('account:');
  let rule = rules.find((r) => r.providerId === pid) || null; // 精确匹配，无 baseURL 兜底（修 C1）

  // 空模型清单不创建新 rule（沿用旧 fix「严禁自动复活已删除条目」守卫）
  const providerRuleCreated = !rule && selected.models.length > 0;
  if (providerRuleCreated) {
    rule = isAccount
      ? {
          providerId: pid,
          providerName: selected.providerName || pid,
          config: { personalModelIds: [], modelOrder: [] }, // 接入字段归宿主账号体系管
        }
      : {
          providerId: pid,
          providerName: selected.providerName || pid,
          config: {
            group: 'standard-personal',
            access: { type: 'api-key' },
            api: {},
            personalModelIds: [],
            modelOrder: [],
          },
        };
    rules.push(rule);
  }

  const addedModels = [];
  const skippedExisting = [];
  let apiKeyWritten = false;

  if (rule) {
    if (!isPlainObject(rule.config)) rule.config = {};
    const c = rule.config;

    if (!isAccount) {
      // —— 接入字段：account: 供应商一律不写（group/access/api 归账号体系管，塞了会被当成普通自定义供应商）
      if (typeof c.group !== 'string' || !c.group) c.group = 'standard-personal';
      if (!isPlainObject(c.access)) c.access = {};
      if (typeof c.access.type !== 'string' || !c.access.type) c.access.type = 'api-key';
      if (!isPlainObject(c.api)) c.api = {};
      // baseUrl 仅新建 rule 时写入；既有 rule 不反向覆盖（用户可能在设置页改过镜像地址）
      if (providerRuleCreated && selected.baseUrl.trim()) c.api.baseUrl = selected.baseUrl.trim();
      // apiKey 仅目标 rule 无值时写入（修 P1-2：绝不反向覆盖现行 key）
      const hasKey = typeof c.access.apiKey === 'string' && c.access.apiKey.length > 0;
      if (!hasKey && typeof selected.apiKey === 'string' && selected.apiKey.length > 0) {
        c.access.apiKey = selected.apiKey;
        apiKeyWritten = true;
      }
      // api.type 仅缺失时兜底，禁止反向覆盖（实测 openai-responses 被拉平成 chat-completions 走错协议）
      if (!c.api.type) {
        const t =
          typeof selected.apiType === 'string' && selected.apiType.trim()
            ? selected.apiType.trim()
            : PROTOCOL_TO_API_TYPE[selected.protocol];
        if (t) c.api.type = t;
      }
    }

    // —— 模型清单：两个列表各自独立保序追加，绝不按本次 ids 过滤重建/裁剪
    //    （account: 的列表含服务端下发模型，实测被旧逻辑裁掉导致套餐模型消失；普通供应商同理不裁）
    if (!Array.isArray(c.personalModelIds)) c.personalModelIds = [];
    if (!Array.isArray(c.modelOrder)) c.modelOrder = [];
    for (const m of selected.models) {
      const mid = m.modelId.trim();
      if (c.personalModelIds.includes(mid)) {
        skippedExisting.push(mid);
      } else {
        c.personalModelIds.push(mid);
        addedModels.push(mid);
      }
      if (!c.modelOrder.includes(mid)) c.modelOrder.push(mid);
    }

    // —— providerModelRules：account: 的模型规则归宿主客户端管理——只保留既有条目，不裁剪也不替它新增
    if (!isAccount) {
      for (const m of selected.models) {
        const mid = m.modelId.trim();
        if (manualKeys.has(`${pid}\u0000${mid}`)) continue; // 手工覆盖优先
        const efforts = Array.isArray(m.efforts) ? m.efforts : null;
        const entry =
          modelRules.find((e) => e && e.providerId === pid && e.modelId === mid) || null;
        if (!entry) {
          const properties = {};
          properties.contextWindow =
            typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : 1000000;
          if (typeof m.outputLimit === 'number' && m.outputLimit > 0) {
            properties.outputLimit = m.outputLimit;
          }
          modelRules.push({
            modelId: mid,
            providerId: pid,
            config: {
              properties,
              optionSpecs: {
                reasoningLevel: {
                  values: computeReasoningValues(efforts, m.defaultEffort),
                  map: MAP_BY_PROTOCOL[selected.protocol],
                },
              },
            },
          });
        } else {
          if (!isPlainObject(entry.config)) entry.config = {};
          const ec = entry.config;
          if (!isPlainObject(ec.properties)) ec.properties = {};
          if (typeof m.contextWindow === 'number' && m.contextWindow > 0) {
            ec.properties.contextWindow = m.contextWindow;
          }
          if (typeof m.outputLimit === 'number' && m.outputLimit > 0) {
            ec.properties.outputLimit = m.outputLimit;
          }
          const hasReasoning =
            isPlainObject(ec.optionSpecs) && isPlainObject(ec.optionSpecs.reasoningLevel);
          if (efforts && efforts.length > 0) {
            // 网关透出档位 → 重排 values（defaultEffort 末位）；map 仅缺失时兜底，不反向覆盖
            if (!isPlainObject(ec.optionSpecs)) ec.optionSpecs = {};
            if (!isPlainObject(ec.optionSpecs.reasoningLevel)) ec.optionSpecs.reasoningLevel = {};
            const rl = ec.optionSpecs.reasoningLevel;
            rl.values = computeReasoningValues(efforts, m.defaultEffort);
            if (typeof rl.map !== 'string' || !rl.map) rl.map = MAP_BY_PROTOCOL[selected.protocol];
          } else if (!hasReasoning) {
            // 无网关档位且条目本无 reasoningLevel → 保守模板（既有 values 绝不降级覆盖）
            if (!isPlainObject(ec.optionSpecs)) ec.optionSpecs = {};
            ec.optionSpecs.reasoningLevel = {
              values: computeReasoningValues(null, undefined),
              map: MAP_BY_PROTOCOL[selected.protocol],
            };
          }
        }
      }
    }
  }

  // —— providerOrder 回填：凡 providerRules 里出现而 order 缺失的 providerId 一律补到末尾（不重排）。
  //    实测客户端重建 order 时可能漏项，漏掉的供应商带全部模型从界面消失（旧 fix 0.6.19 防御）。
  //    account: 不回填——本机现文件实测 account: 规则不在 providerOrder（归宿主账号体系管理）。
  const order = cfg.providerOrder;
  for (const r of rules) {
    if (!r || typeof r.providerId !== 'string' || !r.providerId) continue;
    if (r.providerId.startsWith('account:')) continue;
    if (!order.includes(r.providerId)) order.push(r.providerId);
  }

  return {
    next,
    summary: { providerId: pid, providerRuleCreated, addedModels, skippedExisting, apiKeyWritten },
  };
}

/**
 * 序列化为稳定 JSON 文本（写盘前的最后一步；puller 以 tmp+rename 原子写落盘）。
 *
 * @param {object} config - 合并后的配置对象。
 * @returns {string} JSON.stringify(config, null, 2) + '\n'（2 空格缩进、保留键序、尾随换行——与宿主可读格式对齐；
 *   schemaVersion 等数值原样保留，不做升版/降版）。
 */
export function serializeProviderConfig(config) {
  return JSON.stringify(config, null, 2) + '\n';
}
