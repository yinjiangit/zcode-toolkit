/**
 * tps.mjs —— TPS 数据源：db.sqlite 只读轮询 + 指标计算 + 会话作用域过滤
 * （方案 §1.1⑤ 规格、§2.5 ztk_tps_query；G0-a 实测勘误已并入，来源 review/g0/g0a-report.md）。
 *
 * 数据源：~/.zcode/cli/db/db.sqlite，node:sqlite 只读连接（readOnly:true），WAL 并发读已证安全
 * （g0a：210.8s / 105 次轮询 0 错误）。任何代码路径禁止写库。
 * 路径注入：opts.dbPath > process.env.ZTK_DB_PATH > 默认 ~/.zcode/cli/db/db.sqlite。
 *
 * 【G0-a 勘误——与方案 §1.1⑤ 字面不同的正确实现，以此为准】
 * turn_usage 表【没有 query_source 列】（26 列实测）；query_source 在 model_usage（40 列）。
 * 会话作用域过滤必须两步走：
 *   ① 低频解析「当前用户主会话 id」（结果缓存 ≥30s；或「最新轮所属会话 ≠ 缓存会话」时触发重解析，
 *      免费搭车检测会话切换）。g0 实测 SQL：
 *      SELECT session_id FROM model_usage
 *       WHERE query_source='main_turn' AND session_id NOT LIKE 'sess_dwf-%'
 *       ORDER BY started_at DESC LIMIT 1;
 *      佐证：main_turn ∧ sess_dwf-% 命中 0 会话（排除条件零误伤）；subagent 行全部独立前缀
 *      sess_subagent_agent_*，不会混入用户主会话聚合。此解析查询 ~6ms 且随 model_usage 增长线性变慢 → 必须缓存。
 *   ② 每 ZTK_POLL_SEC（默认 2s，userConfig poll_sec 注入）对已解析 session_id 直查 turn_usage：
 *      PK (session_id, turn_id) 最左前缀可用（实测 avg 0.02~0.04ms），无需全表聚合。
 *
 * 指标口径（单一时钟源 = 库内时间戳，方案 §1.1⑤；修 §5 #7 混用两时钟源）：
 *   - tok/s = output_tokens / ((completed_at - first_token_at) / 1000)
 *   - TTFT  = time_to_first_token_ms 直读
 *   - NULL 容忍：库中存在 status='completed' 但 first_token_at/TTFT 为 NULL 的完成轮（g0 基准表 #2）
 *     → tokPerSec/ttftMs 返回 null，不得报错、不得以 0 充数。
 *
 * 实时性口径（G0-a 判定 go，P95=1969ms ≤ 3s）：banner 文案统一为「2s 内刷新最近完成轮」；
 * 不存在流式中途 token 增长（105 次轮询 0 观测），不得假装 token 级流式数字。
 *
 * 多会话并发语义：「最新 main_turn 会话」在用户同时开多个聊天窗口时指向最新活跃者——
 * 返回 sessionIdTail 供面板标注，让用户可察觉统计错位（g0a §4 建议）。
 *
 * 会话累计口径（修 §5 #6：与 DOM 生命周期无关）：turn_usage 按 session_id 聚合（scope='all' 时为全表），
 * turnCount 含 cancelled；completedTurnCount/cancelledTurnCount 同时给出，由展示层决定 banner「轮数」口径。
 *
 * 实现说明（相对 stub 契约的补充，非偏离语义）：
 *   - 全部查询走 ORDER BY started_at DESC LIMIT 主路径或 session_id=? 点查（方案 §6 G0-a ②成本结论）。
 *   - schema 哨兵：SELECT id FROM schema_migration ORDER BY time_applied DESC LIMIT 1（顶部=最新；
 *     id 伴随的 app_version 是 db 内部版本，哨兵以 id 为准——g0a §1 勘误）。
 *   - modelDistribution 不过滤 query_source：面板语义是「该会话的模型请求分布」，compact 等
 *     非 main_turn 请求也是该会话的真实模型请求（g0 基准：主会话 115 请求 = 114 main_turn + 1 compact）。
 *   - resolveMainSessionId 在「无任何用户主会话」时抛 TpsUnavailableError（info.schemaTopId 带哨兵观测值）；
 *     queryTps 同场景不抛，返回零值快照 + degraded 说明（数据源可用、只是没数据，不该吓用户）。
 */

import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { KNOWN_SCHEMA_MIGRATIONS, isKnownSchema } from './knowledge.mjs';

/** @internal 知识表依赖注入缝：生产路径恒为 knowledge.isKnownSchema（下方立即绑定），测试可整体替换。
 *  存在原因：knowledge.mjs 由哨兵工程师并行实现（stub 阶段 isKnownSchema 抛 TODO），
 *  本模块测试需要确定性验证「哨兵判定不通过 → 抛 TpsUnavailableError」这一自身逻辑；
 *  测试另有 identity 断言保证默认绑定就是 knowledge.isKnownSchema。 */
export const _internal = { isKnownSchema };

const SCOPES = /** @type {const} */ (['current', 'latest_main', 'all']);
const DEFAULT_RESOLVE_CACHE_MS = 30000;

/** 主会话解析结果缓存（g0a §6：解析查询 ~6ms 且随表增长，必须缓存；键=解析后的 db 路径）。
 *  @type {Map<string, { sessionId: string, resolvedAt: number }>} */
const mainSessionCache = new Map();

/** 解析出用户主会话的 g0 实测 SQL（p7_final_sql.mjs FINAL_SCOPE，逐字一致）。 */
const SQL_RESOLVE_MAIN_SESSION = `
  SELECT session_id
  FROM model_usage
  WHERE query_source = 'main_turn'
    AND session_id NOT LIKE 'sess_dwf-%'
  ORDER BY started_at DESC
  LIMIT 1`;

/**
 * schema 漂移 / 数据源不可用错误（契约类型：调用方按 instanceof 或 error.name 识别，走降级路径，不崩进程）。
 * 契约：constructor(message, info) —— info = { schemaTopId?: string|null, dbPath: string, cause?: Error }。
 */
export class TpsUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {{ schemaTopId?: string | null, dbPath: string, cause?: Error }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'TpsUnavailableError';
    this.info = info;
  }
}

/* -------------------------------------------------------------------------
 * 内部工具（全部纯同步——node:sqlite 为同步 API，导出函数按契约保持 async 形态）
 * ----------------------------------------------------------------------- */

/** 路径解析优先级：入参 > ZTK_DB_PATH > 默认 ~/.zcode/cli/db/db.sqlite。 */
function resolveDbPath(explicit) {
  if (explicit) return explicit;
  const fromEnv = process.env.ZTK_DB_PATH;
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

/** 只读打开 db；任何打开失败包装为 TpsUnavailableError（含 cause）。 */
function openReadOnly(dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new TpsUnavailableError(`TPS 数据源不可读：${dbPath}（${err && err.message ? err.message : err}）`, {
      schemaTopId: null,
      dbPath,
      cause: err,
    });
  }
}

/** 读 schema_migration 顶部（最新）迁移 id；表缺失/查询失败 → TpsUnavailableError。 */
function readSchemaTopId(db, dbPath) {
  try {
    const row = db
      .prepare('SELECT id FROM schema_migration ORDER BY time_applied DESC, id DESC LIMIT 1')
      .get();
    return row && row.id != null ? String(row.id) : null;
  } catch (err) {
    throw new TpsUnavailableError(
      `TPS 数据源 schema_migration 不可读（${err && err.message ? err.message : err}）`,
      { schemaTopId: null, dbPath, cause: err },
    );
  }
}

/** schema 哨兵：顶部迁移 id 不在 knowledge 知识表内 → 抛 TpsUnavailableError（上层降级文案）。返回顶部 id。 */
function assertSchemaKnown(db, dbPath) {
  const topId = readSchemaTopId(db, dbPath);
  let known;
  try {
    known = _internal.isKnownSchema(topId);
  } catch (err) {
    // knowledge 判定自身异常（stub 阶段 / 未来实现缺陷）同样走降级路径，不崩进程
    throw new TpsUnavailableError(
      `TPS schema 哨兵判定异常：${err && err.message ? err.message : err}`,
      { schemaTopId: topId, dbPath, cause: err },
    );
  }
  if (!known) {
    const knownCeiling = KNOWN_SCHEMA_MIGRATIONS.slice().sort().pop() ?? '(空)';
    throw new TpsUnavailableError(
      `TPS 数据源 schema 漂移：顶部迁移 id "${topId}" 不在知识表内（已知最新代际 ${knownCeiling}）；`
        + '宿主可能已升级，请等待插件知识表更新（doctor 会记录 degraded）',
      { schemaTopId: topId, dbPath },
    );
  }
  return topId;
}

/** 执行查询，sqlite 层异常包装为 TpsUnavailableError（调用方降级，不裸抛崩进程）。 */
function safeAll(db, dbPath, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    throw new TpsUnavailableError(
      `TPS 查询失败：${err && err.message ? err.message : err}`,
      { schemaTopId: null, dbPath, cause: err },
    );
  }
}

/**
 * 解析「当前用户主会话」（带缓存；未找到返回 null——不缓存 null，首次活动下一个轮询周期即可见）。
 * @returns {string|null}
 */
function resolveMainSessionCached(db, dbPath, cacheMs) {
  const cached = mainSessionCache.get(dbPath);
  if (cached && cacheMs > 0 && Date.now() - cached.resolvedAt < cacheMs) return cached.sessionId;
  const rows = safeAll(db, dbPath, SQL_RESOLVE_MAIN_SESSION);
  const sessionId = rows.length > 0 && rows[0].session_id ? String(rows[0].session_id) : null;
  if (sessionId) mainSessionCache.set(dbPath, { sessionId, resolvedAt: Date.now() });
  return sessionId;
}

/** 最近完成轮 tok/s：同库时钟单一时钟源；任一时间戳缺失或时长非正 → null（NULL 容忍，不以 0 充数）。 */
function tokPerSecOf(firstTokenAt, completedAt, outputTokens) {
  if (firstTokenAt == null || completedAt == null) return null;
  const genMs = Number(completedAt) - Number(firstTokenAt);
  if (!(genMs > 0)) return null;
  return outputTokens / (genMs / 1000); // 原始值，展示层自行格式化
}

const SQL_SESSION_TOTALS = (filtered) => `
  SELECT
    COUNT(*) AS turn_count,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
    SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
    SUM(input_tokens)               AS input_tokens,
    SUM(output_tokens)              AS output_tokens,
    SUM(reasoning_tokens)           AS reasoning_tokens,
    SUM(cache_creation_input_tokens) AS cache_creation_tokens,
    SUM(cache_read_input_tokens)    AS cache_read_tokens,
    SUM(computed_total_tokens)      AS computed_total_tokens
  FROM turn_usage
  ${filtered ? 'WHERE session_id = ?' : ''}`;

const SQL_LAST_COMPLETED_TURN = (filtered) => `
  SELECT turn_id, status, started_at, first_token_at, completed_at, time_to_first_token_ms,
         input_tokens, output_tokens, cache_read_input_tokens, computed_total_tokens
  FROM turn_usage
  WHERE ${filtered ? 'session_id = ? AND ' : ''}status = 'completed'
  ORDER BY started_at DESC
  LIMIT 1`;

const SQL_MODEL_DISTRIBUTION = (filtered) => `
  SELECT provider_id, model_id, COUNT(*) AS request_count
  FROM model_usage
  ${filtered ? 'WHERE session_id = ?' : ''}
  GROUP BY provider_id, model_id
  ORDER BY request_count DESC, provider_id ASC, model_id ASC`;

/**
 * 组装 TpsSnapshot（scope 已解析为有效作用域 + 目标 sessionId）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dbPath
 * @param {'current'|'latest_main'|'all'} effectiveScope
 * @param {string|null} sessionId - null 仅合法于 'all' 或「未找到主会话」的 latest_main 降级快照。
 * @param {string|null} degraded
 */
function buildSnapshot(db, dbPath, effectiveScope, sessionId, degraded) {
  if (effectiveScope !== 'all' && sessionId == null) {
    // 「未找到主会话」的零值快照：绝不能退化成全表聚合（那会把 dwf/subagent 后台会话当用户数据展示）
    return {
      scope: effectiveScope,
      sessionId: null,
      sessionIdTail: null,
      realtime: true,
      lastCompletedTurn: null,
      sessionTotals: {
        turnCount: 0,
        completedTurnCount: 0,
        cancelledTurnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        computedTotalTokens: 0,
      },
      modelDistribution: [],
      degraded,
    };
  }
  const filtered = sessionId != null;
  const params = filtered ? [sessionId] : [];

  const totalsRow = safeAll(db, dbPath, SQL_SESSION_TOTALS(filtered), params)[0] ?? {};
  const lastRow = safeAll(db, dbPath, SQL_LAST_COMPLETED_TURN(filtered), params)[0] ?? null;
  const distRows = safeAll(db, dbPath, SQL_MODEL_DISTRIBUTION(filtered), params);

  const lastCompletedTurn = lastRow
    ? {
        turnId: String(lastRow.turn_id),
        status: String(lastRow.status),
        startedAt: lastRow.started_at,
        completedAt: lastRow.completed_at ?? null,
        ttftMs: lastRow.time_to_first_token_ms ?? null, // 直读，NULL 容忍
        tokPerSec: tokPerSecOf(lastRow.first_token_at, lastRow.completed_at, lastRow.output_tokens ?? 0),
        inputTokens: lastRow.input_tokens ?? 0,
        outputTokens: lastRow.output_tokens ?? 0,
        cacheReadTokens: lastRow.cache_read_input_tokens ?? 0,
        computedTotalTokens: lastRow.computed_total_tokens ?? 0,
      }
    : null;

  return {
    scope: effectiveScope,
    sessionId: sessionId ?? null,
    sessionIdTail: sessionId ? sessionId.slice(-8) : null,
    realtime: true, // G0-a go（P95=1969ms ≤ 3s）：语义 = 最近完成轮 ≤2s 可见，非 token 级流式
    lastCompletedTurn,
    sessionTotals: {
      turnCount: totalsRow.turn_count ?? 0, // 含 cancelled
      completedTurnCount: totalsRow.completed_count ?? 0,
      cancelledTurnCount: totalsRow.cancelled_count ?? 0,
      inputTokens: totalsRow.input_tokens ?? 0,
      outputTokens: totalsRow.output_tokens ?? 0,
      reasoningTokens: totalsRow.reasoning_tokens ?? 0,
      cacheCreationTokens: totalsRow.cache_creation_tokens ?? 0,
      cacheReadTokens: totalsRow.cache_read_tokens ?? 0,
      computedTotalTokens: totalsRow.computed_total_tokens ?? 0,
    },
    modelDistribution: distRows.map((r) => ({
      providerId: String(r.provider_id),
      modelId: String(r.model_id),
      requestCount: r.request_count ?? 0,
    })),
    degraded,
  };
}

/* -------------------------------------------------------------------------
 * 导出 API（契约签名与 stub 一致）
 * ----------------------------------------------------------------------- */

/**
 * 解析「当前用户主会话」session_id（两步走之①，带缓存；g0 实测 SQL 见模块头）。
 *
 * @async
 * @param {object} [opts]
 * @param {string} [opts.dbPath] - 覆盖 db 路径（测试注入 fixture；否则读 ZTK_DB_PATH，再否则默认真实路径）。
 * @param {number} [opts.resolveCacheMs=30000] - 解析结果缓存时长；超时或调用方探测到会话切换时重解析。
 * @returns {Promise<string>} 当前用户主会话 session_id（如 'sess_6d861983-…'）。
 * @throws {TpsUnavailableError} db 不可读，或 schema 哨兵不通过
 *   （先读 schema_migration 顶部 id，用 knowledge.isKnownSchema 判定——引用 src/knowledge.mjs 导出的
 *   KNOWN_SCHEMA_MIGRATIONS / isKnownSchema，不得在本模块重写白名单）；
 *   或库中不存在任何用户主会话（无 query_source='main_turn' 且非 sess_dwf-% 的行）。
 */
export async function resolveMainSessionId(opts = {}) {
  const dbPath = resolveDbPath(opts.dbPath);
  const cacheMs = typeof opts.resolveCacheMs === 'number' ? opts.resolveCacheMs : DEFAULT_RESOLVE_CACHE_MS;
  const cached = mainSessionCache.get(dbPath);
  if (cached && cacheMs > 0 && Date.now() - cached.resolvedAt < cacheMs) return cached.sessionId;

  const db = openReadOnly(dbPath);
  try {
    const schemaTopId = assertSchemaKnown(db, dbPath);
    const sessionId = resolveMainSessionCached(db, dbPath, cacheMs);
    if (!sessionId) {
      throw new TpsUnavailableError(
        '未找到任何用户主会话（model_usage 无 query_source=main_turn 且非 sess_dwf-% 的行）',
        { schemaTopId, dbPath },
      );
    }
    return sessionId;
  } finally {
    db.close();
  }
}

/**
 * TPS 查询主入口（server.mjs 的 ztk_tps_query 工具直接委托本函数；每次调用 = 一次轮询）。
 *
 * @async
 * @param {('current'|'latest_main'|'all')} [scope='latest_main']
 *   - 'latest_main'（默认）：resolveMainSessionId 解析最新用户主会话 → 该会话聚合（面板标注 sessionIdTail）。
 *     未找到主会话时**不抛**：返回零值快照 + degraded 说明（数据源可用、只是没数据）。
 *   - 'current'：调用方（面板/MCP 上下文）能提供精确 chat session id 时用
 *     （G0-a「面板上下文实验」【待验证】：extra.sessionId 与 db session_id 的映射未取得直接证据）；
 *     拿不到（未提供 opts.sessionId），或提供的 session_id 在 turn_usage 无任何行（映射大概率失败）
 *     → 回落 latest_main，并在返回值 degraded 中注明「scope current 回退 latest_main」，不得抛错。
 *   - 'all'：全部会话汇总（面板历史视图，可慢路径——全表聚合，sessionId/sessionIdTail 为 null）。
 * @param {object} [opts]
 * @param {string} [opts.dbPath] - 覆盖 db 路径（测试注入 fixture）。
 * @param {string} [opts.sessionId] - 显式指定会话（scope='current' 的入参形态；优先于解析结果）。
 * @returns {Promise<TpsSnapshot>} 结构见下方字段（字段名即契约，server/面板按此消费）：
 *   TpsSnapshot = {
 *     scope: 'current'|'latest_main'|'all',        // 实际生效的作用域（回退后为 'latest_main'）
 *     sessionId: string|null,
 *     sessionIdTail: string|null,            // 尾号（后 8 位），面板错位察觉用
 *     realtime: true,                        // G0-a go：语义=最近完成轮 ≤2s 可见；文案不得宣称 token 级流式
 *     lastCompletedTurn: {                   // 最近完成轮（banner 主内容；无完成轮为 null）
 *       turnId: string, status: string,      // 查询口径 status='completed'，故恒为 'completed'
 *       startedAt: number, completedAt: number,   // epoch ms，库内时钟
 *       ttftMs: number|null, tokPerSec: number|null,  // NULL 容忍：无流式时间戳的完成轮返回 null
 *       inputTokens: number, outputTokens: number,
 *       cacheReadTokens: number, computedTotalTokens: number,
 *     } | null,
 *     sessionTotals: {                       // 会话累计（面板详表；§5 #6 按 session_id 聚合 db 行）
 *       turnCount: number,                   // 含 cancelled
 *       completedTurnCount: number, cancelledTurnCount: number,  // banner「轮数」口径二选一时两者都在，由展示层决定
 *       inputTokens: number, outputTokens: number, reasoningTokens: number,
 *       cacheCreationTokens: number, cacheReadTokens: number, computedTotalTokens: number,
 *     },
 *     modelDistribution: { providerId: string, modelId: string, requestCount: number }[],  // model_usage 按 session 聚合
 *     degraded: string | null,               // 非空=降级说明（如 scope 回退、未找到主会话）
 *   }
 * @throws {TpsUnavailableError} schema 漂移（顶部迁移 id 不在 knowledge.KNOWN_SCHEMA_MIGRATIONS）或 db 不可读。
 *   调用方（server/banner）据此显示「TPS 数据源暂不可用（宿主版本 X）」并保留面板历史快照，绝不崩进程。
 *   scope 非法 → TypeError（编程错误，非降级场景）。
 */
export async function queryTps(scope = 'latest_main', opts = {}) {
  if (!SCOPES.includes(scope)) {
    throw new TypeError(`queryTps: 非法 scope "${scope}"（必须为 'current' | 'latest_main' | 'all'）`);
  }
  const dbPath = resolveDbPath(opts.dbPath);
  const db = openReadOnly(dbPath);
  try {
    assertSchemaKnown(db, dbPath);

    if (scope === 'all') {
      // 全部会话汇总（慢路径可接受）：不解析会话，直接全表聚合
      return buildSnapshot(db, dbPath, 'all', null, null);
    }

    if (scope === 'current' && opts.sessionId) {
      // 显式 session_id 优先；但该会话在 turn_usage 无任何行 → 映射大概率失败，回落 latest_main（不抛）
      const turnCount = safeAll(
        db,
        dbPath,
        'SELECT COUNT(*) AS n FROM turn_usage WHERE session_id = ?',
        [opts.sessionId],
      )[0].n;
      if (turnCount > 0) {
        return buildSnapshot(db, dbPath, 'current', opts.sessionId, null);
      }
      const fallback = resolveMainSessionCached(db, dbPath, DEFAULT_RESOLVE_CACHE_MS);
      return buildSnapshot(
        db,
        dbPath,
        'latest_main',
        fallback,
        fallback
          ? `scope current 回退 latest_main：指定 session ${opts.sessionId} 在 turn_usage 无数据（MCP sessionId → chat session_id 映射未证实，G0-a 待验证项）`
          : 'scope current 回退 latest_main：指定 session 无数据，且未找到任何用户主会话',
      );
    }

    // latest_main（默认），或 current 未提供 sessionId 的回落
    const sessionId = resolveMainSessionCached(db, dbPath, DEFAULT_RESOLVE_CACHE_MS);
    const degraded = scope === 'current'
      ? 'scope current 回退 latest_main：调用方未提供 sessionId（extra.sessionId → db chat session_id 映射【待验证 G0-a】）'
      : sessionId
        ? null
        : '未找到用户主会话（model_usage 无 query_source=main_turn 且非 sess_dwf-% 的行）：展示零值快照';
    return buildSnapshot(db, dbPath, 'latest_main', sessionId, degraded);
  } finally {
    db.close();
  }
}
