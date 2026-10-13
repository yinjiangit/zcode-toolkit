/**
 * server.mjs —— zcode-toolkit MCP server 入口（stdio；方案 §2.4 组件图 / §2.5「MCP 工具面」）。
 *
 * 进程形态：plugin.json mcpServers.zcode-toolkit → node ${ZCODE_PLUGIN_ROOT}/dist/server.mjs
 * （dist/ 为 src/ 的发布拷贝，无构建步骤）。ui.surfaces id=tps 的面板（ui/dashboard.html）经本 server 的
 * ui:// 资源吐出（showcase 0.4.3 dist/server.mjs registerResources 同款机制，见
 * review/ref/showcase-server-excerpts.md §4）。
 *
 * 零 npm 依赖（方案 §4）：showcase 用 SDK 的 McpServer/StdioServerTransport，本实现按同一线协议
 * （newline-delimited JSON-RPC 2.0 over stdio）手写最小协议层——initialize / notifications/initialized /
 * tools/list / tools/call / resources/list / resources/read / resources/subscribe / unsubscribe / ping。
 * 协议行为对齐 showcase 摘录：能力声明 tools.listChanged + resources.subscribe/listChanged + logging（§1）；
 * 资源只在被订阅后推送 notifications/resources/updated（§4 notifyResourceUpdated：未订阅直接跳过不报错）。
 *
 * env 继承（userConfig 经 plugin.json env 注入）：
 *   ZTK_POLL_SEC（默认 '2'，钳制 ≥1s）——轮询默认节奏（周期推送循环与实时性文案口径）。
 *   ZTK_POLISH_KEY / ZTK_POLISH_BASE_URL（空=走 provider_config.json；由 polish.mjs 自行读取）。
 *   G0-d 落点：启动时把 process.env 里 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 是否存在（以及指向路径——
 *   只记路径形态的值，绝不打印 apiKey）记录到独立 sidecar <stateDir>/g0d.json（S3 处置：单写者文件，
 *   不做 doctor.json 读-改-写——那会与 SessionStart hook 的 writeSidecar 后写者胜，覆盖哨兵报告/现场）。
 *
 * 工具面（六个 ztk_* 工具，全部薄委托——规则与实现一律在被委托模块，本文件不得内联业务逻辑）：
 *   ztk_tps_query(scope?)            → tps.queryTps(scope)          —— scope ∈ {'current','latest_main','all'}，默认 latest_main
 *   ztk_polish(draft, model?, effort_level?) → polish.polish(draft, { modelId, effortLevel })
 *   ztk_models_fetch(base_url, api_key, protocol) → puller.fetchModels({ baseUrl, apiKey, protocol })
 *   ztk_provider_config_apply(selected) → puller.applyProviderConfig(selected)   —— 调用即用户显式确认
 *   ztk_doctor_status()              → doctor.runDoctor()            —— 返回 DoctorReport（只读，不写 sidecar）
 *   ztk_migrate(check_only?)         → check_only!==false ? migrate.checkMigrate() : migrate.runMigrate({confirm:false})
 *                                                                      —— MCP 面上**永不**替用户传 confirm:true，
 *                                                                         破坏性执行只走用户手动 CLI（§1.3 顺序约束）
 *
 * surface 工具（showcase 0.4.3 实证存在的 show_status_banner 同名能力，摘录 §3）：
 *   show_status_banner —— 宿主完成 initialize 握手并自报身份（clientInfo.name 非空或 capabilities 非空）才
 *   注册（tools/list 含它 + tools/call 可调）；未握手/裸探针场景跳过注册，不报错。
 *   「宿主支持」判据的边界如实说明：摘录 §6 证实 getHostCapabilities 是沙箱页 SDK 客户端实例方法
 *   （server.mjs 内联 SDK grep 0 命中）——服务端唯一可见的能力交换 = initialize 握手里对方的
 *   capabilities/clientInfo；banner 支持与否的精确宿主信号【待验证 G0-c 装机实测后接线】，
 *   当前以「自报身份的握手完成」为保守门控。
 *   周期推送：宿主订阅 ui://zcode-tokenspeed/live/tps.json 后，每 ZTK_POLL_SEC 秒推送
 *   notifications/resources/updated（showcase §4 同款）；未订阅 → 跳过本轮推送，绝不报错。
 *
 * getHostCapabilities（照 showcase 用法的能力协商）：initialize 握手后可取，返回
 *   { negotiatedAt, protocolVersion, clientInfo, clientCapabilities, bannerSupported, unsupported }；
 *   同步落盘 <stateDir>/host_capabilities.json（doctor ③ 的 sidecar 契约——hook 进程无 MCP 上下文，
 *   读这份 sidecar）。能力缺失（unsupported 数组）= 明示不支持，绝不假装可用。
 *
 * 错误语义（统一）：被委托模块的具名错误（TpsUnavailableError / PolishError / PullError /
 *   MigrateGateError / ProviderConfigParseError）→ MCP 工具级 error 结果（isError:true + 结构化
 *   code/message），**绝不崩 server 进程**；未知异常 → error 结果 + stderr 记录，进程照常存活。
 *   tools/call 未知名 → JSON-RPC error -32602（Unknown tool，协议级错误）。
 *
 * 路径注入：与被委托模块同一约定（options.env / context.env > process.env 的
 * ZTK_V2_DIR/ZTK_STATE_DIR/ZTK_DB_PATH/ZTK_PLUGINS_CACHE_DIR/ZTK_RESOURCES_DIR > 模块默认真实路径）。
 * 测试全部注入 fixture 路径，绝不触真实 ~/.zcode。
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { queryTps, TpsUnavailableError } from './tps.mjs';
import { polish } from './polish.mjs';
import { fetchModels, applyProviderConfig } from './puller.mjs';
import { runDoctor } from './doctor.mjs';
import { checkMigrate, runMigrate } from './migrate.mjs';

const SERVER_NAME = 'zcode-toolkit';
const SERVER_VERSION = '1.0.0'; // 与 .zcode-plugin/plugin.json version 一致
/** MCP 协议版本：客户端请求值若在已知清单内则回显，否则回落本表最新（协议协商标准行为）。 */
const KNOWN_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** ui:// 资源 URI（plugin.json ui.surfaces[0].resourceUri 指向 DASHBOARD_URI）。 */
const DASHBOARD_URI = 'ui://zcode-tokenspeed/dashboard.html';
const BANNER_URI = 'ui://zcode-tokenspeed/banner.html';
const TPS_LIVE_URI = 'ui://zcode-tokenspeed/live/tps.json';
/** HTML 资源 MIME，showcase server.mjs:37489 同款（profile=mcp-app 即宿主沙箱页标识）。 */
const HTML_MIME = 'text/html;profile=mcp-app';

const TPS_SCOPES = ['current', 'latest_main', 'all'];
const PROTOCOLS = ['anthropic-messages', 'chat-completions', 'responses'];

/** 本 server.mjs 所在目录（src/ 或发布拷贝 dist/）。 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------
 * 路径注入（与被委托模块同一约定的集中实现）
 * ----------------------------------------------------------------------- */

/**
 * 从 env（context.env > process.env 合并视图）挑出已设置且非空白的 ZTK_* 注入路径。
 * @param {object} [context] - { env?: object }
 * @returns {{dbPath?: string, v2Dir?: string, stateDir?: string, pluginsCacheDir?: string, resourcesDir?: string}}
 */
function contextPaths(context = {}) {
  const env = { ...process.env, ...(context.env || {}) };
  const pick = (k) => {
    const v = env[k];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  return {
    dbPath: pick('ZTK_DB_PATH'),
    v2Dir: pick('ZTK_V2_DIR'),
    stateDir: pick('ZTK_STATE_DIR'),
    pluginsCacheDir: pick('ZTK_PLUGINS_CACHE_DIR'),
    resourcesDir: pick('ZTK_RESOURCES_DIR'),
  };
}

/** state 根解析（host_capabilities.json / g0d.json 落点）：入参 env > process.env > 默认。 */
function resolveStateDir(env = process.env) {
  const v = env.ZTK_STATE_DIR;
  if (typeof v === 'string' && v.trim()) return v;
  return path.join(os.homedir(), '.zcode', 'zcode-toolkit');
}

/** 原子写 JSON（tmp + rename；目录不存在则 mkdir -p）。写失败向 stderr 记录但不抛（sidecar 非协议通道）。 */
function writeStateJsonAtomic(stateDir, file, data, stderr) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const target = path.join(stateDir, file);
    const tmp = path.join(stateDir, `.${file}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return target;
  } catch (err) {
    (stderr || process.stderr).write(
      `[${SERVER_NAME}] state 写入失败（${file}）：${err && err.message ? err.message : err}\n`,
    );
    return null;
  }
}

/**
 * G0-d 落点：启动时把 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 是否被插件 server 进程继承
 * 记录到**独立 sidecar <stateDir>/g0d.json**（修 S3：不再对 doctor.json 做读-改-写——
 * 与 SessionStart hook 的 writeSidecar 并发时后写者会以陈旧骨架覆盖对方，且 doctor.json
 * 损坏时起稿重建会覆盖现场；现在 doctor.json 的唯一写者是 doctor hook，server 绝不触碰，
 * 两个 sidecar 各自单写者、各自 tmp+rename 原子写，互不知晓也互不破坏）。
 * 绝不打印/记录 apiKey 形态的值——该 env 是路径指针，只记路径本身与存在性。
 */
function writeG0dObservation(env, stderr) {
  const stateDir = resolveStateDir(env);
  const raw = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  const observation = {
    observedAt: Date.now(),
    source: 'server.mjs startup',
    pid: process.pid,
    envVarSet: typeof raw === 'string' && raw.length > 0,
    envVarPath: typeof raw === 'string' && raw.length > 0 ? raw : null,
  };
  writeStateJsonAtomic(stateDir, 'g0d.json', observation, stderr);
  return observation;
}

/** ZTK_POLL_SEC 解析：正数取整，缺省/非法回落 2（秒）；下限 1。 */
function parsePollSec(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 2;
  return Math.max(1, Math.floor(n));
}

/* -------------------------------------------------------------------------
 * 工具表（六个 ztk_* 恒注册；show_status_banner 按宿主握手门控）
 * ----------------------------------------------------------------------- */

/**
 * @typedef {{name: string, description: string, inputSchema: object, meta?: object,
 *            run: (args: object, context: object) => Promise<{text: string, structured: object}>}} ToolDef
 */

/** @type {ToolDef[]} */
const CORE_TOOLS = [
  {
    name: 'ztk_tps_query',
    description:
      '查询 TPS/用量快照（db.sqlite 只读；默认 scope=latest_main=最新用户主会话）。返回最近完成轮'
        + '（tok/s、TTFT、输入/输出/缓存读）+ 会话累计 + 模型分布；realtime=true 表示最近完成轮 ≤2s 可见'
        + '（G0-a go，P95=1969ms；非 token 级流式）。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: TPS_SCOPES, default: 'latest_main' },
      },
    },
    run: async (args, context) => {
      const scope = args.scope === undefined ? 'latest_main' : args.scope;
      const p = contextPaths(context);
      const snapshot = await queryTps(scope, { dbPath: p.dbPath, sessionId: context.sessionId });
      return { text: tpsSummaryText(snapshot), structured: snapshot };
    },
  },
  {
    name: 'ztk_polish',
    description:
      '润色（增强提示词）一段草稿：走 provider_config.json 凭据外呼模型，返回润色后文本（绝不写回输入框）。'
        + 'model 支持 "providerId/modelId" 或裸 modelId；不传则按解析链（enhance_config.json → provider 默认）。',
    inputSchema: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: '草稿原文（非空）' },
        model: { type: 'string', description: '显式模型（可选）' },
        effort_level: { type: 'string', description: '思考档位（可选，透传 reasoning/effort）' },
      },
      required: ['draft'],
    },
    run: async (args, context) => {
      if (typeof args.draft !== 'string' || !args.draft.trim()) {
        const err = new TypeError('ztk_polish: draft 必须是非空字符串');
        err.code = 'INVALID_INPUT';
        throw err;
      }
      const p = contextPaths(context);
      const result = await polish(args.draft, {
        modelId: args.model,
        effortLevel: args.effort_level,
        v2Dir: p.v2Dir,
      });
      // text = 润色后文本本身（模型消费主载体）；structured 携带完整结果（elapsedMs/modelId 等）
      return { text: result.text, structured: result };
    },
  },
  {
    name: 'ztk_models_fetch',
    description:
      '从模型网关拉取模型清单（/v1/models，双凭据头）。protocol 必须显式三选一（禁止自动探测）；'
        + '返回去重保序的模型条目（含 contextWindow/outputLimit/efforts/defaultEffort 元数据）。',
    inputSchema: {
      type: 'object',
      properties: {
        base_url: { type: 'string', description: '网关 baseURL（如 https://gw.example.com/v1）' },
        api_key: { type: 'string', description: 'API Key（可为空串，由网关决定是否放行）' },
        protocol: { type: 'string', enum: PROTOCOLS },
      },
      required: ['base_url', 'api_key', 'protocol'],
    },
    run: async (args) => {
      const result = await fetchModels({
        baseUrl: args.base_url,
        apiKey: args.api_key,
        protocol: args.protocol,
      });
      const list = result.models.map((m) => m.modelId).join('、');
      return { text: `拉取到 ${result.models.length} 个模型：${list}`, structured: result };
    },
  },
  {
    name: 'ztk_provider_config_apply',
    description:
      '把勾选的拉取结果合并写入 provider_config.json（providerId 精确匹配；读失败中止；先备份再原子写；'
        + 'apiKey 绝不反向覆盖现行 key）。本工具调用即用户显式确认。写入成功文案：已写入，若未即时生效请重启会话。',
    inputSchema: {
      type: 'object',
      properties: {
        selected: {
          type: 'object',
          description:
            '拉取确认结果：{ providerId, baseUrl, protocol, models:[{modelId, contextWindow?, outputLimit?,'
              + ' efforts?, defaultEffort?}], providerName?, apiKey?, apiType? }（形状见'
              + ' src/provider_config_schema.mjs mergeProviderConfig JSDoc）',
        },
      },
      required: ['selected'],
    },
    run: async (args, context) => {
      const p = contextPaths(context);
      const result = await applyProviderConfig(args.selected, { v2Dir: p.v2Dir, stateDir: p.stateDir });
      const s = result.summary;
      const text =
        `已写入，若未即时生效请重启会话。新增 ${s.addedModels.length} 个模型`
        + `（${s.addedModels.join('、') || '无'}），跳过已存在 ${s.skippedExisting.length} 个，`
        + `apiKey ${s.apiKeyWritten ? '已写入（原无 key）' : '未覆盖（已有 key）'}；备份 ${result.backupPath}`;
      return { text, structured: result };
    },
  },
  {
    name: 'ztk_doctor_status',
    description:
      '运行五项哨兵检查（db schema / provider_config / 能力协商 / 插件版本 / 旧补丁残留），返回 DoctorReport。',
    inputSchema: { type: 'object', properties: {} },
    run: async (_args, context) => {
      const p = contextPaths(context);
      const report = await runDoctor(p); // 只读采集；sidecar 由 SessionStart hook 写，本工具不写
      return { text: doctorSummaryText(report), structured: report };
    },
  },
  {
    name: 'ztk_migrate',
    description:
      '旧补丁清退入口（§1.3）。默认 check_only=true 只读盘点（checkMigrate 报告）；check_only=false 时'
        + '仍不执行破坏性动作——confirm 门控只接受用户手动 CLI --confirm（MCP 面永不代传）。',
    inputSchema: {
      type: 'object',
      properties: {
        check_only: { type: 'boolean', default: true },
      },
    },
    run: async (args, context) => {
      const p = contextPaths(context);
      const paths = {
        v2Dir: p.v2Dir,
        stateDir: p.stateDir,
        pluginsCacheDir: p.pluginsCacheDir,
        resourcesDir: p.resourcesDir,
      };
      if (args.check_only === false) {
        // 永不传 confirm:true：runMigrate({confirm:false}) 先于任何变更抛 MigrateGateError（引导文案即结果）
        await runMigrate(paths);
        const err = new Error('UNREACHABLE: runMigrate 未设 confirm 必须抛 MigrateGateError');
        err.code = 'INTERNAL';
        throw err;
      }
      const report = await checkMigrate(paths);
      return { text: migrateSummaryText(report), structured: report };
    },
  },
];

/** banner 工具（门控注册；_meta 逐字段照 showcase server.mjs:37774-37792 的 banner 形态，摘录 §3）。 */
const BANNER_TOOL = /** @type {ToolDef} */ ({
  name: 'show_status_banner',
  description:
    'Show a compact always-visible TPS status banner (last completed turn tok/s/TTFT/tokens + session totals). '
      + 'Content refresh cadence: last completed turn is visible within ZTK_POLL_SEC seconds '
      + '(G0-a: P95=1969ms; not token-level streaming).',
  inputSchema: { type: 'object', properties: {} },
  meta: {
    // showcase §3 同款键名：outputTemplate 指向 banner 资源；widgetCSP 不放行任何外域（面板零外呼）
    'openai/outputTemplate': BANNER_URI,
    'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
    'openai/widgetPrefersBorder': false,
  },
  run: async (_args, context) => {
    const p = contextPaths(context);
    let snapshot;
    try {
      snapshot = await queryTps('latest_main', { dbPath: p.dbPath });
    } catch (err) {
      if (err instanceof TpsUnavailableError || err.name === 'TpsUnavailableError') {
        // tps 契约：降级文案，保留面板历史快照，绝不崩进程
        const degraded = new Error(`TPS 数据源暂不可用（${err.message}）`);
        degraded.code = 'TPS_UNAVAILABLE';
        degraded.degraded = true;
        throw degraded;
      }
      throw err;
    }
    return { text: bannerText(snapshot), structured: snapshot };
  },
});

/* ---------------------------- 摘要文案（人读 text 层） ---------------------------- */

const fmtInt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : String(n));

function fmtTokPerSec(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} tok/s` : '无流式时间戳';
}

function tpsSummaryText(s) {
  const lines = [];
  lines.push(`scope=${s.scope}${s.sessionIdTail ? `（会话尾号 …${s.sessionIdTail}）` : '（未定位会话）'}`);
  if (s.lastCompletedTurn) {
    const t = s.lastCompletedTurn;
    lines.push(
      `最近完成轮 ${t.turnId}：${fmtTokPerSec(t.tokPerSec)} · TTFT ${t.ttftMs == null ? 'N/A' : `${t.ttftMs}ms`}`
        + ` · 入 ${fmtInt(t.inputTokens)} / 出 ${fmtInt(t.outputTokens)} / 缓存读 ${fmtInt(t.cacheReadTokens)}`,
    );
  } else {
    lines.push('最近完成轮：暂无');
  }
  const st = s.sessionTotals;
  lines.push(
    `会话累计：${st.turnCount} 轮（完成 ${st.completedTurnCount} / 取消 ${st.cancelledTurnCount}）`
      + ` · 入 ${fmtInt(st.inputTokens)} / 出 ${fmtInt(st.outputTokens)} / 缓存读 ${fmtInt(st.cacheReadTokens)}`,
  );
  if (s.modelDistribution.length > 0) {
    lines.push(`模型分布：${s.modelDistribution.map((d) => `${d.modelId}×${d.requestCount}`).join('、')}`);
  }
  if (s.degraded) lines.push(`降级说明：${s.degraded}`);
  return lines.join('\n');
}

function bannerText(s) {
  const t = s.lastCompletedTurn;
  const last = t
    ? `${fmtTokPerSec(t.tokPerSec)} · TTFT ${t.ttftMs == null ? 'N/A' : `${t.ttftMs}ms`} · `
      + `入 ${fmtInt(t.inputTokens)} / 出 ${fmtInt(t.outputTokens)} / 缓存读 ${fmtInt(t.cacheReadTokens)}`
    : '最近完成轮暂无';
  const st = s.sessionTotals;
  return (
    `${last}｜会话累计 ${st.completedTurnCount} 轮 · 入 ${fmtInt(st.inputTokens)} · 出 ${fmtInt(st.outputTokens)}`
    + `${s.sessionIdTail ? `｜会话尾号 …${s.sessionIdTail}` : ''}`
  );
}

function doctorSummaryText(report) {
  const lines = [`ranAt ${new Date(report.ranAt).toISOString()}，schemaTopId=${report.schemaTopId}`];
  for (const c of report.checks) lines.push(`[${c.id}] ${c.status}：${c.detail}`);
  if (report.residueDetected && report.banner) lines.push(`banner(${report.banner.level})：${report.banner.text}`);
  return lines.join('\n');
}

function migrateSummaryText(report) {
  const lines = [
    `migrate --check 只读盘点（ranAt ${new Date(report.ranAt).toISOString()}）：`,
    `  zcodeRunning=${report.zcodeRunning}，看护进程 ${report.watchdogProcesses.length} 个`,
    `  客户端版本 ${report.clientVersion ?? '未知'}，sha256 校验目标适用=${report.clientVersionApplies}`,
    `  清退清单 ${report.cleanupPlan.length} 项，v2 残留 ${report.v2Residues.length} 项（只列出不删）`,
    `  兜底重装建议=${report.fallbackReinstall}`,
  ];
  for (const n of report.notes || []) lines.push(`  note: ${n}`);
  lines.push('破坏性执行只走用户手动 CLI --confirm（本工具永不代传）。');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------
 * 单点分发：测试与 stdio 层共用
 * ------------------------------------------------------------------------- */

/**
 * 单点分发：把一次 MCP 工具调用路由到对应模块契约函数（stdio 层与测试共用——测试不经网络直接调本函数）。
 *
 * @async
 * @param {string} name - 工具名，六个 ztk_* 之一（surface 工具名同样经此分发）。
 * @param {object} args - 工具入参（形状见各被委托模块 JSDoc；本函数只做形状最小校验后透传）。
 * @param {object} [context] - { sessionId?: string, env?: object }——sessionId 为 MCP 请求上下文
 *   （extra.sessionId，传输层会话；与 db chat session_id 的映射【待验证 G0-a】，供 tps scope='current' 尝试用，
 *   失败自动回落 latest_main 并在结果 degraded 注明）；env 为路径注入覆盖（合并进 process.env 视图）。
 * @returns {Promise<{text: string, structured: object}>} 业务对象的人读摘要 + 完整结构化结果
 *   （structured 即各模块 JSDoc 声明的返回形状）。
 * @throws {Error} name 不在工具面内 → code='UNKNOWN_TOOL' 的错误；业务错误按模块契约透传
 *   （TpsUnavailableError / PolishError / PullError / MigrateGateError / TypeError…，见模块头错误语义）。
 */
export async function dispatchTool(name, args = {}, context = {}) {
  if (args === null || typeof args !== 'object') args = {};
  if (name === 'show_status_banner') {
    return BANNER_TOOL.run(args, context);
  }
  const tool = CORE_TOOLS.find((t) => t.name === name);
  if (!tool) {
    const err = new Error(`Unknown tool: ${name}（工具面：${CORE_TOOLS.map((t) => t.name).join(', ')}）`);
    err.code = 'UNKNOWN_TOOL';
    throw err;
  }
  return tool.run(args, context);
}

/* -------------------------------------------------------------------------
 * 协议层（newline-delimited JSON-RPC 2.0 over stdio；showcase StdioServerTransport 同款线协议）
 * ------------------------------------------------------------------------- */

/** banner 门控：宿主完成 initialize 握手并自报身份（clientInfo.name 非空 或 capabilities 有键）。
 *  判据边界见模块头「surface 工具」段——精确宿主信号【待验证 G0-c 装机实测后接线】。 */
function bannerSupported(host) {
  if (!host) return false;
  const info = host.clientInfo;
  const caps = host.clientCapabilities;
  const named = info && typeof info === 'object' && typeof info.name === 'string' && info.name.trim();
  const hasCaps = caps && typeof caps === 'object' && Object.keys(caps).length > 0;
  return Boolean(named || hasCaps);
}

/**
 * 读 dashboard 页面本体：优先 <ROOT>/../ui/（本仓 src|dist 与安装态 plugin 根两种布局），
 * 再试 <ROOT>/ui/（showcase 的 dist/ui 布局）。读不到抛带指引的错误。
 */
function readDashboardPage() {
  const candidates = [
    path.join(ROOT, '..', 'ui', 'dashboard.html'),
    path.join(ROOT, 'ui', 'dashboard.html'),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error(`dashboard 页面不可读（试过 ${candidates.join(' ; ')}）——请先跑 scripts/build.mjs 确认发布布局`);
}

/**
 * banner 模板资源：最小静态占位页（真实横幅由宿主按 show_status_banner 工具结果渲染，
 * 【G0-c 装机实测后接线】——showcase banner.html 的宿主渲染/数据注入机制未在摘录中给出，此处不捏造 API）。
 */
function bannerPageHtml() {
  return [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>ztk banner</title></head>',
    '<body style="margin:0;font:12px/1.4 system-ui">',
    '<div style="padding:6px 10px">zcode-tokenspeed TPS 状态条（占位模板：内容由 show_status_banner 工具结果渲染；</div>',
    '<div style="padding:0 10px 6px;color:#888">实时口径：ZTK_POLL_SEC 内刷新最近完成轮，G0-a P95=1969ms）</div>',
    '</body></html>',
  ].join('\n');
}

/**
 * 启动 stdio MCP server（JSON-RPC 循环：initialize / tools/list / tools/call / resources(±subscribe) / ping
 * + surface 能力协商）。发布拷贝为 dist/server.mjs，被 plugin.json 以 node 直启。
 *
 * @async
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.stdin=process.stdin] - 传输输入（测试注入流）。
 * @param {NodeJS.WritableStream} [options.stdout=process.stdout] - 传输输出（测试注入流；注意日志只能进 stderr，
 *   stdout 是协议通道）。
 * @param {object} [options.env=process.env] - 环境覆盖（测试注入 fixture 路径与 userConfig 注入值）。
 * @param {NodeJS.WritableStream} [options.stderr=process.stderr] - 日志通道（测试注入捕获）。
 * @returns {Promise<void>} 常驻不 resolve（直到 stdin 关闭）；resolve/正常退出码 0。
 *   致命初始化错误 → 抛出由调用方（或直接执行入口）转 exit 1——运行中单次工具错误不构成致命（见错误语义）。
 */
export async function startServer(options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const env = { ...process.env, ...(options.env || {}) };
  const pollSec = parsePollSec(env.ZTK_POLL_SEC);

  const logErr = (msg) => stderr.write(`[${SERVER_NAME}] ${msg}\n`);

  // —— G0-d 落点 + 启动摘要（只记键名与路径，绝不打印 apiKey 形态的值）——
  const g0d = writeG0dObservation(env, stderr);
  logErr(
    `startup: pollSec=${pollSec}s（ZTK_POLL_SEC=${JSON.stringify(env.ZTK_POLL_SEC ?? null)}）；`
      + `G0-d ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 继承=${g0d.envVarSet}${g0d.envVarPath ? `（→${g0d.envVarPath}）` : ''}`
      + '；已记入 g0d.json sidecar',
  );
  const ztkKeys = Object.keys(env).filter((k) => k.startsWith('ZTK_')).sort();
  logErr(`startup: env ZTK_* 键=[${ztkKeys.join(', ')}]`);

  /** @type {{ clientInfo: object|null, clientCapabilities: object|null, protocolVersion: string }|null} */
  let host = null;
  const subscribed = new Set();
  /** @type {object|null} 最近一次轮询快照（TPS_LIVE_URI 资源读取的缓存值）。 */
  let liveCache = null;
  let pollTimer = null;
  let lastDegradedLogAt = 0;

  /** 当前生效工具表（六个核心恒在；banner 按门控）。 */
  const activeTools = () => (bannerSupported(host) ? [...CORE_TOOLS, BANNER_TOOL] : CORE_TOOLS);

  /** 能力协商快照（getHostCapabilities 的 server 侧形态；未握手 = null）。 */
  const capabilityRecord = () =>
    host
      ? {
          negotiatedAt: Date.now(),
          protocolVersion: host.protocolVersion,
          clientInfo: host.clientInfo,
          clientCapabilities: host.clientCapabilities,
          bannerSupported: bannerSupported(host),
          unsupported: bannerSupported(host) ? [] : ['show_status_banner'],
        }
      : null;

  /**
   * 能力协商落点（照 showcase 用法；摘录 §6：getHostCapabilities 是沙箱页 SDK 方法，server 侧等价物 =
   * initialize 握手观测），落盘 doctor ③ 消费的能力 sidecar。能力缺失 → unsupported 明示。
   */
  const negotiate = (protocolVersion, clientInfo, clientCapabilities) => {
    host = { clientInfo: clientInfo ?? null, clientCapabilities: clientCapabilities ?? null, protocolVersion };
    const record = capabilityRecord();
    writeStateJsonAtomic(resolveStateDir(env), 'host_capabilities.json', record, stderr);
    if (!record.bannerSupported) {
      logErr(
        'capabilities: 宿主未自报身份（无 clientInfo/capabilities）——show_status_banner 不注册'
          + '（明示不支持，不报错）',
      );
    }
    return record;
  };

  const send = (msg) => stdout.write(`${JSON.stringify(msg)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

  /** 周期推送（showcase §4 notifyResourceUpdated 同款：只对已订阅 URI；TPS 不可用 → 跳过本轮，不报错）。 */
  const pollTick = async () => {
    if (!subscribed.has(TPS_LIVE_URI)) return; // 未订阅 = 宿主不支持该消费形态：静默跳过
    try {
      const p = contextPaths({ env });
      liveCache = await queryTps('latest_main', { dbPath: p.dbPath });
      notify('notifications/resources/updated', { uri: TPS_LIVE_URI });
    } catch (err) {
      if (err && (err instanceof TpsUnavailableError || err.name === 'TpsUnavailableError')) {
        const now = Date.now();
        if (now - lastDegradedLogAt > 60000) {
          lastDegradedLogAt = now;
          logErr(`poll: TPS 数据源暂不可用，本轮跳过推送（${err.message}）`);
        }
        return;
      }
      logErr(`poll: 轮询异常（跳过本轮）：${err && err.message ? err.message : err}`);
    }
  };

  /** tools/call 结果包装（业务成功 / 业务错误 isError:true；未知名 = 协议错误 -32602）。 */
  const callTool = async (id, params) => {
    const name = params && params.name;
    if (typeof name !== 'string') {
      replyError(id, -32602, 'tools/call: params.name 必填');
      return;
    }
    if (!activeTools().some((t) => t.name === name)) {
      replyError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const args = (params && params.arguments) || {};
    try {
      const r = await dispatchTool(name, args, { env, sessionId: params._meta?.sessionId });
      reply(id, { content: [{ type: 'text', text: r.text }], structuredContent: r.structured });
    } catch (err) {
      // 错误语义（模块头）：结构化工具级 error，绝不崩进程
      const code = (err && (err.code || err.name)) || (err instanceof TypeError ? 'INVALID_INPUT' : 'INTERNAL');
      const message = (err && err.message) || String(err);
      if (code === 'INTERNAL') logErr(`tools/call ${name}: ${message}`);
      reply(id, {
        content: [{ type: 'text', text: `${code}: ${message}` }],
        structuredContent: {
          ok: false,
          error: { code, message, pending: err && err.pending, detail: err && err.detail },
        },
        isError: true,
      });
    }
  };

  const readResource = async (id, uri) => {
    if (uri === DASHBOARD_URI) {
      try {
        reply(id, { contents: [{ uri, mimeType: HTML_MIME, text: readDashboardPage() }] });
      } catch (err) {
        replyError(id, -32002, err.message);
      }
      return;
    }
    if (uri === BANNER_URI) {
      reply(id, { contents: [{ uri, mimeType: HTML_MIME, text: bannerPageHtml() }] });
      return;
    }
    if (uri === TPS_LIVE_URI) {
      try {
        let snapshot = liveCache;
        if (!snapshot) {
          const p = contextPaths({ env });
          snapshot = await queryTps('latest_main', { dbPath: p.dbPath }); // 缓存外的即时查询
          liveCache = snapshot;
        }
        reply(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(snapshot) }] });
      } catch (err) {
        replyError(id, -32002, `TPS 数据源暂不可用（${err && err.message ? err.message : err}）`);
      }
      return;
    }
    replyError(id, -32602, `Unknown resource: ${uri}`);
  };

  /** 单条 JSON-RPC 消息处理（请求回包；通知无响应）。 */
  const handleMessage = async (msg) => {
    const isRequest = msg.id !== undefined && msg.id !== null;
    const { method, params } = msg;
    switch (method) {
      case 'initialize': {
        const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
        const version =
          requested && KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
        const record = negotiate(version, params && params.clientInfo, params && params.capabilities);
        reply(msg.id, {
          protocolVersion: version,
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
            logging: {},
          },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'zcode-toolkit：TPS 查询（ztk_tps_query）、草稿润色（ztk_polish）、模型拉取与 provider_config'
            + ' 合并写（ztk_models_fetch → ztk_provider_config_apply）、哨兵（ztk_doctor_status）、旧补丁清退'
            + '（ztk_migrate，破坏性动作只走手动 CLI --confirm）。',
          _meta: { hostCapabilities: record }, // 协商结果冗余一份给握手方（additive，客户端可忽略）
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // 通知无响应
      case 'ping':
        reply(msg.id, {});
        return;
      case 'tools/list':
        reply(msg.id, {
          tools: activeTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.meta ? { _meta: t.meta } : {}),
          })),
        });
        return;
      case 'tools/call':
        await callTool(msg.id, params);
        return;
      case 'resources/list':
        reply(msg.id, {
          resources: [
            { uri: DASHBOARD_URI, name: 'dashboard', mimeType: HTML_MIME, title: 'TPS 监控面板' },
            { uri: BANNER_URI, name: 'banner', mimeType: HTML_MIME, title: 'TPS 状态条模板' },
            { uri: TPS_LIVE_URI, name: 'tps-live', mimeType: 'application/json', title: 'TPS 实时快照' },
          ],
        });
        return;
      case 'resources/read':
        if (!params || typeof params.uri !== 'string') {
          replyError(msg.id, -32602, 'resources/read: params.uri 必填');
          return;
        }
        await readResource(msg.id, params.uri);
        return;
      case 'resources/subscribe':
        if (params && typeof params.uri === 'string') subscribed.add(params.uri);
        reply(msg.id, {}); // showcase §4：无条件 {}（未知 URI 不报错，只是永不推送）
        if (pollTimer == null) pollTimer = setInterval(() => void pollTick(), pollSec * 1000);
        return;
      case 'resources/unsubscribe':
        if (params && typeof params.uri === 'string') subscribed.delete(params.uri);
        reply(msg.id, {});
        return;
      case 'logging/setLevel':
        reply(msg.id, {});
        return;
      default:
        if (isRequest) replyError(msg.id, -32601, `Method not found: ${method}`);
        // 未知通知：忽略（协议宽容；不报错）
    }
  };

  return await new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, terminal: false });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        replyError(null, -32700, `Parse error: ${text.slice(0, 120)}`); // id:null（规范要求）
        return;
      }
      const messages = Array.isArray(msg) ? msg : [msg]; // JSON-RPC batch 容忍
      for (const m of messages) {
        if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
          if (m && m.id !== undefined && (m.result !== undefined || m.error !== undefined)) continue; // 宿主回包，忽略
          if (m && m.id !== undefined) replyError(m.id, -32600, 'Invalid Request');
          continue;
        }
        void handleMessage(m).catch((err) => {
          logErr(`handler ${m.method}: ${err && err.message ? err.message : err}`);
          if (m.id !== undefined && m.id !== null) {
            replyError(m.id, -32603, `Internal error: ${err && err.message ? err.message : err}`);
          }
        });
      }
    });
    const finish = () => {
      if (pollTimer != null) clearInterval(pollTimer);
      rl.close();
      resolve();
    };
    rl.on('close', finish);
    stdin.on('error', (err) => {
      logErr(`stdin error: ${err && err.message ? err.message : err}`);
      finish();
    });
  });
}

/* -------------------------------------------------------------------------
 * 直接执行入口（被 import 时不触发；plugin.json mcpServers 与测试子进程都从这进）
 * ------------------------------------------------------------------------- */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    process.stderr.write(`[${SERVER_NAME}] 致命初始化错误：${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
