/**
 * test/server-smoke.test.mjs —— server.mjs 的 stdio MCP 协议级冒烟测试
 * （方案 §2.5「MCP 工具面」；实现要求：先 node scripts/build.mjs，再 child_process 拉 dist/server.mjs
 * 走 initialize → tools/list → ztk_doctor_status，断言响应合法）。
 *
 * 形态：node:test + child_process.spawn 真实子进程，newline-delimited JSON-RPC 2.0 over stdio
 * （与 plugin.json mcpServers.zcode-toolkit → node dist/server.mjs 生产形态同一条代码路径）。
 *
 * 【安全边界——硬性】全部 fixture 在 test/.tmp/ 下：
 * - ZTK_STATE_DIR 指向 test/.tmp/server-smock…/state（G0-d g0d.json 与 host_capabilities.json 落点）；
 * - ZTK_DB_PATH / ZTK_V2_DIR / ZTK_PLUGINS_CACHE_DIR / ZTK_RESOURCES_DIR 全部注入 fixture，
 *   绝不读写真实 ~/.zcode、绝不触 ZCode 安装目录；
 * - 子进程 env 基于测试进程 env 裁剪（显式 delete ZCODE_PERSONAL_PROVIDER_CONFIG_FILE，
 *   使 G0-d 观测为确定性「未继承」）；
 * - 零 npm 依赖，不跑 npm install。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { KNOWN_SCHEMA_MIGRATIONS } from '../src/knowledge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'scripts', 'build.mjs');
const DIST_SERVER = path.join(ROOT, 'dist', 'server.mjs');
const TMP = path.join(ROOT, 'test', '.tmp', 'server-smoke');

/* ---------------- fixture 构造 ---------------- */

function freshDir(rel) {
  const dir = path.join(TMP, rel);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造一个 schema_migration 顶部 id 已知识化的 fixture 库（doctor①走 ok 分支）。 */
function makeDb(file) {
  const db = new DatabaseSync(file); // fixture 库，测试可写；被测代码只以 readOnly:true 打开
  db.exec(`
    CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT, app_version TEXT, time_applied INTEGER);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER);
    CREATE TABLE model_usage (id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT, query_source TEXT, started_at INTEGER);
  `);
  const topId = KNOWN_SCHEMA_MIGRATIONS[KNOWN_SCHEMA_MIGRATIONS.length - 1];
  db.prepare('INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)').run(
    topId,
    'deadbeef',
    '0.16.5',
    Date.now(),
  );
  db.close();
}

/* ---------------- JSON-RPC over stdio 客户端 ---------------- */

class McpChildClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.closed = false;
    this.rl = readline.createInterface({ input: child.stdout, terminal: false });
    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return; // 非协议输出（理论不该有；stdout 是纯协议通道）
      }
      if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpcError: msg.error })) : p.resolve(msg.result);
        }
      } else if (msg && typeof msg.method === 'string') {
        this.notifications.push(msg);
      }
    });
  }

  request(method, params, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`request timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  end() {
    return new Promise((resolve) => {
      this.child.on('close', (code) => {
        this.closed = true;
        resolve(code);
      });
      this.child.stdin.end();
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 测试 ---------------- */

test('冒烟：build → dist/server.mjs initialize → tools/list → ztk_doctor_status（fixture 注入）', async () => {
  // —— ① 先跑 scripts/build.mjs（src/ → dist/ 纯拷贝 + 逐文件字节比对；退出码 0 = 校验通过）——
  const build = spawnSync(process.execPath, [BUILD], { encoding: 'utf8', timeout: 120000 });
  assert.equal(build.status, 0, `build.mjs 失败：\nstdout: ${build.stdout}\nstderr: ${build.stderr}`);
  assert.ok(fs.existsSync(DIST_SERVER), 'build 后 dist/server.mjs 应存在');

  // —— ② fixture 环境（绝不触真实 ~/.zcode / 安装目录）——
  const stateDir = freshDir('state');
  const dbDir = freshDir('db');
  const v2Dir = freshDir('v2');
  const cacheDir = freshDir('plugins-cache');
  const resDir = freshDir('resources');
  const dbFile = path.join(dbDir, 'db.sqlite');
  makeDb(dbFile);

  const env = { ...process.env };
  delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE; // G0-d 观测确定性：未继承
  env.ZTK_STATE_DIR = stateDir;
  env.ZTK_DB_PATH = dbFile;
  env.ZTK_V2_DIR = v2Dir;
  env.ZTK_PLUGINS_CACHE_DIR = cacheDir;
  env.ZTK_RESOURCES_DIR = resDir;
  env.ZTK_POLL_SEC = '1';

  const child = spawn(process.execPath, [DIST_SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrChunks = [];
  child.stderr.on('data', (d) => stderrChunks.push(d));
  const client = new McpChildClient(child);

  try {
    // —— ③ initialize：响应合法（协议版本字符串 / serverInfo / 能力声明对齐 showcase §1）——
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'smoke-test-host', version: '0.0.1' },
      capabilities: { roots: { listChanged: false } },
    });
    assert.equal(typeof init.protocolVersion, 'string', 'protocolVersion 必须是字符串');
    assert.ok(init.serverInfo && init.serverInfo.name === 'zcode-toolkit', 'serverInfo.name 必须是 zcode-toolkit');
    assert.ok(init.capabilities && init.capabilities.tools, '能力声明必须含 tools');
    assert.ok(init.capabilities.resources && init.capabilities.resources.subscribe, '能力声明必须含 resources.subscribe');
    client.notify('notifications/initialized');
    await sleep(100); // 通知落地

    // 握手观测落盘（doctor ③ 消费的能力 sidecar）
    const capsFile = path.join(stateDir, 'host_capabilities.json');
    assert.ok(fs.existsSync(capsFile), 'host_capabilities.json 应在 ZTK_STATE_DIR 落盘');
    const caps = JSON.parse(fs.readFileSync(capsFile, 'utf8'));
    assert.equal(caps.clientInfo && caps.clientInfo.name, 'smoke-test-host');
    assert.equal(caps.bannerSupported, true, '自报身份的宿主 → banner 门控通过');

    // G0-d：启动时把 env 继承观测记入独立 g0d.json（S3：server 不再读写 doctor.json——那是
    // SessionStart hook 的单写者文件，RMW 会与 writeSidecar 后写者胜、还会在损坏时覆盖现场）
    const g0dFile = path.join(stateDir, 'g0d.json');
    assert.ok(fs.existsSync(g0dFile), 'g0d.json 应在 ZTK_STATE_DIR 落盘（G0-d 落点）');
    const g0d = JSON.parse(fs.readFileSync(g0dFile, 'utf8'));
    assert.ok(typeof g0d.observedAt === 'number', 'g0d 观测字段存在');
    assert.equal(g0d.envVarSet, false, '测试删除了 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE → 未继承');
    assert.equal(g0d.envVarPath, null);
    assert.equal(typeof g0d.pid, 'number');
    assert.equal(
      fs.existsSync(path.join(stateDir, 'doctor.json')),
      false,
      'server 不得创建/改写 doctor.json（唯一写者 = doctor hook；S3/S4 单写者契约）',
    );

    // —— ④ tools/list：六个 ztk_* 工具齐 + 门控后的 show_status_banner；inputSchema 合法 ——
    const list = await client.request('tools/list', {});
    assert.ok(Array.isArray(list.tools) && list.tools.length >= 6, `工具数 ≥6（实际 ${list.tools && list.tools.length}）`);
    const names = list.tools.map((t) => t.name);
    for (const expected of [
      'ztk_tps_query',
      'ztk_polish',
      'ztk_models_fetch',
      'ztk_provider_config_apply',
      'ztk_doctor_status',
      'ztk_migrate',
    ]) {
      assert.ok(names.includes(expected), `tools/list 缺 ${expected}`);
    }
    for (const t of list.tools) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name} inputSchema 必须是对象`);
    }
    const banner = list.tools.find((t) => t.name === 'show_status_banner');
    assert.ok(banner, '已握手的自报身份宿主 → show_status_banner 已注册');
    assert.ok(banner._meta && banner._meta['openai/outputTemplate'], 'banner _meta 照 showcase §3（outputTemplate）');

    // —— ⑤ tools/call ztk_doctor_status：结构化 DoctorReport 合法（fixture 五项检查全跑）——
    const call = await client.request('tools/call', { name: 'ztk_doctor_status', arguments: {} });
    assert.ok(Array.isArray(call.content) && call.content.length > 0, 'tools/call 必须返回 content');
    assert.equal(call.content[0].type, 'text');
    assert.ok(call.structuredContent, 'tools/call 必须返回 structuredContent');
    assert.notEqual(call.isError, true, `ztk_doctor_status 不应是错误结果：${call.content[0].text}`);
    const report = call.structuredContent;
    assert.equal(typeof report.ranAt, 'number');
    assert.ok(Array.isArray(report.checks) && report.checks.length === 5, '五项检查齐');
    assert.deepEqual(report.checks.map((c) => c.id).sort(), [1, 2, 3, 4, 5]);
    assert.equal(report.residueDetected, false, '空 fixture resources/ 无残留');
    const check1 = report.checks.find((c) => c.id === 1);
    assert.equal(check1.status, 'ok', `db 检查应 ok（fixture 顶部 id 已知识化）：${check1.detail}`);
    assert.equal(report.schemaTopId, KNOWN_SCHEMA_MIGRATIONS[KNOWN_SCHEMA_MIGRATIONS.length - 1]);

    // —— ⑥ 协议宽容性：未知方法（请求）→ -32601；未知工具 → -32602（不崩进程）——
    const unknownMethod = await client.request('no/such/method', {}).then(
      () => null,
      (e) => e.rpcError,
    );
    assert.ok(unknownMethod && unknownMethod.code === -32601, '未知方法应回 -32601');
    const unknownTool = await client.request('tools/call', { name: 'ztk_no_such', arguments: {} }).then(
      () => null,
      (e) => e.rpcError,
    );
    assert.ok(unknownTool && unknownTool.code === -32602, '未知工具应回 -32602');
    const stillAlive = await client.request('ping', {});
    assert.deepEqual(stillAlive, {}, '错误之后进程仍存活且应答 ping');

    // —— ⑦ resources：面板页与实时快照（fixture db 为空库 → tps 零值快照而非错误）——
    const resList = await client.request('resources/list', {});
    const uris = resList.resources.map((r) => r.uri);
    assert.ok(uris.includes('ui://zcode-tokenspeed/dashboard.html'), 'surface 资源（plugin.json resourceUri）必须可列');
    const page = await client.request('resources/read', { uri: 'ui://zcode-tokenspeed/dashboard.html' });
    assert.ok(page.contents[0].text.includes('TPS 详表'), 'dashboard.html 本体可读（三区之一标题在场）');
    const live = await client.request('resources/read', { uri: 'ui://zcode-tokenspeed/live/tps.json' });
    const snap = JSON.parse(live.contents[0].text);
    assert.equal(snap.scope, 'latest_main');
    assert.equal(snap.sessionTotals.turnCount, 0, '空库零值快照（不是错误）');

    // —— ⑧ 订阅 → 周期推送（ZTK_POLL_SEC=1；未订阅期间静默跳过不报错已由 ⑤-⑦ 期间无异常体现）——
    const sub = await client.request('resources/subscribe', { uri: 'ui://zcode-tokenspeed/live/tps.json' });
    assert.deepEqual(sub, {});
    const gotUpdated = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const hit = client.notifications.find(
          (n) => n.method === 'notifications/resources/updated' && n.params && n.params.uri === 'ui://zcode-tokenspeed/live/tps.json',
        );
        if (hit) return hit;
        await sleep(150);
      }
      return null;
    })();
    assert.ok(gotUpdated, '订阅后应收到 notifications/resources/updated（周期推送）');
    await client.request('resources/unsubscribe', { uri: 'ui://zcode-tokenspeed/live/tps.json' });

    // —— ⑨ 干净退出：stdin 结束 → 退出码 0 ——
    const code = await client.end();
    assert.equal(code, 0, `server 应以 0 退出（实际 ${code}）；stderr：${Buffer.concat(stderrChunks).toString('utf8')}`);
  } finally {
    if (!client.closed) {
      child.kill();
      await sleep(100);
    }
  }
});

test('dispatchTool：未知工具 → UNKNOWN_TOOL；ztk_polish 空 draft → INVALID_INPUT（不经 stdio 直调）', async () => {
  const { dispatchTool } = await import('../src/server.mjs');
  await assert.rejects(dispatchTool('ztk_no_such', {}), (err) => err.code === 'UNKNOWN_TOOL');
  await assert.rejects(dispatchTool('ztk_polish', { draft: '   ' }), (err) => err.code === 'INVALID_INPUT');
  // 门控工具名经 dispatchTool 可达（handler 本体；无 fixture db 时为 TpsUnavailableError 降级——不在此断言内容）
  await assert.rejects(dispatchTool('show_status_banner', {}, { env: { ZTK_DB_PATH: path.join(TMP, 'no-such.sqlite') } }), (err) =>
    err.code === 'TPS_UNAVAILABLE' || err.name === 'TpsUnavailableError',
  );
});

test('门控：裸 initialize（无 clientInfo/capabilities）→ show_status_banner 不注册、调用回 -32602、进程不崩', async () => {
  const stateDir = freshDir('state-bare');
  const env = { ...process.env };
  delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  env.ZTK_STATE_DIR = stateDir;
  env.ZTK_DB_PATH = path.join(TMP, 'no-such.sqlite'); // 不可用 db：banner 即便注册也是降级，与本测试无关
  const child = spawn(process.execPath, [DIST_SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new McpChildClient(child);
  try {
    // 无 clientInfo、无 capabilities 的裸握手 → 能力缺失明示不支持（banner 不注册，不报错）
    const init = await client.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(typeof init.protocolVersion, 'string');
    const list = await client.request('tools/list', {});
    const names = list.tools.map((t) => t.name);
    assert.equal(names.includes('show_status_banner'), false, '未自报身份的宿主 → banner 跳过注册');
    assert.equal(names.filter((n) => n.startsWith('ztk_')).length, 6, '六个核心工具恒注册');
    const bareCall = await client.request('tools/call', { name: 'show_status_banner', arguments: {} }).then(
      () => null,
      (e) => e.rpcError,
    );
    assert.ok(bareCall && bareCall.code === -32602, '未注册工具调用 → -32602（协议级，非崩溃）');
    const ping = await client.request('ping', {});
    assert.deepEqual(ping, {}, '进程仍存活');
    const caps = JSON.parse(fs.readFileSync(path.join(stateDir, 'host_capabilities.json'), 'utf8'));
    assert.equal(caps.bannerSupported, false);
    assert.deepEqual(caps.unsupported, ['show_status_banner'], '能力缺失在 sidecar 里明示不支持');
    const code = await client.end();
    assert.equal(code, 0);
  } finally {
    if (!client.closed) {
      child.kill();
      await sleep(100);
    }
  }
});
