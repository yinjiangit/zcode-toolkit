/**
 * tps.test.mjs —— src/tps.mjs 契约测试（node:test，零 npm 依赖；方案 §1.1⑤ / §5 #6/#7 + G0-a 勘误口径）。
 *
 * fixture 纪律：全部在 test/.tmp/ 下用 node:sqlite 现建迷你库（DDL 与真实 db 同名同列，
 * 来源：g0a 实测 schema dump），绝不触真实 ~/.zcode；只读路径一律经 tps 模块的 readOnly 连接。
 *
 * 混合数据口径（g0a §4）：main_turn（用户主会话）/ sess_dwf-%（workflow actor）/ sess_subagent_agent_*
 * 三类并存，另含一个「病态 main_turn 落在 sess_dwf-% 会话」的 rogue 行，专测 NOT LIKE 排除子句。
 *
 * knowledge.mjs 依赖：哨兵工程师并行实现（stub 阶段 isKnownSchema 抛 TODO）。本文件策略：
 *   - 捕获 tps._internal.isKnownSchema 的加载时绑定，断言 === knowledge.isKnownSchema（默认委托成立的确定性证明）；
 *   - 其余测试整体注入「等价于 knowledge 契约 JSDoc」的判定函数（KNOWN_SCHEMA_MIGRATIONS.includes），
 *     使本文件对并行实现进度保持确定性（不 skip、不依赖外部文件状态）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as tps from '../src/tps.mjs';
import * as knowledge from '../src/knowledge.mjs';

const { TpsUnavailableError, resolveMainSessionId, queryTps, _internal } = tps;

// 加载时捕获默认绑定（在任何测试覆写之前）——identity 测试用
const defaultIsKnownSchemaBinding = _internal.isKnownSchema;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

/* ---------------------------------------------------------------------------
 * fixture：与真实库同名同列的迷你 schema（g0a 实测 DDL，去掉 session 表外键子句；
 * 索引仅建查询计划相关的三个同名索引）
 * ------------------------------------------------------------------------- */
const DDL = `
CREATE TABLE schema_migration (
  id text primary key,
  checksum text not null,
  app_version text,
  time_applied integer not null
);
CREATE TABLE turn_usage (
  session_id text not null,
  turn_id text not null,
  trace_id text,
  user_message_id text,
  status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
  started_at integer not null,
  first_model_start_at integer,
  first_token_at integer,
  completed_at integer,
  duration_ms integer,
  time_to_first_token_ms integer,
  model_request_count integer not null default 0,
  model_retry_count integer not null default 0,
  tool_call_count integer not null default 0,
  tool_error_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  computed_total_tokens integer not null default 0,
  retryable integer not null default 0 check(retryable in (0, 1)),
  cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
  context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
  error_type text,
  error_code text,
  primary key(session_id, turn_id)
);
CREATE TABLE model_usage (
  id text primary key,
  logical_request_id text not null,
  attempt_index integer not null default 0,
  session_id text not null,
  turn_id text,
  trace_id text,
  span_id text,
  assistant_message_id text,
  parent_user_message_id text,
  query_source text not null,
  provider_id text not null,
  model_id text not null,
  variant text,
  agent text,
  mode text,
  task_type text,
  status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
  started_at integer not null,
  first_token_at integer,
  completed_at integer,
  duration_ms integer,
  time_to_first_token_ms integer,
  finish_reason text,
  tool_call_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  provider_total_tokens integer,
  computed_total_tokens integer not null default 0,
  retry_count integer not null default 0,
  retryable integer not null default 0 check(retryable in (0, 1)),
  cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
  context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
  error_type text,
  error_code text,
  error_message text,
  raw_usage_json text,
  provider_metadata_json text
);
CREATE INDEX turn_usage_started_idx ON turn_usage(started_at);
CREATE INDEX model_usage_query_source_idx ON model_usage(query_source);
CREATE INDEX model_usage_session_turn_idx ON model_usage(session_id, turn_id);
`;

const KNOWN_MIGRATIONS = [
  ['0018_session_input_failed_status', '0.15.2', 1786583633208],
  ['0019_dwf_journal', '0.16.5', 1789633537647],
  ['0020_provider_model_selection', '0.16.5', 1789633542712],
  ['0021_official_glm_selection', '0.16.5', 1789633542723],
  ['0022_backfilled_session_reasoning', '0.16.5', 1789633543624],
];
const DRIFT_TOP_ID = '0023_unknown_future_migration';

function newFixture(name) {
  const dbPath = path.join(TMP, name);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  return { db, dbPath };
}

function insertMigration(db, [id, appVersion, timeApplied]) {
  db.prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?,?,?,?)').run(
    id, 'cafebabe', appVersion, timeApplied,
  );
}

function insertTurn(db, t) {
  db.prepare(`
    INSERT INTO turn_usage (session_id, turn_id, status, started_at, first_token_at, completed_at,
      time_to_first_token_ms, input_tokens, output_tokens, reasoning_tokens,
      cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    t.sessionId, t.turnId, t.status ?? 'completed', t.startedAt,
    t.firstTokenAt ?? null, t.completedAt ?? null, t.ttftMs ?? null,
    t.input ?? 0, t.output ?? 0, t.reasoning ?? 0,
    t.cacheWrite ?? 0, t.cacheRead ?? 0, t.computedTotal ?? 0,
  );
}

let muSeq = 0;
function insertUse(db, u) {
  muSeq += 1;
  db.prepare(`
    INSERT INTO model_usage (id, logical_request_id, session_id, query_source,
      provider_id, model_id, status, started_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    `mu_${muSeq}`, `lrq_${muSeq}`, u.sessionId, u.querySource ?? 'main_turn',
    u.providerId, u.modelId, u.status ?? 'completed', u.startedAt,
  );
}

/* ---------------------------------------------------------------------------
 * 会话/数据设定（时间单位：epoch ms，任意基准即可——只看相对序）
 * ------------------------------------------------------------------------- */
const SESS_A = 'sess_aaaaaaaa-oldmain'; // 较旧的用户主会话
const SESS_B = 'sess_bbbbbbbb-main'; // 最新用户主会话（latest_main 应解析到它）
const SESS_DWF = 'sess_dwf-dwfrun-test01-actor_1_1'; // workflow actor（必须被排除）
const SESS_ROGUE = 'sess_dwf-dwfrun-rogue99'; // 病态：main_turn 落在 dwf 前缀会话（测 NOT LIKE）
const SESS_SUB = 'sess_subagent_agent_abcdef01'; // subagent 独立前缀会话（必须被排除）

const paths = {};

before(() => {
  // —— 主混合 fixture ——
  {
    const { db, dbPath } = newFixture('tps-main.sqlite');
    for (const m of KNOWN_MIGRATIONS) insertMigration(db, m);

    // A（旧主会话）：a1 可计算指标；a2 cancelled（测轮数口径）
    insertTurn(db, { sessionId: SESS_A, turnId: 'turn_a1', startedAt: 100, firstTokenAt: 200, completedAt: 1200, ttftMs: 100, input: 10, output: 50, computedTotal: 60 });
    insertTurn(db, { sessionId: SESS_A, turnId: 'turn_a2', status: 'cancelled', startedAt: 150, completedAt: 160, input: 5, output: 5, computedTotal: 10 });

    // B（最新主会话）：b1 可计算但较旧；bnull 最新完成轮但无流式时间戳（g0 基准 #2 NULL 容忍）；bcancel cancelled
    insertTurn(db, { sessionId: SESS_B, turnId: 'turn_b1', startedAt: 1000, firstTokenAt: 1500, completedAt: 3500, ttftMs: 500, input: 1000, output: 200, cacheRead: 100, computedTotal: 1300 });
    insertTurn(db, { sessionId: SESS_B, turnId: 'turn_bnull', startedAt: 5000, firstTokenAt: null, completedAt: 6000, ttftMs: null, input: 900, output: 7621, computedTotal: 8521 });
    insertTurn(db, { sessionId: SESS_B, turnId: 'turn_bcancel', status: 'cancelled', startedAt: 6000, completedAt: 6100, input: 1, output: 1, computedTotal: 2 });

    // dwf：turn_d1 是全库最新完成轮（若过滤失效会被误当用户最近轮）
    insertTurn(db, { sessionId: SESS_DWF, turnId: 'turn_d1', startedAt: 9000, firstTokenAt: 9100, completedAt: 9500, ttftMs: 100, input: 2000, output: 1000, computedTotal: 3000 });
    // subagent
    insertTurn(db, { sessionId: SESS_SUB, turnId: 'turn_s1', startedAt: 8000, firstTokenAt: 8050, completedAt: 8300, ttftMs: 50, input: 300, output: 300, computedTotal: 600 });

    insertUse(db, { sessionId: SESS_A, providerId: 'provOld', modelId: 'glm-4.5', startedAt: 100 });
    insertUse(db, { sessionId: SESS_B, providerId: 'provX', modelId: 'glm-5.3', startedAt: 1000 });
    insertUse(db, { sessionId: SESS_B, providerId: 'provX', modelId: 'glm-5.3', startedAt: 1100 });
    insertUse(db, { sessionId: SESS_B, providerId: 'provX', modelId: 'glm-5.3', startedAt: 1200 });
    insertUse(db, { sessionId: SESS_B, providerId: 'provX', modelId: 'glm-5.4', startedAt: 1300 });
    insertUse(db, { sessionId: SESS_B, querySource: 'compact', providerId: 'provY', modelId: 'glm-5.3', startedAt: 5500 }); // 非 main_turn 但属 B 的真实模型请求
    insertUse(db, { sessionId: SESS_DWF, querySource: 'workflow_child', providerId: 'provX', modelId: 'glm-5.3', startedAt: 9000 });
    insertUse(db, { sessionId: SESS_DWF, querySource: 'workflow_child', providerId: 'provX', modelId: 'glm-5.3', startedAt: 9200 });
    insertUse(db, { sessionId: SESS_ROGUE, providerId: 'provRogue', modelId: 'glm-rogue', startedAt: 12000 }); // 全库最新 main_turn，但会话前缀必须被排除
    insertUse(db, { sessionId: SESS_SUB, querySource: 'subagent', providerId: 'provSub', modelId: 'glm-sub', startedAt: 8000 });

    db.close();
    paths.main = dbPath;
  }

  // —— schema 漂移 fixture：顶部迁移 id 未知 ——
  {
    const { db, dbPath } = newFixture('tps-drift.sqlite');
    for (const m of KNOWN_MIGRATIONS.slice(0, 2)) insertMigration(db, m);
    insertMigration(db, [DRIFT_TOP_ID, '0.17.0', 1899999999999]);
    insertUse(db, { sessionId: SESS_B, providerId: 'provX', modelId: 'glm-5.3', startedAt: 1000 });
    db.close();
    paths.drift = dbPath;
  }

  // —— 无主会话 fixture：只有 dwf/subagent 流量 ——
  {
    const { db, dbPath } = newFixture('tps-nomain.sqlite');
    for (const m of KNOWN_MIGRATIONS) insertMigration(db, m);
    insertUse(db, { sessionId: SESS_DWF, querySource: 'workflow_child', providerId: 'provX', modelId: 'glm-5.3', startedAt: 9000 });
    insertUse(db, { sessionId: SESS_SUB, querySource: 'subagent', providerId: 'provSub', modelId: 'glm-sub', startedAt: 8000 });
    db.close();
    paths.nomain = dbPath;
  }

  // —— 缓存行为 fixture ——
  {
    const { db, dbPath } = newFixture('tps-cache.sqlite');
    for (const m of KNOWN_MIGRATIONS) insertMigration(db, m);
    insertUse(db, { sessionId: 'sess_cccccccc-cache1', providerId: 'p', modelId: 'm', startedAt: 1000 });
    db.close();
    paths.cache = dbPath;
  }

  // 整体注入契约等价的哨兵判定（见文件头说明）；after 恢复
  _internal.isKnownSchema = (id) => knowledge.KNOWN_SCHEMA_MIGRATIONS.includes(id);
});

after(() => {
  _internal.isKnownSchema = defaultIsKnownSchemaBinding;
});

/* ---------------------------------------------------------------------------
 * 哨兵与知识表委托
 * ------------------------------------------------------------------------- */

test('_internal.isKnownSchema 默认绑定 = knowledge.isKnownSchema（生产路径委托成立）', () => {
  assert.strictEqual(defaultIsKnownSchemaBinding, knowledge.isKnownSchema);
  assert.strictEqual(typeof knowledge.KNOWN_SCHEMA_MIGRATIONS[0], 'string');
});

test('SchemaDrift：顶部迁移 id 不在知识表 → resolveMainSessionId/queryTps 抛 TpsUnavailableError（可识别降级）', async () => {
  await assert.rejects(
    resolveMainSessionId({ dbPath: paths.drift }),
    (err) => err instanceof TpsUnavailableError
      && err.name === 'TpsUnavailableError'
      && err.info.schemaTopId === DRIFT_TOP_ID
      && err.info.dbPath === paths.drift,
  );
  await assert.rejects(
    queryTps('latest_main', { dbPath: paths.drift }),
    (err) => err instanceof TpsUnavailableError && err.info.schemaTopId === DRIFT_TOP_ID,
  );
  // scope='current' 且显式 sessionId 同样先过哨兵（漂移面前无旁路）
  await assert.rejects(
    queryTps('current', { dbPath: paths.drift, sessionId: SESS_B }),
    (err) => err instanceof TpsUnavailableError && err.info.schemaTopId === DRIFT_TOP_ID,
  );
  // 'all' 亦然
  await assert.rejects(
    queryTps('all', { dbPath: paths.drift }),
    (err) => err instanceof TpsUnavailableError && err.info.schemaTopId === DRIFT_TOP_ID,
  );
});

test('已知顶部迁移 id（0022_…）正常通过哨兵（主混合 fixture 全程可查）', async () => {
  const s = await queryTps('latest_main', { dbPath: paths.main });
  assert.equal(s.degraded, null);
});

test('db 不可读（文件不存在）→ TpsUnavailableError（schemaTopId=null，带 cause）', async () => {
  const missing = path.join(TMP, 'tps-not-exist.sqlite');
  await assert.rejects(
    resolveMainSessionId({ dbPath: missing }),
    (err) => err instanceof TpsUnavailableError && err.info.schemaTopId === null && err.info.cause instanceof Error,
  );
  await assert.rejects(
    queryTps('latest_main', { dbPath: missing }),
    (err) => err instanceof TpsUnavailableError && err.info.schemaTopId === null,
  );
});

/* ---------------------------------------------------------------------------
 * 过滤口径（g0a §4：两步走；NOT LIKE 排除 rogue dwf main_turn；subagent 不混入）
 * ------------------------------------------------------------------------- */

test('resolveMainSessionId：解析到最新用户主会话 B（排除 dwf/rogue/subagent）', async () => {
  assert.equal(await resolveMainSessionId({ dbPath: paths.main }), SESS_B);
});

test('queryTps latest_main（默认档）：会话/最近完成轮/累计/模型分布全部圈在 B 内', async () => {
  const s = await queryTps('latest_main', { dbPath: paths.main });
  assert.equal(s.scope, 'latest_main');
  assert.equal(s.sessionId, SESS_B);
  assert.equal(s.sessionIdTail, SESS_B.slice(-8));
  assert.equal(s.realtime, true); // G0-a go 语义：最近完成轮 ≤2s 可见
  assert.equal(s.degraded, null);

  // 最近完成轮 = B 的最新完成轮 turn_bnull（不是全库最新的 dwf turn_d1，也不是 B 内更旧的 b1）
  // NULL 容忍（g0 基准 #2）：completed 但无流式时间戳 → tokPerSec/ttftMs 为 null，不报错不以 0 充数
  assert.equal(s.lastCompletedTurn.turnId, 'turn_bnull');
  assert.equal(s.lastCompletedTurn.status, 'completed');
  assert.equal(s.lastCompletedTurn.startedAt, 5000);
  assert.equal(s.lastCompletedTurn.completedAt, 6000);
  assert.equal(s.lastCompletedTurn.ttftMs, null);
  assert.equal(s.lastCompletedTurn.tokPerSec, null);
  assert.equal(s.lastCompletedTurn.inputTokens, 900);
  assert.equal(s.lastCompletedTurn.outputTokens, 7621);
  assert.equal(s.lastCompletedTurn.cacheReadTokens, 0);
  assert.equal(s.lastCompletedTurn.computedTotalTokens, 8521);

  // 会话累计按 session_id 聚合（§5 #6：与 DOM 生命周期无关；turnCount 含 cancelled）
  const t = s.sessionTotals;
  assert.equal(t.turnCount, 3);
  assert.equal(t.completedTurnCount, 2);
  assert.equal(t.cancelledTurnCount, 1);
  assert.equal(t.inputTokens, 1000 + 900 + 1);
  assert.equal(t.outputTokens, 200 + 7621 + 1);
  assert.equal(t.reasoningTokens, 0);
  assert.equal(t.cacheCreationTokens, 0);
  assert.equal(t.cacheReadTokens, 100);
  assert.equal(t.computedTotalTokens, 1300 + 8521 + 2);

  // 模型分布来自 model_usage（含 B 的 compact 请求；不含 A/dwf/rogue/subagent）
  assert.deepEqual(s.modelDistribution, [
    { providerId: 'provX', modelId: 'glm-5.3', requestCount: 3 },
    { providerId: 'provX', modelId: 'glm-5.4', requestCount: 1 },
    { providerId: 'provY', modelId: 'glm-5.3', requestCount: 1 },
  ]);
});

test('queryTps() 缺省 scope 参数 = latest_main（默认档）', async () => {
  const sExplicit = await queryTps('latest_main', { dbPath: paths.main });
  const sDefault = await queryTps(undefined, { dbPath: paths.main }); // 不传 scope → 默认 latest_main
  assert.equal(sDefault.scope, 'latest_main');
  assert.equal(sDefault.scope, sExplicit.scope);
  assert.equal(sDefault.sessionId, sExplicit.sessionId);
  assert.equal(sDefault.lastCompletedTurn.turnId, sExplicit.lastCompletedTurn.turnId);
});

/* ---------------------------------------------------------------------------
 * 指标计算（§5 #7：同库时钟单一时钟源；TTFT 直读）
 * ------------------------------------------------------------------------- */

test('tok/s = output/((completed_at-first_token_at)/1000)，TTFT 直读 time_to_first_token_ms', async () => {
  // A 会话 turn_a1：out=50，生成时长 1200-200=1000ms → 50 tok/s；TTFT=100
  const s = await queryTps('current', { dbPath: paths.main, sessionId: SESS_A });
  assert.equal(s.lastCompletedTurn.turnId, 'turn_a1');
  assert.ok(Math.abs(s.lastCompletedTurn.tokPerSec - 50) < 1e-9, `tokPerSec=${s.lastCompletedTurn.tokPerSec}`);
  assert.equal(s.lastCompletedTurn.ttftMs, 100);
});

/* ---------------------------------------------------------------------------
 * scope 三档
 * ------------------------------------------------------------------------- */

test("scope='current' + 显式 sessionId：精确作用域，degraded=null", async () => {
  const s = await queryTps('current', { dbPath: paths.main, sessionId: SESS_A });
  assert.equal(s.scope, 'current');
  assert.equal(s.sessionId, SESS_A);
  assert.equal(s.sessionIdTail, SESS_A.slice(-8));
  assert.equal(s.degraded, null);
  assert.equal(s.sessionTotals.turnCount, 2);
  assert.equal(s.sessionTotals.completedTurnCount, 1);
  assert.equal(s.sessionTotals.cancelledTurnCount, 1);
  assert.deepEqual(s.modelDistribution, [{ providerId: 'provOld', modelId: 'glm-4.5', requestCount: 1 }]);
});

test("scope='current' 未提供 sessionId → 回落 latest_main + degraded 注明，不抛错", async () => {
  const s = await queryTps('current', { dbPath: paths.main });
  assert.equal(s.scope, 'latest_main'); // 实际生效作用域
  assert.equal(s.sessionId, SESS_B);
  assert.ok(s.degraded && s.degraded.includes('latest_main') && s.degraded.includes('回退'), s.degraded);
});

test("scope='current' 指定不存在的 session → 回落 latest_main + degraded 注明", async () => {
  const s = await queryTps('current', { dbPath: paths.main, sessionId: 'sess_zzzz_mapping_failed' });
  assert.equal(s.scope, 'latest_main');
  assert.equal(s.sessionId, SESS_B);
  assert.ok(s.degraded && s.degraded.includes('sess_zzzz_mapping_failed'), s.degraded);
});

test("scope='all'：全库汇总（sessionId=null，含 dwf/subagent；最近完成轮=全库最新完成轮）", async () => {
  const s = await queryTps('all', { dbPath: paths.main });
  assert.equal(s.scope, 'all');
  assert.equal(s.sessionId, null);
  assert.equal(s.sessionIdTail, null);
  assert.equal(s.degraded, null);
  assert.equal(s.realtime, true);

  // 全库最新完成轮是 dwf 的 turn_d1（started 9000 > bnull 5000）：out=1000，gen=9500-9100=400ms → 2500 tok/s
  assert.equal(s.lastCompletedTurn.turnId, 'turn_d1');
  assert.ok(Math.abs(s.lastCompletedTurn.tokPerSec - 2500) < 1e-9, `tokPerSec=${s.lastCompletedTurn.tokPerSec}`);
  assert.equal(s.lastCompletedTurn.ttftMs, 100);

  // 累计 = A(2轮) + B(3轮) + dwf(1轮) + subagent(1轮) = 7 轮；completed 5 / cancelled 2
  const t = s.sessionTotals;
  assert.equal(t.turnCount, 7);
  assert.equal(t.completedTurnCount, 5);
  assert.equal(t.cancelledTurnCount, 2);
  assert.equal(t.inputTokens, (10 + 5) + (1000 + 900 + 1) + 2000 + 300);
  assert.equal(t.outputTokens, (50 + 5) + (200 + 7621 + 1) + 1000 + 300);
  assert.equal(t.cacheReadTokens, 100);
  assert.equal(t.computedTotalTokens, (60 + 10) + (1300 + 8521 + 2) + 3000 + 600);

  // 模型分布全库：provX/glm-5.3 = B(3, main_turn) + dwf(2, workflow_child) = 5 居首；其余 1 并按 provider 排序
  assert.deepEqual(s.modelDistribution, [
    { providerId: 'provX', modelId: 'glm-5.3', requestCount: 5 },
    { providerId: 'provOld', modelId: 'glm-4.5', requestCount: 1 },
    { providerId: 'provRogue', modelId: 'glm-rogue', requestCount: 1 },
    { providerId: 'provSub', modelId: 'glm-sub', requestCount: 1 },
    { providerId: 'provX', modelId: 'glm-5.4', requestCount: 1 },
    { providerId: 'provY', modelId: 'glm-5.3', requestCount: 1 },
  ]);
});

test('scope 非法 → TypeError（编程错误，非降级场景）', async () => {
  await assert.rejects(
    queryTps('bogus', { dbPath: paths.main }),
    (err) => err instanceof TypeError,
  );
});

/* ---------------------------------------------------------------------------
 * 空数据与降级快照
 * ------------------------------------------------------------------------- */

test('无任何用户主会话：resolveMainSessionId 抛 TpsUnavailableError；queryTps latest_main 返回零值快照+degraded（不抛）', async () => {
  await assert.rejects(
    resolveMainSessionId({ dbPath: paths.nomain }),
    (err) => err instanceof TpsUnavailableError && /主会话/.test(err.message),
  );
  const s = await queryTps('latest_main', { dbPath: paths.nomain });
  assert.equal(s.scope, 'latest_main');
  assert.equal(s.sessionId, null);
  assert.equal(s.sessionIdTail, null);
  assert.equal(s.lastCompletedTurn, null);
  assert.equal(s.sessionTotals.turnCount, 0);
  assert.equal(s.sessionTotals.inputTokens, 0);
  assert.deepEqual(s.modelDistribution, []);
  assert.ok(s.degraded && s.degraded.includes('主会话'), s.degraded);
  // 'all' 在同库上返回空聚合而非错误
  const all = await queryTps('all', { dbPath: paths.nomain });
  assert.equal(all.sessionTotals.turnCount, 0);
  assert.equal(all.lastCompletedTurn, null);
});

/* ---------------------------------------------------------------------------
 * 解析缓存（g0a §6：~6ms 解析查询随表增长，必须缓存；resolveCacheMs=0 强制重解析）
 * ------------------------------------------------------------------------- */

test('resolveMainSessionId 缓存：TTL 内复用旧值；resolveCacheMs=0 强制重解析', async () => {
  const first = await resolveMainSessionId({ dbPath: paths.cache, resolveCacheMs: 0 });
  assert.equal(first, 'sess_cccccccc-cache1');

  // 新插入一个更新的用户主会话（直接写 fixture 库——test/.tmp 下允许）
  const rw = new DatabaseSync(paths.cache);
  insertUse(rw, { sessionId: 'sess_dddddddd-cache2', providerId: 'p', modelId: 'm', startedAt: 99999 });
  rw.close();

  // 默认 TTL（30s）内：命中缓存，仍返回旧值
  const cached = await resolveMainSessionId({ dbPath: paths.cache });
  assert.equal(cached, 'sess_cccccccc-cache1');

  // resolveCacheMs=0：绕过缓存，解析到新会话
  const fresh = await resolveMainSessionId({ dbPath: paths.cache, resolveCacheMs: 0 });
  assert.equal(fresh, 'sess_dddddddd-cache2');
});

/* ---------------------------------------------------------------------------
 * 路径注入优先级：opts.dbPath > ZTK_DB_PATH > 默认
 * ------------------------------------------------------------------------- */

test('路径优先级 opts.dbPath > ZTK_DB_PATH', async () => {
  const prev = process.env.ZTK_DB_PATH;
  process.env.ZTK_DB_PATH = paths.drift;
  try {
    // 显式入参优先：即便 env 指向漂移库，也能正常解析主 fixture
    assert.equal(await resolveMainSessionId({ dbPath: paths.main }), SESS_B);
    // 无入参 → 走 env → 漂移库 → 抛
    await assert.rejects(
      resolveMainSessionId(),
      (err) => err instanceof TpsUnavailableError && err.info.schemaTopId === DRIFT_TOP_ID,
    );
  } finally {
    if (prev === undefined) delete process.env.ZTK_DB_PATH;
    else process.env.ZTK_DB_PATH = prev;
  }
});
