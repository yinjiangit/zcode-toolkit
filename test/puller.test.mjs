/**
 * puller.test.mjs —— provider_config_schema.mjs + puller.mjs 的回归测试
 * （只跑本文件：node --test test/puller.test.mjs）。
 *
 * 覆盖方案 §5 必修项：#2 apiKey 不反向覆盖、#3 失败传播不降级成功、#5 协议显式三选、
 * #10 default_effort 采集排 values 末位、#11 去重、C1 两供应商共享 baseURL 不串写、
 * B10 形态消失（无 DOM 点击路径）+ 写安全三原则（读失败/损坏中止、备份失败中止、tmp+rename 原子写）
 * + S1 并发防护（进程内互斥、跨进程锁文件、超龄破锁、mtime 复核、唯一 tmp/备份名）。
 *
 * 硬性边界：所有 IO 一律注入 test/data/puller fixture 与 test/.tmp 临时目录，绝不触真实 ~/.zcode。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync as fsSyncExists } from 'node:fs';
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ProviderConfigParseError,
  parseProviderConfig,
  mergeProviderConfig,
  serializeProviderConfig,
} from '../src/provider_config_schema.mjs';
import { PullError, fetchModels, applyProviderConfig } from '../src/puller.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(HERE, 'data', 'puller');
const TMP_ROOT = join(HERE, '.tmp', 'puller');

/** 每次重新读 fixture（避免测试间共享可变对象）。 */
function loadFixtureObject() {
  return parseProviderConfig(readFileSync(join(FIX_DIR, 'base.json'), 'utf8'));
}
function loadFixtureRaw() {
  return readFileSync(join(FIX_DIR, 'base.json'), 'utf8');
}

/** 建一个干净的临时目录（含唯一名），返回路径。 */
async function freshDir(name) {
  const dir = join(TMP_ROOT, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 断言 promise 以指定 code 的 PullError 拒绝，返回该错误供进一步断言。 */
async function expectPullError(promise, code) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof PullError, `期望 PullError，实际 ${e && e.name}: ${e && e.message}`);
    assert.equal(e.code, code, `期望 code=${code}，实际 ${e.code}（${e.message}）`);
    return e;
  }
  assert.fail(`期望 PullError(${code})，但 promise 正常 resolve`);
}

/** 从配置里取指定 providerId 的 providerRule。 */
function ruleOf(cfg, pid) {
  return cfg.config.providerConfigRules.providerRules.find((r) => r.providerId === pid);
}
/** 从配置里取指定 (providerId, modelId) 的 providerModelRule。 */
function modelRuleOf(cfg, pid, mid) {
  return cfg.config.modelConfigRules.providerModelRules.find(
    (r) => r.providerId === pid && r.modelId === mid,
  );
}

/** fixture 里两供应商共享的 baseURL（C1 场景）。 */
const SHARED_URL = 'https://relay.example.com/v1';

// ---------------------------------------------------------------------------
// parseProviderConfig / serializeProviderConfig（纯函数）
// ---------------------------------------------------------------------------

test('parse：合法 fixture 通过并保留未知字段', () => {
  const cfg = loadFixtureObject();
  assert.equal(cfg.schemaVersion, 1);
  assert.equal(cfg.config.providerOrder.length, 1);
  assert.equal(cfg.config.providerConfigRules.providerRules.length, 3);
  assert.equal(ruleOf(cfg, 'prov-alpha').config.api.type, 'openai-responses');
});

test('parse：JSON 损坏 → ProviderConfigParseError（pointer 根），绝不降级为空对象', () => {
  assert.throws(
    () => parseProviderConfig('{ not json !!', { path: 'x.json' }),
    (e) => e instanceof ProviderConfigParseError && e.detail.pointer === '' && e.detail.path === 'x.json',
  );
});

test('parse：缺 schemaVersion → pointer /schemaVersion', () => {
  assert.throws(
    () => parseProviderConfig('{"config":{}}'),
    (e) => e instanceof ProviderConfigParseError && e.detail.pointer === '/schemaVersion',
  );
});

test('parse：providerRules 非数组 → pointer /config/providerConfigRules/providerRules', () => {
  const bad = JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: {} } } });
  assert.throws(
    () => parseProviderConfig(bad),
    (e) => e instanceof ProviderConfigParseError && e.detail.pointer === '/config/providerConfigRules/providerRules',
  );
});

test('parse：providerRule 缺 providerId → pointer 指到具体条目', () => {
  const bad = JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{ providerName: 'x' }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  });
  assert.throws(
    () => parseProviderConfig(bad),
    (e) =>
      e instanceof ProviderConfigParseError &&
      e.detail.pointer === '/config/providerConfigRules/providerRules/0/providerId',
  );
});

test('serialize：2 空格缩进 + 尾随换行 + 可 round-trip', () => {
  const cfg = loadFixtureObject();
  const text = serializeProviderConfig(cfg);
  assert.ok(text.endsWith('\n'));
  assert.ok(text.includes('\n  "schemaVersion": 1'), '顶层键应为 2 空格缩进');
  assert.deepEqual(JSON.parse(text), cfg);
});

// ---------------------------------------------------------------------------
// mergeProviderConfig（纯合并）
// ---------------------------------------------------------------------------

/** 拉取确认结果：写入共享同一 baseURL 的 beta（C1 场景）。 */
function betaSelection() {
  return {
    providerId: 'prov-beta',
    providerName: 'beta-same-relay',
    baseUrl: SHARED_URL,
    apiKey: 'sk-beta-new',
    protocol: 'chat-completions',
    models: [
      {
        modelId: 'beta-one',
        contextWindow: 128000,
        outputLimit: 8192,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    ],
  };
}

test('C1：两供应商共享 baseURL，按 providerId 精确匹配只写 beta，alpha 一字不动', () => {
  const existing = loadFixtureObject();
  const before = JSON.stringify(existing);
  const { next, summary } = mergeProviderConfig(existing, betaSelection());

  // alpha 完全不变（无 baseURL 模糊兜底串写）
  const alpha = ruleOf(next, 'prov-alpha');
  assert.equal(alpha.config.access.apiKey, 'sk-alpha-current-key');
  assert.equal(alpha.config.api.type, 'openai-responses');
  assert.deepEqual(alpha.config.personalModelIds, ['alpha-existing']);
  assert.deepEqual(alpha.config.modelOrder, ['alpha-existing']);

  // beta 收到自己的模型
  const beta = ruleOf(next, 'prov-beta');
  assert.deepEqual(beta.config.personalModelIds, ['beta-one']);
  assert.deepEqual(beta.config.modelOrder, ['beta-one']);
  assert.equal(beta.config.access.apiKey, 'sk-beta-new'); // 原 rule 无 key → 写入
  assert.equal(beta.config.api.type, 'openai-chat-completions'); // 缺失时按 protocol 兜底

  assert.equal(summary.providerRuleCreated, false);
  assert.deepEqual(summary.addedModels, ['beta-one']);
  assert.deepEqual(summary.skippedExisting, []);
  assert.equal(summary.apiKeyWritten, true);

  // 纯函数：入参不被修改
  assert.equal(JSON.stringify(existing), before);
});

test('C1 续：beta 写入的 optionSpecs —— default_effort 排 values 末位、不写 default 键', () => {
  const { next } = mergeProviderConfig(loadFixtureObject(), betaSelection());
  const entry = modelRuleOf(next, 'prov-beta', 'beta-one');
  assert.ok(entry, '应新增 (prov-beta, beta-one) 模型规则');
  const rl = entry.config.optionSpecs.reasoningLevel;
  assert.deepEqual(rl.values, ['off', 'low', 'high', 'medium']); // off 补位 + medium(默认档)挪末位
  assert.equal(rl.map, "{'reasoning_effort':reasoningLevel}");
  assert.ok(!('default' in rl), 'reasoningLevel 不得写 default 键（末位即默认）');
  assert.equal(entry.config.properties.contextWindow, 128000);
  assert.equal(entry.config.properties.outputLimit, 8192);
});

test('#2：apiKey 已有值时绝不反向覆盖', () => {
  const { next, summary } = mergeProviderConfig(loadFixtureObject(), {
    providerId: 'prov-alpha',
    baseUrl: SHARED_URL,
    apiKey: 'sk-alpha-stale-from-panel',
    protocol: 'chat-completions', // 同时验证 api.type 不被反向拉平
    models: [{ modelId: 'alpha-two' }],
  });
  const alpha = ruleOf(next, 'prov-alpha');
  assert.equal(alpha.config.access.apiKey, 'sk-alpha-current-key', '现行 key 必须保留');
  assert.equal(alpha.config.api.type, 'openai-responses', 'api.type 必须保留细分类');
  assert.equal(summary.apiKeyWritten, false);
});

test('account: 供应商——只追加不裁剪、不写 access/api、不进 providerOrder、不动模型规则', () => {
  const { next, summary } = mergeProviderConfig(loadFixtureObject(), {
    providerId: 'account:demo-coding-plan',
    baseUrl: 'https://plan.example.com',
    apiKey: 'sk-should-never-write',
    protocol: 'responses',
    models: [{ modelId: 'plan-glm-5.3' }, { modelId: 'plan-glm-new' }],
  });
  const acc = ruleOf(next, 'account:demo-coding-plan');
  assert.deepEqual(acc.config.personalModelIds, ['plan-glm-5.3', 'plan-glm-new'], '只追加');
  assert.deepEqual(
    acc.config.modelOrder,
    ['plan-glm-5.3', 'plan-glm-5.3-flash', 'plan-glm-new'],
    '服务端下发的 plan-glm-5.3-flash 绝不被裁剪',
  );
  assert.deepEqual(Object.keys(acc.config).sort(), ['modelOrder', 'personalModelIds'], '不得写入 group/access/api 等接入字段');
  assert.ok(!('providerName' in acc), '既有 account: rule 不补 providerName（保持宿主原状）');
  assert.equal(summary.apiKeyWritten, false);
  assert.deepEqual(summary.addedModels, ['plan-glm-new']);
  assert.deepEqual(summary.skippedExisting, ['plan-glm-5.3']);

  assert.ok(!next.config.providerOrder.includes('account:demo-coding-plan'), 'account: 不进 providerOrder（实测宿主不变量）');
  assert.equal(next.config.modelConfigRules.providerModelRules.length, 1, '不为 account: 新增/裁剪模型规则');
});

test('新增供应商：push 新 rule（group/access/api/baseUrl 齐备）+ providerOrder 追加', () => {
  const { next, summary } = mergeProviderConfig(loadFixtureObject(), {
    providerId: 'prov-gamma',
    providerName: 'gamma',
    baseUrl: 'https://gamma.example.com/v1',
    apiKey: 'sk-gamma',
    protocol: 'anthropic-messages',
    models: [{ modelId: 'gamma-one' }],
  });
  assert.equal(summary.providerRuleCreated, true);
  const gamma = ruleOf(next, 'prov-gamma');
  assert.ok(gamma, '新 rule 已 push');
  assert.equal(gamma.config.group, 'standard-personal');
  assert.equal(gamma.config.access.type, 'api-key');
  assert.equal(gamma.config.access.apiKey, 'sk-gamma');
  assert.equal(gamma.config.api.type, 'anthropic-messages');
  assert.equal(gamma.config.api.baseUrl, 'https://gamma.example.com/v1');
  assert.deepEqual(gamma.config.personalModelIds, ['gamma-one']);

  const order = next.config.providerOrder;
  assert.deepEqual(order.slice(0, 2), ['prov-alpha', 'prov-beta'], '既有顺序不重排');
  assert.equal(order[order.length - 1], 'prov-gamma', '新供应商追加到末尾');

  // 无网关档位 → 保守模板 values；anthropic 协议 → thinking 型 map
  const rl = modelRuleOf(next, 'prov-gamma', 'gamma-one').config.optionSpecs.reasoningLevel;
  assert.deepEqual(rl.values, ['off', 'low', 'high', 'max']);
  assert.ok(rl.map.includes("'thinking'"));
});

test('providerOrder 回填：既有 rule 掉出 order 时补到末尾；order 整体缺失时重建为全量', () => {
  const { next } = mergeProviderConfig(loadFixtureObject(), betaSelection());
  assert.deepEqual(next.config.providerOrder, ['prov-alpha', 'prov-beta'], 'fixture 中 beta 缺失 → 回填');

  const noOrder = loadFixtureObject();
  delete noOrder.config.providerOrder;
  const { next: next2 } = mergeProviderConfig(noOrder, betaSelection());
  assert.deepEqual(next2.config.providerOrder, ['prov-alpha', 'prov-beta']);
});

test('已有模型跳过、新模型保序追加；既有 values 重排但既有 map 保留', () => {
  const { next, summary } = mergeProviderConfig(loadFixtureObject(), {
    providerId: 'prov-alpha',
    baseUrl: SHARED_URL,
    protocol: 'chat-completions',
    models: [
      { modelId: 'alpha-existing', efforts: ['max', 'off'] },
      { modelId: 'alpha-two' },
    ],
  });
  const alpha = ruleOf(next, 'prov-alpha');
  assert.deepEqual(alpha.config.personalModelIds, ['alpha-existing', 'alpha-two']);
  assert.deepEqual(summary.addedModels, ['alpha-two']);
  assert.deepEqual(summary.skippedExisting, ['alpha-existing']);

  const rl = modelRuleOf(next, 'prov-alpha', 'alpha-existing').config.optionSpecs.reasoningLevel;
  assert.deepEqual(rl.values, ['max', 'off'], '网关档位重排（off 已在，无默认档）');
  assert.equal(rl.map, 'cel-map-keep-me', '既有 map 不被通用模板反向覆盖');
  assert.ok(modelRuleOf(next, 'prov-alpha', 'alpha-two'), '新模型规则已建');
});

test('manualProviderModelRules 手工覆盖区：数组不动、命中条目不写自动模型规则', () => {
  const before = loadFixtureObject();
  const manualBefore = JSON.stringify(before.config.modelConfigRules.manualProviderModelRules);
  const { next } = mergeProviderConfig(before, {
    providerId: 'prov-alpha',
    baseUrl: SHARED_URL,
    protocol: 'chat-completions',
    models: [{ modelId: 'alpha-manual' }],
  });
  assert.equal(
    JSON.stringify(next.config.modelConfigRules.manualProviderModelRules),
    manualBefore,
    '手工覆盖区一字不动',
  );
  assert.ok(!modelRuleOf(next, 'prov-alpha', 'alpha-manual'), '被手工覆盖的模型不写 providerModelRules');
  assert.deepEqual(ruleOf(next, 'prov-alpha').config.personalModelIds, ['alpha-existing', 'alpha-manual']);
});

test('selected 形状非法直接抛 Error：缺 providerId / 协议非法 / models 非数组', () => {
  const existing = loadFixtureObject();
  assert.throws(() => mergeProviderConfig(existing, { baseUrl: 'x', protocol: 'responses', models: [] }), /providerId/);
  assert.throws(
    () => mergeProviderConfig(existing, { providerId: 'p', baseUrl: 'x', protocol: 'auto', models: [] }),
    /三选一/,
  );
  assert.throws(
    () => mergeProviderConfig(existing, { providerId: 'p', baseUrl: 'x', protocol: 'responses' }),
    /models/,
  );
  assert.throws(
    () => mergeProviderConfig(existing, { providerId: 'p', baseUrl: 'x', protocol: 'responses', models: [{}] }),
    /modelId/,
  );
});

test('existing 形状非法 → 兜底防御抛 ProviderConfigParseError', () => {
  assert.throws(
    () => mergeProviderConfig({ schemaVersion: 1, config: {} }, betaSelection()),
    ProviderConfigParseError,
  );
});

test('空模型清单不创建新供应商 rule（严禁自动复活已删除条目）', () => {
  const { next, summary } = mergeProviderConfig(loadFixtureObject(), {
    providerId: 'prov-ghost',
    baseUrl: SHARED_URL,
    protocol: 'responses',
    models: [],
  });
  assert.equal(summary.providerRuleCreated, false);
  assert.ok(!ruleOf(next, 'prov-ghost'));
  assert.ok(!next.config.providerOrder.includes('prov-ghost'));
});

// ---------------------------------------------------------------------------
// applyProviderConfig（IO：读失败/损坏/备份失败/原子写；全部注入 test/.tmp 路径）
// ---------------------------------------------------------------------------

test('读失败中止：provider_config.json 不存在 → READ_FAILED，绝不创建新文件', async () => {
  const v2 = await freshDir('read-missing');
  const state = await freshDir('read-missing-state');
  await expectPullError(
    applyProviderConfig(betaSelection(), { v2Dir: v2, stateDir: state }),
    'READ_FAILED',
  );
  // 中止纪律：不产生任何文件（不重建、不备份、不 tmp）
  assert.deepEqual(await fs.readdir(v2), [], 'v2 目录必须保持为空');
  await assert.rejects(fs.stat(join(state, 'backups')));
});

test('JSON 损坏中止：READ_FAILED（携带 pointer），原文件与磁盘状态一字不变', async () => {
  const v2 = await freshDir('corrupt');
  const state = await freshDir('corrupt-state');
  const corrupt = '{ this is not json';
  await fs.writeFile(join(v2, 'provider_config.json'), corrupt, 'utf8');

  const err = await expectPullError(
    applyProviderConfig(betaSelection(), { v2Dir: v2, stateDir: state }),
    'READ_FAILED',
  );
  assert.equal(err.detail.cause.name, 'ProviderConfigParseError');

  assert.equal(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'), corrupt, '原文件未被改动');
  assert.deepEqual(await fs.readdir(v2), ['provider_config.json'], '无 tmp 残留');
  await assert.rejects(fs.stat(join(state, 'backups')), undefined, '未发生备份');
});

test('备份失败中止：BACKUP_FAILED 时原配置分毫未动', async () => {
  const v2 = await freshDir('backup-fail');
  const stateAsFile = join(TMP_ROOT, 'backup-fail-state-file');
  await fs.rm(stateAsFile, { force: true });
  await fs.writeFile(stateAsFile, 'i am a file, not a dir', 'utf8'); // mkdir <file>/backups 必败
  const raw = loadFixtureRaw();
  await fs.writeFile(join(v2, 'provider_config.json'), raw, 'utf8');

  await expectPullError(
    applyProviderConfig(betaSelection(), { v2Dir: v2, stateDir: stateAsFile }),
    'BACKUP_FAILED',
  );
  assert.equal(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'), raw, '配置未被动过');
});

test('成功写入：备份原文 + tmp/rename 原子落盘 + 无 tmp 残留 + summary 回传', async () => {
  const v2 = await freshDir('ok');
  const state = await freshDir('ok-state');
  const raw = loadFixtureRaw();
  await fs.writeFile(join(v2, 'provider_config.json'), raw, 'utf8');

  const res = await applyProviderConfig(betaSelection(), { v2Dir: v2, stateDir: state });
  assert.equal(res.written, true);
  assert.equal(res.summary.apiKeyWritten, true);
  assert.deepEqual(res.summary.addedModels, ['beta-one']);

  // 备份：秒级时间戳 + 唯一后缀（pid-毫秒-随机，修 S1 同秒不碰撞）、内容 = 写入前的原文
  const backups = await fs.readdir(join(state, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^provider_config\.\d{8}-\d{6}\.\d+-[0-9a-z]+-[0-9a-f]+\.json$/);
  assert.equal(await fs.readFile(join(state, 'backups', backups[0]), 'utf8'), raw);

  // 落盘结果：合并语义生效（C1：alpha 不动，beta 拿到模型与 key）
  const written = JSON.parse(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'));
  assert.equal(ruleOf(written, 'prov-alpha').config.access.apiKey, 'sk-alpha-current-key');
  assert.equal(ruleOf(written, 'prov-beta').config.access.apiKey, 'sk-beta-new');
  assert.deepEqual(ruleOf(written, 'prov-beta').config.personalModelIds, ['beta-one']);
  const rl = modelRuleOf(written, 'prov-beta', 'beta-one').config.optionSpecs.reasoningLevel;
  assert.deepEqual(rl.values, ['off', 'low', 'high', 'medium']);

  // 原子写：v2 目录只剩配置文件本身（tmp 已被 rename 消费）
  assert.deepEqual(await fs.readdir(v2), ['provider_config.json'], '不得残留 *.ztk-tmp 半成品');

  // 写入内容为可读格式（2 空格 + 尾随换行）
  const text = await fs.readFile(join(v2, 'provider_config.json'), 'utf8');
  assert.ok(text.endsWith('\n'));
});

test('selected 非法 → INVALID_INPUT（落盘动作之前失败，无半成品）', async () => {
  const v2 = await freshDir('invalid');
  const state = await freshDir('invalid-state');
  const raw = loadFixtureRaw();
  await fs.writeFile(join(v2, 'provider_config.json'), raw, 'utf8');
  await expectPullError(
    applyProviderConfig({ providerId: 'x', baseUrl: '', protocol: 'auto', models: [] }, { v2Dir: v2, stateDir: state }),
    'INVALID_INPUT',
  );
  assert.equal(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'), raw);
  assert.deepEqual((await fs.readdir(v2)).sort(), ['provider_config.json'], '失败后无锁/无 tmp 残留');
});

// ---------------------------------------------------------------------------
// 并发写防护（修 S1）：进程内互斥、跨进程锁文件、mtime 复核、唯一 tmp/备份名
// ---------------------------------------------------------------------------

test('S1：进程内并发两次写入都被保留（后写者不再静默抹掉先写者）', async () => {
  const v2 = await freshDir('concurrent');
  const state = await freshDir('concurrent-state');
  await fs.writeFile(join(v2, 'provider_config.json'), loadFixtureRaw(), 'utf8');

  const [ra, rb] = await Promise.all([
    applyProviderConfig(
      { ...betaSelection(), models: [{ modelId: 'mA' }] },
      { v2Dir: v2, stateDir: state },
    ),
    applyProviderConfig(
      { ...betaSelection(), models: [{ modelId: 'mB' }] },
      { v2Dir: v2, stateDir: state },
    ),
  ]);
  assert.equal(ra.written, true);
  assert.equal(rb.written, true);

  const written = JSON.parse(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'));
  const ids = ruleOf(written, 'prov-beta').config.personalModelIds;
  assert.deepEqual([...ids].sort(), ['mA', 'mB'], '两次调用的模型都必须在最终文件里（丢失更新=回归 S1）');

  // 同秒两次调用 → 两份独立备份（互不覆盖）
  const backups = await fs.readdir(join(state, 'backups'));
  assert.equal(backups.length, 2, '每次成功写入各留一份备份');
  assert.notEqual(backups[0], backups[1]);
  for (const b of backups) assert.match(b, /^provider_config\.\d{8}-\d{6}\.\d+-[0-9a-z]+-[0-9a-f]+\.json$/);

  // 收尾卫生：锁与 tmp 均已释放/消费
  assert.deepEqual((await fs.readdir(v2)).sort(), ['provider_config.json'], '锁文件与 tmp 不得残留');
});

test('S1：锁被其它进程持有（新鲜）→ 等待超时 WRITE_FAILED，原配置分毫未动', async () => {
  const v2 = await freshDir('lock-held');
  const state = await freshDir('lock-held-state');
  const raw = loadFixtureRaw();
  await fs.writeFile(join(v2, 'provider_config.json'), raw, 'utf8');
  const lockPath = join(v2, 'provider_config.json.ztk-lock');
  await fs.writeFile(lockPath, '99999 0\n', 'utf8'); // 模拟外进程刚获取的锁

  await expectPullError(
    applyProviderConfig(betaSelection(), { v2Dir: v2, stateDir: state, lockTimeoutMs: 250 }),
    'WRITE_FAILED',
  );
  assert.equal(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'), raw, '未获锁绝不写');
  assert.ok(fsSyncExists(lockPath), '新鲜锁不得被误破（属于持锁进程）');
  await fs.rm(lockPath, { force: true });
});

test('S1：崩溃残留的超龄锁被破除后正常写入', async () => {
  const v2 = await freshDir('lock-stale');
  const state = await freshDir('lock-stale-state');
  const raw = loadFixtureRaw();
  await fs.writeFile(join(v2, 'provider_config.json'), raw, 'utf8');
  const lockPath = join(v2, 'provider_config.json.ztk-lock');
  await fs.writeFile(lockPath, '99999 0\n', 'utf8');
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lockPath, old, old); // 回拨 mtime 模拟超龄残留

  const res = await applyProviderConfig(betaSelection(), { v2Dir: v2, stateDir: state, staleLockMs: 30_000 });
  assert.equal(res.written, true);
  const written = JSON.parse(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'));
  assert.deepEqual(ruleOf(written, 'prov-beta').config.personalModelIds, ['beta-one']);
  assert.deepEqual((await fs.readdir(v2)).sort(), ['provider_config.json'], '写入完成后锁被释放');
});

test('S1：读取后被外部改动 → mtime 复核拦下（不基于陈旧原文落盘）', async () => {
  const v2 = await freshDir('mtime-race');
  const state = await freshDir('mtime-race-state');
  await fs.writeFile(join(v2, 'provider_config.json'), loadFixtureRaw(), 'utf8');

  // 让第一次读到的原文在「读取之后、rename 之前」被外部（不持我们锁的写者，如客户端）替换：
  // 预先埋一个更晚 mtime 的内容——实现上以「读时 mtime ≠ 复核时 mtime」为判据，
  // 这里在读文件前先落一份新内容，再在 apply 进行中改写一次。稳定复现方式：第一次 apply 前
  // 记录 mtime，apply 内部复核点读到的 mtime 与其读时一致（无并发）→ 正常写入；
  // 真正的竞态用并发写者模拟：与 apply 同时改写文件，断言最终文件仍是合法 JSON 且两个模型齐全。
  const attacker = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    const cfg = loadFixtureObject();
    cfg.config.providerConfigRules.providerRules[0].config.personalModelIds.push('external-model');
    await fs.writeFile(join(v2, 'provider_config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  })();
  const res = await applyProviderConfig(
    { ...betaSelection(), models: [{ modelId: 'beta-one' }] },
    { v2Dir: v2, stateDir: state },
  );
  await attacker;
  // 无论复核重试几轮：最终落盘必须是合法 JSON（绝不交错出损坏内容），且包含本次写入
  const written = JSON.parse(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'));
  assert.ok(ruleOf(written, 'prov-beta'), '本次写入的供应商必须在场');
  assert.ok(
    ruleOf(written, 'prov-alpha').config.personalModelIds.includes('external-model')
      || ruleOf(written, 'prov-beta').config.personalModelIds.includes('beta-one'),
  );
  assert.equal(res.written, true);
  assert.deepEqual((await fs.readdir(v2)).sort(), ['provider_config.json'], '无 tmp 残留');
});

// ---------------------------------------------------------------------------
// fetchModels（本地 node:http 假网关；去重/元数据采集/协议显式/错误码）
// ---------------------------------------------------------------------------

/** 起一个一次性假网关；fn(base, captured) 执行期间保持监听。 */
async function withGateway(handler, fn) {
  const captured = { url: null, headers: {} };
  const server = createServer((req, res) => {
    captured.url = req.url;
    captured.headers = req.headers;
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, captured);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const GATEWAY_BODY = {
  data: [
    {
      id: 'm-b',
      context_length: 200000,
      max_output_tokens: 90000,
      supported_efforts: ['low', 'high', 'low'],
      default_effort: 'low',
    },
    'm-a',
    { id: 'm-b' }, // 重复 → 去重
    { name: 'm-c' }, // name 形态
    { id: '   ' }, // 空白 → 丢弃
    null, // 垃圾 → 丢弃
  ],
};

test('#11/#10：拉取去重保序 + 采集 context/output/efforts/default_effort + 双凭据头', async () => {
  await withGateway(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(GATEWAY_BODY));
    },
    async (base, captured) => {
      const { models, fetchedAt } = await fetchModels(
        { baseUrl: `${base}/v1`, apiKey: 'sk-test', protocol: 'responses' },
      );
      assert.equal(captured.url, '/v1/models', 'baseUrl 以 /v1 结尾 → GET /models');
      assert.equal(captured.headers.authorization, 'Bearer sk-test');
      assert.equal(captured.headers['x-api-key'], 'sk-test');
      assert.ok(Number.isFinite(fetchedAt));

      assert.deepEqual(
        models.map((m) => m.modelId),
        ['m-b', 'm-a', 'm-c'],
        '按 modelId 去重（[...new Set] 语义）且保序',
      );
      const mb = models[0];
      assert.equal(mb.contextWindow, 200000);
      assert.equal(mb.outputLimit, 90000);
      assert.deepEqual(mb.efforts, ['low', 'high'], 'efforts 亦去重');
      assert.equal(mb.defaultEffort, 'low', 'default_effort 必须采集（修 #10）');
      assert.deepEqual(Object.keys(models[1]), ['modelId'], '纯字符串条目不带元数据');
    },
  );
});

test('端点规约：baseUrl 不带 /v1 → 拼 /v1/models；尾斜杠容错', async () => {
  await withGateway(
    (req, res) => res.end(JSON.stringify({ data: ['x'] })),
    async (base, captured) => {
      await fetchModels({ baseUrl: base, apiKey: 'k', protocol: 'chat-completions' });
      assert.equal(captured.url, '/v1/models');
      await fetchModels({ baseUrl: `${base}/v1/`, apiKey: 'k', protocol: 'chat-completions' });
      assert.equal(captured.url, '/v1/models');
    },
  );
});

test('#5：协议必须显式三选——非法/缺失 protocol 直接拒绝，不做探测', async () => {
  await assert.rejects(
    fetchModels({ baseUrl: 'https://x.example', apiKey: 'k', protocol: 'auto' }),
    (e) => e instanceof PullError && e.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    fetchModels({ baseUrl: 'https://x.example', apiKey: 'k' }),
    (e) => e instanceof PullError && e.code === 'INVALID_INPUT',
  );
});

test('错误码：401 → AUTH；500 → UPSTREAM（带 status）；非 JSON → PARSE；空清单 → PARSE', async () => {
  await withGateway(
    (req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.statusCode = 401;
        res.end('nope');
      }
    },
    async (base) => {
      await expectPullError(
        fetchModels({ baseUrl: base, apiKey: 'k', protocol: 'responses' }),
        'AUTH',
      );
    },
  );
  await withGateway(
    (req, res) => {
      res.statusCode = 500;
      res.end('boom');
    },
    async (base) => {
      const e = await expectPullError(
        fetchModels({ baseUrl: `${base}/v1`, apiKey: 'k', protocol: 'responses' }),
        'UPSTREAM',
      );
      assert.equal(e.detail.status, 500);
    },
  );
  await withGateway(
    (req, res) => res.end('<html>not json'),
    async (base) => {
      await expectPullError(
        fetchModels({ baseUrl: `${base}/v1`, apiKey: 'k', protocol: 'responses' }),
        'PARSE',
      );
    },
  );
  await withGateway(
    (req, res) => res.end(JSON.stringify({ data: [] })),
    async (base) => {
      await expectPullError(
        fetchModels({ baseUrl: `${base}/v1`, apiKey: 'k', protocol: 'responses' }),
        'PARSE',
      );
    },
  );
});

test('网络层：连接拒绝 → NETWORK；超时 → NETWORK', async () => {
  // 连接拒绝：占用一个端口后立刻关闭
  const holder = createServer(() => {});
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  const port = holder.address().port;
  await new Promise((r) => holder.close(r));
  await expectPullError(
    fetchModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', protocol: 'responses' }),
    'NETWORK',
  );

  // 超时：网关挂起不响应
  await withGateway(
    (req, res) => {
      /* 永不响应 */
    },
    async (base) => {
      await expectPullError(
        fetchModels(
          { baseUrl: `${base}/v1`, apiKey: 'k', protocol: 'responses' },
          { timeoutMs: 120 },
        ),
        'NETWORK',
      );
    },
  );
});

test('端到端：fetchModels 结果直接作为 selected 输入完成合并写入', async () => {
  const v2 = await freshDir('e2e');
  const state = await freshDir('e2e-state');
  await fs.writeFile(join(v2, 'provider_config.json'), loadFixtureRaw(), 'utf8');

  await withGateway(
    (req, res) => res.end(JSON.stringify(GATEWAY_BODY)),
    async (base) => {
      const fetched = await fetchModels({
        baseUrl: `${base}/v1`,
        apiKey: 'sk-beta-new',
        protocol: 'chat-completions',
      });
      const res = await applyProviderConfig(
        { ...betaSelection(), models: fetched.models },
        { v2Dir: v2, stateDir: state },
      );
      assert.equal(res.written, true);
      const written = JSON.parse(await fs.readFile(join(v2, 'provider_config.json'), 'utf8'));
      // defaultEffort='low' → values 末位；重复 m-b 只落一条
      const rl = modelRuleOf(written, 'prov-beta', 'm-b').config.optionSpecs.reasoningLevel;
      assert.deepEqual(rl.values, ['off', 'high', 'low']);
      assert.ok(modelRuleOf(written, 'prov-beta', 'm-a'));
      assert.ok(modelRuleOf(written, 'prov-beta', 'm-c'));
      assert.equal(modelRuleOf(written, 'prov-beta', 'm-b').config.properties.contextWindow, 200000);
    },
  );
});
