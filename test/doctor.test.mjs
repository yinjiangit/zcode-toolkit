/**
 * test/doctor.test.mjs —— doctor.mjs SessionStart 哨兵的 CLI 级测试（方案 §2.5 doctor 五项 + §6 阶段 1 验收③）。
 *
 * 形态：node:test + child_process 跑真实 src/doctor.mjs（子进程 env 注入 fixture 路径，走 ZTK_* env 链，
 * 与 hooks 直接运行 dist/doctor.mjs 的生产形态同一条代码路径）。
 *
 * 【安全边界——硬性】全部 fixture 在 test/.tmp/ 下：
 * - 绝不读写真实 ~/.zcode（v2/、cli/db/、插件缓存）：db/v2/pluginsCache/state 全部注入 fixture；
 * - 绝不触 ZCode 安装目录：ZTK_RESOURCES_DIR 一律注入 fixture resources 树；
 * - fixture 库由测试用 node:sqlite 可写连接构造（被测 doctor.mjs 对它一律 readOnly:true 打开）；
 * - 零 npm 依赖，不跑 npm install。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  KNOWN_SCHEMA_MIGRATIONS,
  KNOWN_TABLE_COLUMN_BASELINE,
  KNOWN_PLUGIN_VERSIONS,
  isKnownSchema,
} from '../src/knowledge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = path.join(ROOT, 'src', 'doctor.mjs');
const TMP = path.join(ROOT, 'test', '.tmp', 'doctor');

/* ---------------- fixture 构造 ---------------- */

function freshDir(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造一个带 schema_migration / turn_usage / model_usage 的 fixture 库（列分布事实与真实库一致）。 */
function makeDb(file, topId, olderIds = []) {
  const db = new DatabaseSync(file); // fixture 库，测试可写；被测 doctor 只以 readOnly:true 打开
  db.exec(`
    CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT, app_version TEXT, time_applied INTEGER);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER);
    CREATE TABLE model_usage (id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT, query_source TEXT, started_at INTEGER);
  `);
  let t = Date.now();
  for (const id of olderIds) {
    db.prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)').run(
      id,
      'deadbeef',
      '0.15.2',
      t++,
    );
  }
  db.prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)').run(
    topId,
    'deadbeef',
    '0.16.5',
    t++,
  );
  db.close();
}

function makeV2(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // 只放形状占位，绝不放真实 apiKey
  fs.writeFileSync(path.join(dir, 'provider_config.json'), '{"schemaVersion":1,"config":{}}', 'utf8');
}

function makePluginsCache(dir) {
  const mk = (mkt, name, ver) => {
    const d = path.join(dir, mkt, name, ver, '.zcode-plugin');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({ name, version: ver }), 'utf8');
  };
  mk('zcode-plugins-official', 'zcode-guide', '0.1.0'); // 旧版本目录：④应取最新
  mk('zcode-plugins-official', 'zcode-guide', '0.3.0');
  mk('zcode-plugins-official', 'showcase', '0.4.3');
}

function makeResources(dir, residue) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.asar'), 'official-bytes-placeholder', 'utf8');
  fs.mkdirSync(path.join(dir, 'app.asar.unpacked'), { recursive: true });
  if (residue) {
    fs.writeFileSync(path.join(dir, 'app.asar.tps-patch.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, 'app.asar.tps.bak'), 'bak-bytes', 'utf8');
    fs.writeFileSync(path.join(dir, 'app.asar.enhance.bak.stale-20261013-130424'), 'stale', 'utf8');
    fs.writeFileSync(path.join(dir, 'app.asar.zp-lock'), '1', 'utf8');
  }
}

/** 全量注入 fixture env 跑真实 doctor.mjs 子进程（绝不落默认真实路径）。 */
function runDoctorCli(envOverrides) {
  const env = { ...process.env, ...envOverrides };
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [DOCTOR], { env, timeout: 30000, encoding: 'utf8' });
  return { res, elapsedMs: Date.now() - t0 };
}

function readSidecar(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'doctor.json'), 'utf8'));
}

function checkById(report, id) {
  const hit = report.checks.find((c) => c.id === id);
  assert.ok(hit, `checks 缺少 id=${id}`);
  return hit;
}

/* ---------------- 用例 ---------------- */

test('正常路径：五项检查齐备、①④⑤全绿、sidecar 结构即契约', () => {
  const dir = freshDir('normal');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  // ③：预置 server 能力 sidecar → 协商结果可记录（无 sidecar 的降级路径由「db 不可达」用例覆盖）
  fs.writeFileSync(
    path.join(stateDir, 'host_capabilities.json'),
    JSON.stringify({ ui: { surfaces: true, banner: true } }),
    'utf8',
  );
  const dbPath = path.join(dir, 'db.sqlite');
  makeDb(dbPath, '0022_backfilled_session_reasoning', ['0018_session_input_failed_status']);
  const v2Dir = path.join(dir, 'v2');
  makeV2(v2Dir);
  const pluginsCacheDir = path.join(dir, 'plugins-cache');
  makePluginsCache(pluginsCacheDir);
  const resourcesDir = path.join(dir, 'resources');
  makeResources(resourcesDir, false);

  const { res, elapsedMs } = runDoctorCli({
    ZTK_STATE_DIR: stateDir,
    ZTK_DB_PATH: dbPath,
    ZTK_V2_DIR: v2Dir,
    ZTK_PLUGINS_CACHE_DIR: pluginsCacheDir,
    ZTK_RESOURCES_DIR: resourcesDir,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(v2Dir, 'provider_config.json'),
  });

  assert.equal(res.status, 0, `doctor 必须退出码 0；stderr=${res.stderr}`);
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs < 15000, `doctor 应秒级完成，实测 ${elapsedMs}ms`);

  const report = readSidecar(stateDir);
  assert.ok(Number.isFinite(report.ranAt));
  assert.equal(report.schemaTopId, '0022_backfilled_session_reasoning');
  assert.deepEqual(
    report.checks.map((c) => c.id),
    [1, 2, 3, 4, 5],
  );
  for (const c of report.checks) {
    assert.ok(['ok', 'warn', 'degraded', 'fail'].includes(c.status), `检查 ${c.id} status 非法：${c.status}`);
    assert.ok(typeof c.detail === 'string' && c.detail.length > 0, `检查 ${c.id} detail 为空`);
  }

  const c1 = checkById(report, 1);
  assert.equal(c1.status, 'ok');
  assert.match(c1.detail, /0022_backfilled_session_reasoning/);
  assert.match(c1.detail, /query_source/); // 列分布事实已记录

  const c2 = checkById(report, 2);
  assert.equal(c2.status, 'ok');
  assert.match(c2.detail, /一致/); // env 指针一致性已记录
  assert.equal(report.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, path.join(v2Dir, 'provider_config.json'));

  const c3 = checkById(report, 3);
  assert.equal(c3.status, 'ok'); // 能力 sidecar 命中
  assert.match(c3.detail, /host_capabilities\.json/);

  const c4 = checkById(report, 4);
  assert.equal(c4.status, 'ok');
  assert.match(c4.detail, /showcase=0\.4\.3（已知/);
  assert.match(c4.detail, /zcode-guide=0\.3\.0（已知/); // 多版本目录取最新，未误报 0.1.0

  assert.equal(checkById(report, 5).status, 'ok');
  assert.equal(report.residueDetected, false);
  assert.equal(report.banner, null); // 无残留 → banner 必为空

  // 契约：探测动作不写 provider_config 父目录之外的任何文件；state 目录内只有两个 sidecar
  assert.deepEqual(fs.readdirSync(stateDir).sort(), ['doctor.json', 'host_capabilities.json']);
});

test('schema 漂移：知识表外顶部 id → ①degraded（不是 fail）、exit 0、sidecar 记 drift', () => {
  const dir = freshDir('drift');
  const stateDir = path.join(dir, 'state');
  const dbPath = path.join(dir, 'db.sqlite');
  makeDb(dbPath, '0099_unknown_future_migration', ['0022_backfilled_session_reasoning']);
  const resourcesDir = path.join(dir, 'resources');
  makeResources(resourcesDir, false);

  const { res } = runDoctorCli({
    ZTK_STATE_DIR: stateDir,
    ZTK_DB_PATH: dbPath,
    ZTK_V2_DIR: path.join(dir, 'v2'),
    ZTK_PLUGINS_CACHE_DIR: path.join(dir, 'plugins-cache'),
    ZTK_RESOURCES_DIR: resourcesDir,
  });

  assert.equal(res.status, 0, `漂移必须 exit 0 不崩；stderr=${res.stderr}`);
  const report = readSidecar(stateDir);
  assert.equal(report.schemaTopId, '0099_unknown_future_migration'); // 原始观测已记录
  const c1 = checkById(report, 1);
  assert.equal(c1.status, 'degraded'); // 契约：漂移=degraded，TPS 走降级文案，会话照常
  assert.match(c1.detail, /漂移/);
  assert.match(c1.detail, /知识表/);
  assert.equal(report.checks.length, 5); // 其余检查照常执行
});

test('db 不可达：①fail（错误文本进 detail）、exit 0、sidecar 照写、③走无 sidecar 降级', () => {
  const dir = freshDir('nodb');
  const stateDir = path.join(dir, 'state');
  const resourcesDir = path.join(dir, 'resources');
  makeResources(resourcesDir, false);

  const { res } = runDoctorCli({
    ZTK_STATE_DIR: stateDir,
    ZTK_DB_PATH: path.join(dir, 'nonexistent.sqlite'),
    ZTK_V2_DIR: path.join(dir, 'v2'),
    ZTK_PLUGINS_CACHE_DIR: path.join(dir, 'plugins-cache'),
    ZTK_RESOURCES_DIR: resourcesDir,
  });

  assert.equal(res.status, 0, `db 不可达必须 exit 0；stderr=${res.stderr}`);
  const report = readSidecar(stateDir); // sidecar 必须照写（绝不因异常少写）
  assert.equal(report.schemaTopId, null);
  const c1 = checkById(report, 1);
  assert.equal(c1.status, 'fail');
  assert.match(c1.detail, /检查异常/); // 错误已进 sidecar
  const c3 = checkById(report, 3);
  assert.equal(c3.status, 'degraded'); // 无能力 sidecar → 明示不支持（V3），不 fail
  assert.match(c3.detail, /不可用/);
  assert.equal(report.residueDetected, false);
  assert.equal(report.banner, null);
});

test('旧补丁残留：fixture resources 树 → ⑤warn + residueDetected + banner 引导 migrate', () => {
  const dir = freshDir('residue');
  const stateDir = path.join(dir, 'state');
  const dbPath = path.join(dir, 'db.sqlite');
  makeDb(dbPath, '0022_backfilled_session_reasoning');
  const resourcesDir = path.join(dir, 'resources');
  makeResources(resourcesDir, true); // patch.json / .bak / .bak.stale-* / zp-lock 全四种

  const { res } = runDoctorCli({
    ZTK_STATE_DIR: stateDir,
    ZTK_DB_PATH: dbPath,
    ZTK_V2_DIR: path.join(dir, 'v2'),
    ZTK_PLUGINS_CACHE_DIR: path.join(dir, 'plugins-cache'),
    ZTK_RESOURCES_DIR: resourcesDir,
  });

  assert.equal(res.status, 0, `残留检测必须 exit 0；stderr=${res.stderr}`);
  const report = readSidecar(stateDir);
  const c5 = checkById(report, 5);
  assert.equal(c5.status, 'warn');
  assert.equal(report.residueDetected, true);
  assert.ok(report.banner, 'residueDetected=true 时 banner 必非空');
  assert.equal(report.banner.level, 'warn');
  assert.match(report.banner.text, /migrate/);
  assert.match(report.banner.text, /--check/); // 先预演后执行（§1.3 顺序约束）
  assert.match(c5.detail, /app\.asar\.tps\.bak/); // 命中项进明细
  // 残留不影响其他检查结论
  assert.equal(checkById(report, 1).status, 'ok');
});

test('knowledge：白名单/基线/已知版本与实测一致，isKnownSchema 防御式不抛', () => {
  // 全表 22 项实测 id（2026-10-13 只读复测）都在表内，顶部判定对象非空
  assert.equal(KNOWN_SCHEMA_MIGRATIONS.length, 22);
  for (const id of ['0001_base_session_store', '0018_session_input_failed_status', '0022_backfilled_session_reasoning']) {
    assert.ok(KNOWN_SCHEMA_MIGRATIONS.includes(id), `知识表缺 ${id}`);
    assert.equal(isKnownSchema(id), true);
  }
  // 未知代际 / 防御式入参
  assert.equal(isKnownSchema('9999_not_measured'), false);
  assert.equal(isKnownSchema(''), false);
  assert.equal(isKnownSchema(null), false);
  assert.equal(isKnownSchema(undefined), false);
  assert.equal(isKnownSchema(42), false);
  assert.equal(isKnownSchema({ id: '0022_backfilled_session_reasoning' }), false);
  // 列数与列分布基线（g0a §1 + 复测）
  assert.equal(KNOWN_TABLE_COLUMN_BASELINE.turn_usage.columnCount, 26);
  assert.equal(KNOWN_TABLE_COLUMN_BASELINE.turn_usage.hasQuerySource, false);
  assert.equal(KNOWN_TABLE_COLUMN_BASELINE.model_usage.columnCount, 40);
  assert.equal(KNOWN_TABLE_COLUMN_BASELINE.model_usage.hasQuerySource, true);
  // showcase / zcode-guide 已知版本记录（实测）
  assert.equal(KNOWN_PLUGIN_VERSIONS.showcase, '0.4.3');
  assert.equal(KNOWN_PLUGIN_VERSIONS['zcode-guide'], '0.3.0');
});
