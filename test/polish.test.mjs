/**
 * polish.test.mjs —— src/polish.mjs 契约测试（只跑本文件；零 npm 依赖，全部 node: 内置）。
 *
 * 覆盖（对应任务验收四点 + 契约错误面）：
 *   1. P0-2 回归（§5 #1）：首试 500 → 重试 200+choices → **success**（旧 bug：重试成功被当失败丢弃）。
 *   2. 匹配函数同源（§5 #12）：resolvePolishModel 的解析结果 = polish 实际外呼用的 model/凭据。
 *   3. 解析链顺序（§1.1⑦ ①→②→③→④）：explicit > enhance_config 热配置 > provider_config 默认 > NO_MODEL 引导。
 *   4. 错误语义：AUTH(401 不重试) / UPSTREAM(500 恰重试一次) / NETWORK(连接拒绝、超时) / PARSE(2xx 不可解析)。
 *   5. 凭据覆盖：ZTK_POLISH_KEY / ZTK_POLISH_BASE_URL 仅显式覆盖、留空走 provider_config。
 *   6. 热配置每次调用重读（改文件即生效——legacy :1511 行为）。
 *
 * 安全边界：fixture 一律注入 test/data/polish/ 与 test/.tmp/polish/ 路径，绝不触真实 ~/.zcode；
 * 本地假上游用 node:http 监听 127.0.0.1 随机端口；不写 ZCode 安装目录。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PolishError, polish, resolvePolishModel } from '../src/polish.mjs';

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(TEST_ROOT, 'data', 'polish');
const TMP = join(TEST_ROOT, '.tmp', 'polish');

/* -------------------------------------------------------------------------
 * helpers
 * ------------------------------------------------------------------------- */

/** 断言「抛出的是 PolishError 且 code 匹配」；返回该错误供进一步断言 message/detail。 */
async function assertPolishError(promise, code) {
  await assert.rejects(
    promise,
    (err) => {
      assert.ok(err instanceof PolishError, '应抛 PolishError，实际 ' + (err && err.constructor && err.constructor.name));
      assert.equal(err.name, 'PolishError');
      assert.equal(err.code, code, 'code 应为 ' + code + '，实际 ' + err.code);
      return true;
    },
  );
  // assert.rejects 不回传 err，取一次拿 message/detail
  let captured = null;
  try { await promise; } catch (err) { captured = err; }
  return captured;
}

/** 临时 env 注入（用后必还原）。 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * 本地假上游：handler(info, seq) 返回 {status, body}（body 对象自动 JSON 化）；
 * 返回 null 表示挂起不响应（超时用）。记录每次请求的 url/headers/body 到 seen。
 */
async function startFakeUpstream(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const info = { url: req.url, headers: req.headers, body };
      seen.push(info);
      const r = handler(info, seen.length);
      if (r === null) return; // 挂起：不响应（超时测试）
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body === undefined ? {} : r.body));
    });
  });
  await new Promise((z) => server.listen(0, '127.0.0.1', z));
  const port = server.address().port;
  return {
    seen,
    url: 'http://127.0.0.1:' + port,
    close: async () => {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((z) => server.close(z));
    },
  };
}

/** 在 test/.tmp/polish/<name>/ 组一个 v2 fixture（provider_config 指向假上游）。 */
async function mkV2Dir(name, { baseUrl, apiKey = 'sk-svc', apiType = 'openai-compatible', modelId = 'm-svc', enhance } = {}) {
  const dir = join(TMP, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const providerConfig = {
    schemaVersion: 1,
    config: {
      providerOrder: ['prov-svc'],
      providerConfigRules: {
        providerRules: [
          {
            providerId: 'prov-svc',
            providerName: '服务商',
            config: {
              group: 'custom',
              access: { type: 'api_key', apiKey },
              api: { type: apiType, baseUrl },
              personalModelIds: [modelId],
              modelOrder: [modelId],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
  await writeFile(join(dir, 'provider_config.json'), JSON.stringify(providerConfig, null, 2) + '\n', 'utf-8');
  if (enhance !== undefined) {
    await writeFile(join(dir, 'enhance_config.json'), JSON.stringify(enhance, null, 2) + '\n', 'utf-8');
  }
  return dir;
}

/* -------------------------------------------------------------------------
 * 3. 解析链顺序（§1.1⑦ ①→②→③；ref/label 读 UI 的档不复刻——无 DOM，行为变更已声明）
 * ------------------------------------------------------------------------- */

test('解析链：① 显式 modelId（pid/mid 形态）压过热配置与清单默认', async () => {
  // chain-enhance 有热配置指向 prov-b/m-b9；显式给 prov-b/m-b1 必须胜出
  const r = await resolvePolishModel({ v2Dir: join(DATA, 'chain-enhance'), modelId: 'prov-b/m-b1' });
  assert.equal(r.source, 'explicit');
  assert.equal(r.modelId, 'm-b1');
  assert.equal(r.providerId, 'prov-b');
  assert.equal(r.apiKey, 'sk-b');
  assert.equal(r.baseUrl, 'http://127.0.0.1:9/b');
});

test('解析链：① 显式裸 modelId 经供应商模型清单定位（含 providerModelRules 来源）', async () => {
  // m-b1 只存在于 providerModelRules（prov-b 的 personalModelIds 为空）
  const r = await resolvePolishModel({ v2Dir: join(DATA, 'chain'), modelId: 'm-b1' });
  assert.equal(r.source, 'explicit');
  assert.equal(r.modelId, 'm-b1');
  assert.equal(r.providerId, 'prov-b');
  assert.equal(r.apiKey, 'sk-b');
});

test('解析链：② enhance_config 热配置（不校验模型表成员——legacy ⓪ 档口径）', async () => {
  const r = await resolvePolishModel({ v2Dir: join(DATA, 'chain-enhance') });
  assert.equal(r.source, 'enhance_config');
  assert.equal(r.modelId, 'm-b9'); // 不在 prov-b 模型清单里，仍按热配置指哪打哪
  assert.equal(r.providerId, 'prov-b');
  assert.equal(r.apiKey, 'sk-b');
});

test('解析链：③ provider_config 默认 = providerOrder 优先 + builtin/account 垫底 + 首个模型', async () => {
  const r = await resolvePolishModel({ v2Dir: join(DATA, 'chain') });
  assert.equal(r.source, 'provider_config');
  // providerOrder 把 prov-a 排前（虽然 rule 文件序里 builtin:glm 在最前）；builtin 一律垫底
  assert.equal(r.providerId, 'prov-a');
  assert.equal(r.modelId, 'm-a1'); // personalModelIds 首项
  assert.equal(r.apiKey, 'sk-a');
  assert.equal(r.baseUrl, 'http://127.0.0.1:9/a');
});

test('解析链：② 热配置只给 providerId 不给 modelId = 跳档走 ③（legacy 口径）', async () => {
  const r = await resolvePolishModel({ v2Dir: join(DATA, 'enhance-partial') });
  assert.equal(r.source, 'provider_config');
  assert.equal(r.modelId, 'm-a1');
});

test('解析链：ZTK_V2_DIR 环境变量注入生效（入参缺省时）', async () => {
  await withEnv({ ZTK_V2_DIR: join(DATA, 'chain') }, async () => {
    const r = await resolvePolishModel({});
    assert.equal(r.source, 'provider_config');
    assert.equal(r.modelId, 'm-a1');
  });
});

test('热配置每次调用重读：改 enhance_config.json 即生效（legacy :1511 行为）', async () => {
  const dir = await mkV2Dir('hot-reload', { baseUrl: 'http://127.0.0.1:9/x' });
  await writeFile(join(dir, 'enhance_config.json'), JSON.stringify({ providerId: 'prov-svc', modelId: 'm-svc' }), 'utf-8');
  const r1 = await resolvePolishModel({ v2Dir: dir });
  assert.equal(r1.source, 'enhance_config');
  assert.equal(r1.modelId, 'm-svc');
  await writeFile(join(dir, 'enhance_config.json'), JSON.stringify({ providerId: 'prov-svc', modelId: 'm-svc-v2' }), 'utf-8');
  const r2 = await resolvePolishModel({ v2Dir: dir });
  assert.equal(r2.source, 'enhance_config');
  assert.equal(r2.modelId, 'm-svc-v2');
});

/* -------------------------------------------------------------------------
 * ④ 无模型报错引导
 * ------------------------------------------------------------------------- */

test('④ 无可用模型：NO_MODEL + 引导文案（无文件 / 空清单 / 供应商不可用）', async () => {
  for (const dir of ['no-files', 'empty', 'unusable']) {
    const err = await assertPolishError(resolvePolishModel({ v2Dir: join(DATA, dir) }), 'NO_MODEL');
    // 引导文案三去向：面板拉取（ztk_models_fetch/provider_config_apply）、热配置、userConfig 覆盖
    assert.match(err.message, /ztk_models_fetch/);
    assert.match(err.message, /ztk_provider_config_apply/);
    assert.match(err.message, /enhance_config\.json/);
    assert.match(err.message, /polish_key/);
  }
});

test('④ 显式指定命不中：立即 NO_MODEL 说明原因，不静默换模型顶替', async () => {
  const err = await assertPolishError(
    resolvePolishModel({ v2Dir: join(DATA, 'empty'), modelId: 'prov-b/m-b1' }),
    'NO_MODEL',
  );
  assert.match(err.message, /prov-b/);
  assert.equal(err.detail.modelId, 'prov-b/m-b1');
  // 裸 modelId 不在任何清单：同样立即失败并说明
  const err2 = await assertPolishError(
    resolvePolishModel({ v2Dir: join(DATA, 'empty'), modelId: 'm-none' }),
    'NO_MODEL',
  );
  assert.match(err2.message, /m-none/);
});

/* -------------------------------------------------------------------------
 * P0-4 同族纪律：文件存在但读失败/损坏 → PARSE 中止（禁止当空配置继续）
 * ------------------------------------------------------------------------- */

test('provider_config.json 存在但 JSON 损坏 → PARSE 中止', async () => {
  const err = await assertPolishError(resolvePolishModel({ v2Dir: join(DATA, 'corrupt') }), 'PARSE');
  assert.match(err.message, /provider_config\.json/);
});

test('enhance_config.json 存在但 JSON 损坏 → PARSE 中止（不静默跳档）', async () => {
  await assertPolishError(resolvePolishModel({ v2Dir: join(DATA, 'enhance-corrupt') }), 'PARSE');
});

/* -------------------------------------------------------------------------
 * 1. P0-2 回归（§5 #1）：重试分支复用首试响应处理，2xx 必解析 choices/content 返回 success
 * ------------------------------------------------------------------------- */

test('P0-2 回归：chat-completions 首试 500 → 重试 200+choices → success（恰 2 次请求）', async () => {
  const upstream = await startFakeUpstream((_info, seq) =>
    seq === 1
      ? { status: 500, body: { error: { message: 'upstream boom' } } }
      : { status: 200, body: { choices: [{ message: { content: 'ENHANCED-TEXT' } }] } },
  );
  try {
    const v2Dir = await mkV2Dir('retry-500-then-200', { baseUrl: upstream.url + '/v1' });
    const result = await polish('帮我写下这个函数', { v2Dir, timeoutMs: 10000 });
    // 旧 bug 现场（zcode_patcher.py:1730-1739）：重试 2xx 被无条件 resolve({success:!1}) 丢弃。
    // 此处断言重试成功被如实返回：
    assert.equal(result.text, 'ENHANCED-TEXT');
    assert.equal(result.modelId, 'm-svc');
    assert.equal(result.effortLevel, null);
    assert.equal(typeof result.elapsedMs, 'number');
    assert.ok(result.elapsedMs >= 0);
    // baseUrl 以 /v1 结尾 → 候选地址去重后仅 1 个 → 恰好「首试 + 重试」2 次请求，全部打在 /v1/chat/completions
    assert.equal(upstream.seen.length, 2);
    assert.ok(upstream.seen.every((r) => r.url === '/v1/chat/completions'));
  } finally {
    await upstream.close();
  }
});

test('P0-2 回归：anthropic-messages 首试 500 → 重试 200+content[] → success', async () => {
  const upstream = await startFakeUpstream((_info, seq) =>
    seq === 1
      ? { status: 503, body: { error: 'overloaded' } }
      : { status: 200, body: { content: [{ type: 'text', text: '润色结果' }] } },
  );
  try {
    const v2Dir = await mkV2Dir('retry-anthropic', { baseUrl: upstream.url + '/v1', apiType: 'anthropic-messages' });
    const result = await polish('draft text', { v2Dir, timeoutMs: 10000 });
    assert.equal(result.text, '润色结果');
    assert.equal(upstream.seen.length, 2);
    assert.ok(upstream.seen.every((r) => r.url === '/v1/messages'));
    // anthropic 请求体形态：system + messages[0].user，无 reasoning_effort 键
    const body = upstream.seen[0].body;
    assert.equal(typeof body.system, 'string');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.reasoning_effort, undefined);
  } finally {
    await upstream.close();
  }
});

/* -------------------------------------------------------------------------
 * 2. 匹配函数同源（§5 #12）：校验（resolvePolishModel）与实际调用（polish）同一结果
 * ------------------------------------------------------------------------- */

test('同源（#12）：polish 实际外呼的 model/凭据 = resolvePolishModel 的解析结果', async () => {
  const upstream = await startFakeUpstream(() => ({
    status: 200,
    body: { choices: [{ message: { content: 'OK' } }] },
  }));
  try {
    const v2Dir = await mkV2Dir('same-source', { baseUrl: upstream.url + '/gw', apiKey: 'sk-src', modelId: 'm-src' });
    // 非默认档也一致：热配置指定模型
    await writeFile(join(v2Dir, 'enhance_config.json'), JSON.stringify({ providerId: 'prov-svc', modelId: 'm-src-custom' }), 'utf-8');
    const resolved = await resolvePolishModel({ v2Dir });
    assert.equal(resolved.source, 'enhance_config');
    assert.equal(resolved.modelId, 'm-src-custom');
    assert.equal(resolved.apiKey, 'sk-src');
    await polish('same source draft', { v2Dir, timeoutMs: 10000 });
    assert.equal(upstream.seen.length, 1);
    const sent = upstream.seen[0];
    assert.equal(sent.body.model, resolved.modelId, '外呼 body.model 必须与解析结果同源');
    assert.equal(sent.headers.authorization, 'Bearer ' + resolved.apiKey, '外呼凭据必须与解析结果同源');
    assert.equal(sent.headers['x-api-key'], resolved.apiKey);
    // baseUrl 不以 /v1 结尾 → 首选候选 = <base>/v1/chat/completions
    assert.equal(sent.url, '/gw/v1/chat/completions');
  } finally {
    await upstream.close();
  }
});

/* -------------------------------------------------------------------------
 * 5. 凭据覆盖：ZTK_POLISH_KEY / ZTK_POLISH_BASE_URL 仅显式覆盖、留空走 provider_config
 * ------------------------------------------------------------------------- */

test('凭据覆盖：ZTK_POLISH_KEY 非空 → 覆盖；空串 → 完全走 provider_config', async () => {
  const upstream = await startFakeUpstream(() => ({
    status: 200,
    body: { choices: [{ message: { content: 'OK' } }] },
  }));
  try {
    const v2Dir = await mkV2Dir('cred-override', { baseUrl: upstream.url + '/v1', apiKey: 'sk-provider' });
    await withEnv({ ZTK_POLISH_KEY: 'sk-override' }, async () => {
      await polish('draft', { v2Dir, timeoutMs: 10000 });
      assert.equal(upstream.seen[upstream.seen.length - 1].headers.authorization, 'Bearer sk-override');
    });
    await withEnv({ ZTK_POLISH_KEY: '' }, async () => {
      const resolved = await resolvePolishModel({ v2Dir });
      assert.equal(resolved.apiKey, 'sk-provider', '空串 = 不覆盖，走 provider_config');
      await polish('draft', { v2Dir, timeoutMs: 10000 });
      assert.equal(upstream.seen[upstream.seen.length - 1].headers.authorization, 'Bearer sk-provider');
    });
  } finally {
    await upstream.close();
  }
});

test('凭据覆盖：ZTK_POLISH_BASE_URL 把请求指到另一上游', async () => {
  const upstreamA = await startFakeUpstream(() => ({ status: 500, body: { error: 'A' } }));
  const upstreamB = await startFakeUpstream(() => ({
    status: 200,
    body: { choices: [{ message: { content: 'FROM-B' } }] },
  }));
  try {
    const v2Dir = await mkV2Dir('baseurl-override', { baseUrl: upstreamA.url + '/v1' });
    await withEnv({ ZTK_POLISH_BASE_URL: upstreamB.url + '/v1' }, async () => {
      const result = await polish('draft', { v2Dir, timeoutMs: 10000 });
      assert.equal(result.text, 'FROM-B');
      assert.equal(upstreamB.seen.length, 1);
      assert.equal(upstreamA.seen.length, 0, '覆盖后不应再打到原 baseUrl');
    });
  } finally {
    await upstreamA.close();
    await upstreamB.close();
  }
});

/* -------------------------------------------------------------------------
 * 4. 错误语义与重试边界
 * ------------------------------------------------------------------------- */

test('401 → AUTH 且不重试（恰 1 次请求）', async () => {
  const upstream = await startFakeUpstream(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
  try {
    const v2Dir = await mkV2Dir('auth-401', { baseUrl: upstream.url + '/v1' });
    const err = await assertPolishError(polish('draft', { v2Dir, timeoutMs: 10000 }), 'AUTH');
    assert.equal(err.detail.status, 401);
    assert.match(err.message, /bad key/);
    assert.equal(upstream.seen.length, 1, 'AUTH 不可重试');
  } finally {
    await upstream.close();
  }
});

test('500 持续 → UPSTREAM，恰重试一次（共 2 次请求）', async () => {
  const upstream = await startFakeUpstream(() => ({ status: 500, body: { error: { message: 'down' } } }));
  try {
    const v2Dir = await mkV2Dir('upstream-500', { baseUrl: upstream.url + '/v1' });
    const err = await assertPolishError(polish('draft', { v2Dir, timeoutMs: 10000 }), 'UPSTREAM');
    assert.equal(err.detail.status, 500);
    assert.equal(upstream.seen.length, 2, '瞬时失败恰重试一次');
  } finally {
    await upstream.close();
  }
});

test('429 → UPSTREAM 不重试（stub 契约：仅 NETWORK/UPSTREAM≥500 重试）', async () => {
  const upstream = await startFakeUpstream(() => ({ status: 429, body: { error: { message: 'rate' } } }));
  try {
    const v2Dir = await mkV2Dir('upstream-429', { baseUrl: upstream.url + '/v1' });
    const err = await assertPolishError(polish('draft', { v2Dir, timeoutMs: 10000 }), 'UPSTREAM');
    assert.equal(err.detail.status, 429);
    assert.equal(upstream.seen.length, 1, '429 按契约不重试');
  } finally {
    await upstream.close();
  }
});

test('连接拒绝 → NETWORK（重试一次后抛）', async () => {
  // 占一个随机端口然后关掉，保证连接拒绝
  const ghost = await startFakeUpstream(() => ({ status: 200, body: {} }));
  const port = Number(new URL(ghost.url).port);
  await ghost.close();
  const v2Dir = await mkV2Dir('network-refused', { baseUrl: 'http://127.0.0.1:' + port + '/v1' });
  const err = await assertPolishError(polish('draft', { v2Dir, timeoutMs: 5000 }), 'NETWORK');
  assert.ok(/外呼失败/.test(err.message));
});

test('上游挂起 → 超时归 NETWORK（timeoutMs 生效，重试一次后抛）', async () => {
  const upstream = await startFakeUpstream(() => null); // 永不响应
  try {
    const v2Dir = await mkV2Dir('timeout', { baseUrl: upstream.url + '/v1' });
    const t0 = Date.now();
    const err = await assertPolishError(polish('draft', { v2Dir, timeoutMs: 400 }), 'NETWORK');
    assert.match(err.message, /超时/);
    assert.equal(upstream.seen.length, 2, '超时重试一次');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 400 * 2, '两次尝试各吃满超时（实测 ' + elapsed + 'ms）');
  } finally {
    await upstream.close();
  }
});

test('2xx 但解析不出文本 → PARSE（非 JSON / 空内容）；responses 形态 output_text 与 choices[0].text 可解析', async () => {
  // 非 JSON 2xx
  {
    const upstream = await startFakeUpstream(() => ({ status: 200, body: 'plain-not-json' }));
    try {
      const v2Dir = await mkV2Dir('parse-nonjson', { baseUrl: upstream.url + '/v1' });
      const err = await assertPolishError(polish('draft', { v2Dir, timeoutMs: 10000 }), 'PARSE');
      assert.match(err.message, /解析失败/);
    } finally { await upstream.close(); }
  }
  // 2xx 空 choices 内容
  {
    const upstream = await startFakeUpstream(() => ({ status: 200, body: { choices: [{ message: { content: '' } }] } }));
    try {
      const v2Dir = await mkV2Dir('parse-empty', { baseUrl: upstream.url + '/v1' });
      const err = await assertPolishError(polish('draft', { v2Dir, timeoutMs: 10000 }), 'PARSE');
      assert.match(err.message, /空内容/);
    } finally { await upstream.close(); }
  }
  // responses 形态 output_text
  {
    const upstream = await startFakeUpstream(() => ({ status: 200, body: { output_text: 'FROM-RESPONSES' } }));
    try {
      const v2Dir = await mkV2Dir('parse-responses', { baseUrl: upstream.url + '/v1' });
      const result = await polish('draft', { v2Dir, timeoutMs: 10000 });
      assert.equal(result.text, 'FROM-RESPONSES');
    } finally { await upstream.close(); }
  }
  // choices[0].text 分支
  {
    const upstream = await startFakeUpstream(() => ({ status: 200, body: { choices: [{ text: 'FROM-TEXT' }] } }));
    try {
      const v2Dir = await mkV2Dir('parse-choicestext', { baseUrl: upstream.url + '/v1' });
      const result = await polish('draft', { v2Dir, timeoutMs: 10000 });
      assert.equal(result.text, 'FROM-TEXT');
    } finally { await upstream.close(); }
  }
});

/* -------------------------------------------------------------------------
 * 入参防御 + 请求体形态
 * ------------------------------------------------------------------------- */

test('draft 非字符串/空白 → 标准 TypeError（调用侧先验的防御式同款）', async () => {
  await assert.rejects(polish('', { v2Dir: join(DATA, 'chain') }), TypeError);
  await assert.rejects(polish('   ', { v2Dir: join(DATA, 'chain') }), TypeError);
});

test('请求体形态：system 提示词 + 用户草稿注入 + effortLevel 透传 reasoning_effort', async () => {
  const upstream = await startFakeUpstream(() => ({
    status: 200,
    body: { choices: [{ message: { content: 'OK' } }] },
  }));
  try {
    const v2Dir = await mkV2Dir('body-shape', { baseUrl: upstream.url + '/v1' });
    await polish('我的草稿ABC123', { v2Dir, timeoutMs: 10000, effortLevel: 'high' });
    const body = upstream.seen[0].body;
    assert.equal(body.model, 'm-svc');
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_effort, 'high');
    assert.ok(body.messages[0].role === 'system' && body.messages[0].content.length > 50);
    assert.equal(body.messages[1].role, 'user');
    assert.ok(body.messages[1].content.includes('我的草稿ABC123'));
    const result2 = { ...(await polish('second', { v2Dir, timeoutMs: 10000 })) };
    assert.equal(result2.effortLevel, null, '未传 effortLevel 且无热配置 → null');
  } finally {
    await upstream.close();
  }
});
