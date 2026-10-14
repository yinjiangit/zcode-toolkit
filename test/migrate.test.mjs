/**
 * migrate.test.mjs —— src/migrate.mjs 契约测试（任务书指定清单）。
 *
 * 安全边界（test/data/README.md 硬性约束 + 任务书）：
 *   - 一切断言跑在 fixture 路径（test/.tmp/ 下运行时生成）上，绝不写真实 ~/.zcode、
 *     绝不写 ZCode 安装目录；
 *   - 对真实安装目录的 legacy patcher --check 冒烟为**显式 opt-in**（ZTK_SMOKE_REAL=1 才启用，
 *     S5 处置：默认本地/CI 跑 fixture-only，绝不无感触碰真实用户文件）；
 *   - runMigrate({confirm:true}) 仅对 fixture 注入路径执行（验证门控与备份）；绝不以任何
 *     confirm 形态触真实路径。
 *
 * 必测清单（任务书原文）：
 *   ① 旗标枚举恰为 6 个 asar 旗标且不含 reasoning_config；
 *   ② --check/--dry-run 在 fixture 上输出正确；
 *   ③ 无 --confirm 不动任何文件；
 *   ④ 备份生成；
 *   ⑤ 清退清单与 prune 常量集合相等（交叉核对断言）。
 */

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASAR_PATCH_FLAGS,
  EXPECTED_PRISTINE_SHA256,
  PRUNE_ARTIFACTS_COLLECT,
  SHA256_APPLIES_TO_VERSION,
  MigrateGateError,
  plannedCleanupArtifacts,
  checkMigrate,
  runMigrate,
  matchesGlob,
  cliMain,
} from '../src/migrate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(REPO, 'test', '.tmp', 'migrate', 'check'); // fixture 一律运行时生成于 test/.tmp/（gitignore）——仓库内不得出现 app.asar/.bak 等文件名，市场装包校验会拒
const TMP = path.join(REPO, 'test', '.tmp', 'migrate');
const LEGACY = path.join(REPO, 'legacy', 'zcode_patcher.py');

/* ==========================================================================
 * fixture 构造：假 resources 树 + 假 v2 根（asar 为合法最小包——旧 patcher 的
 * _read_asar_header/_repack_asar（zcode_patcher.py:1781-1796/:1959-2058）逐字节兼容：
 * 头 = pack('<4I', 4, 8+len+pad, 4+len+pad, len) + json + pad，条目 {size,offset,integrity}，
 * integrity 键序 algorithm/hash/blockSize/blocks 与 _asar_integrity 一致，保证 fixture 上的
 * 真还原（revert）为字节级 no-op，测试可重复。
 * ========================================================================== */

function integrityOf(buf) {
  const BLOCK = 4194304; // 与 zcode_patcher._asar_integrity 一致
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK) {
    blocks.push(createHash('sha256').update(buf.subarray(i, i + BLOCK)).digest('hex'));
  }
  return { algorithm: 'SHA256', hash: createHash('sha256').update(buf).digest('hex'), blockSize: BLOCK, blocks };
}

/** entries: [relPath, Buffer|string][]（按插入序建树；offset 按 python relayout 同款深度优先游走分配）。 */
function buildAsar(entries) {
  const root = { files: {} };
  const dirFor = (parts) => {
    let node = root;
    for (const part of parts) {
      if (!node.files[part]) node.files[part] = { files: {} };
      node = node.files[part];
    }
    return node;
  };
  for (const [p, content] of entries) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const parts = p.split('/');
    const parent = dirFor(parts.slice(0, -1));
    parent.files[parts[parts.length - 1]] = { __buf: buf };
  }
  const blobs = [];
  let cursor = 0;
  (function relayout(node) {
    for (const ent of Object.values(node.files)) {
      if (ent.files) { relayout(ent); continue; }
      const buf = ent.__buf;
      delete ent.__buf;
      ent.size = buf.length;
      ent.offset = String(cursor);
      ent.integrity = integrityOf(buf);
      cursor += buf.length;
      blobs.push(buf);
    }
  })(root);
  const json = JSON.stringify(root);
  const pad = (4 - (Buffer.byteLength(json) % 4)) % 4;
  const head = Buffer.alloc(16 + Buffer.byteLength(json) + pad);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + json.length + pad, 4);
  head.writeUInt32LE(4 + json.length + pad, 8);
  head.writeUInt32LE(json.length, 12);
  head.write(json, 16, 'utf8');
  return Buffer.concat([head, ...blobs]);
}

// 旧 patcher 的锚点素材（USAGE_PATCHES :683-696 / WIDTH_PATCHES :700-716 / 注入路径 :1042-1063）
const USAGE_KEYS = ['AppUsageDailyModelTrendChart', 'AppUsageModelUsagePieChart'];
const USAGE_PATTERNS = ['n.models.slice(0,6)', 'i=n.length>Q,a=i?Q-1:Q'];
const USAGE_REPLACED = ['n.models', 'i=!1,a=1/0'];
const WIDTH_ORIG = ['j??`w-48`', ':`w-48 max-h-72 overflow-y-auto`'];
const WIDTH_PATCHED = ['j??`w-80`', ':`w-80 max-h-72 overflow-y-auto`'];

/** 打补丁现场清单（复刻真实安装目录 ls 实测命名，§1.3 现状清点）。 */
const PATCHED_ARTIFACTS = [
  'app.asar.chart-patch.json', 'app.asar.enhance-patch.json', 'app.asar.puller-patch.json',
  'app.asar.slider-patch.json', 'app.asar.tps-patch.json', 'app.asar.width-patch.json',
  'app.asar.enhance.bak', 'app.asar.puller.bak', 'app.asar.slider.bak', 'app.asar.tps.bak',
  'app.asar.enhance.bak.meta.json', 'app.asar.puller.bak.meta.json',
  'app.asar.slider.bak.meta.json', 'app.asar.tps.bak.meta.json',
  'app.asar.enhance.bak.stale-20261013-130424', 'app.asar.enhance.bak.stale-20261013-130424.meta.json',
  'app.asar.enhance.bak.stale-20261013-132637', 'app.asar.enhance.bak.stale-20261013-132637.meta.json',
  'app.asar.puller.bak.stale-20261013-130420', 'app.asar.puller.bak.stale-20261013-130420.meta.json',
  'app.asar.puller.bak.stale-20261013-132633', 'app.asar.puller.bak.stale-20261013-132633.meta.json',
  'app.asar.slider.bak.stale-20261013-130415', 'app.asar.slider.bak.stale-20261013-130415.meta.json',
  'app.asar.tps.bak.stale-20261013-130411', 'app.asar.tps.bak.stale-20261013-130411.meta.json',
  'app.asar.zp-lock',
];

/**
 * 造一套完整 fixture。
 * @param {string} root - fixture 根（其下生成 install/resources、v2、state、cache）。
 * @param {object} o - {version='3.15.2', patched=false, wantFile=false,
 *   reasoningBak=null|'same'|'diff', prefix='pre-fix.124959'}。
 * @returns {{installRoot,resourcesDir,v2Dir,stateDir,cacheDir,asarPath}}
 */
function buildFixture(root, o = {}) {
  const version = o.version ?? '3.15.2';
  const patched = !!o.patched;
  fs.rmSync(root, { recursive: true, force: true });
  const installRoot = path.join(root, 'install');
  const resourcesDir = path.join(installRoot, 'resources');
  const v2Dir = path.join(root, 'v2');
  const stateDir = path.join(root, 'state');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(path.join(resourcesDir, 'glm'), { recursive: true });
  fs.mkdirSync(v2Dir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const pkgJson = `{"name":"zcode","version":"${version}","main":"out/main/index.js"}`;
  const usage = USAGE_KEYS.map((k, i) => {
    const body = patched ? USAGE_REPLACED[i] : USAGE_PATTERNS[i];
    return [`assets/${k}-fake.js`, `/*${k}*/${'p'.repeat(40)}${body}${'q'.repeat(40)}`];
  });
  const widthBody = (patched ? WIDTH_PATCHED : WIDTH_ORIG).join('\n') + '\n/*' + 'z'.repeat(1200) + '*/';
  const asarBuf = buildAsar([
    ['package.json', pkgJson],
    ['out/renderer/index.html', '<html><body></body></html>'],
    ['out/renderer/fake-bundle.js', widthBody],
    ['out/preload/index.cjs', '/* preload */'.repeat(20)],
    ['out/main/index.js', '/* main */'.repeat(20)],
    ...usage,
  ]);
  const asarPath = path.join(resourcesDir, 'app.asar');
  fs.writeFileSync(asarPath, asarBuf);

  if (patched) {
    const asarSize = asarBuf.length;
    const pkgBuf = Buffer.from(pkgJson, 'utf8');
    // package.json 是 buildAsar 游走序首个条目 → 数据区偏移 = 头长（数据区从 headerLen 起算）
    const headerLen = asarHeaderLen(asarPath);
    const sideBytes = () => JSON.stringify({
      patches: [{ path: 'package.json', offset: headerLen, size: pkgBuf.length, asar_size: asarSize, original_b64: pkgBuf.toString('base64') }],
    });
    // chart/width（usage/model-width 共用 package.json 作为 no-op 还原记录）
    fs.writeFileSync(path.join(resourcesDir, 'app.asar.chart-patch.json'), sideBytes());
    fs.writeFileSync(path.join(resourcesDir, 'app.asar.width-patch.json'), sideBytes());
    // 注入类 sidecar：只需 asar_size 指纹命中（_process_script_inject :2214-2221 / _process_ipc_patch :2399-2406）
    for (const s of ['tps', 'slider', 'puller', 'enhance']) {
      fs.writeFileSync(path.join(resourcesDir, `app.asar.${s}-patch.json`), JSON.stringify({ asar_size: asarSize }));
      fs.writeFileSync(path.join(resourcesDir, `app.asar.${s}.bak`), 'fake-bak-bytes');
      fs.writeFileSync(path.join(resourcesDir, `app.asar.${s}.bak.meta.json`), '{"tool":"zcode-patcher"}');
    }
    for (const name of PATCHED_ARTIFACTS.filter((n) => n.includes('.stale-'))) {
      fs.writeFileSync(path.join(resourcesDir, name), 'stale-archive');
    }
    fs.writeFileSync(path.join(resourcesDir, 'app.asar.zp-lock'), String(process.pid));
  }

  fs.writeFileSync(path.join(resourcesDir, 'glm', 'zcode.cjs'), `/* fake kernel ${version} */`);

  const pc = { schemaVersion: 1, config: { modelConfigRules: { providerModelRules: [] } } };
  fs.writeFileSync(path.join(v2Dir, 'provider_config.json'), JSON.stringify(pc, null, 2));
  fs.writeFileSync(path.join(v2Dir, `provider_config.json.${o.prefix ?? 'pre-fix.124959'}.bak`), '{}');
  if (o.reasoningBak === 'same') {
    fs.writeFileSync(path.join(v2Dir, 'provider_config.json.reasoning-bak'), JSON.stringify(pc, null, 2));
  } else if (o.reasoningBak === 'diff') {
    const old = { schemaVersion: 1, config: { modelConfigRules: { providerModelRules: [{ providerId: 'old', modelId: 'm1' }] } } };
    fs.writeFileSync(path.join(v2Dir, 'provider_config.json.reasoning-bak'), JSON.stringify(old, null, 2));
  }

  if (o.wantFile) {
    const want = path.join(cacheDir, 'zcode-toolkit', 'zcode-tokenspeed', '0.6.16',
      'skills', 'zcode-tokenspeed', 'scripts', '_watchdog.want');
    fs.mkdirSync(path.dirname(want), { recursive: true });
    fs.writeFileSync(want, '[]');
  }
  return { installRoot, resourcesDir, v2Dir, stateDir, cacheDir, asarPath };
}

// —— fixture 头长助手（与 buildAsar 同构；供 sidecar 写正确的数据区偏移）——
function asarHeaderLen(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return 8 + head.readUInt32LE(4); // 数据区起点（zcode_patcher._read_asar_header :1796 同式）
  } finally {
    fs.closeSync(fd);
  }
}

/** 目录快照（rel → size），「不动任何文件」断言用。 */
function snapshotTree(rootDir) {
  const map = new Map();
  (function walk(dir, rel) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else { try { map.set(r, fs.statSync(path.join(dir, ent.name)).size); } catch { /* 竞态忽略 */ } }
    }
  })(rootDir, '');
  return map;
}

/** 旧 patcher 真还原分支内置 tasklist 预检（:2890-2904、:2997-3002）——本机 ZCode 常驻，
 * fixture 测试以 cwd 指向含哑 tasklist.exe 的目录绕开（Windows exe 解析 current dir 先于 System32）。 */
function makeTasklistStub() {
  const dir = path.join(TMP, 'tasklist-stub');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cands = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'hostname.exe'),
  ];
  for (const c of cands) {
    if (fs.existsSync(c)) { fs.copyFileSync(c, path.join(dir, 'tasklist.exe')); return dir; }
  }
  throw new Error(`tasklist stub 源不存在：${cands.join(', ')}`);
}

/* ==========================================================================
 * 全局准备：py 探测（py -3.13 → py -3.12 → py，与 migrate.resolvePythonCmd 同链）
 * ========================================================================== */
let PY = null;
before(() => {
  fs.mkdirSync(TMP, { recursive: true });
  for (const c of [['py', '-3.13'], ['py', '-3.12'], ['py']]) {
    const r = spawnSync(c[0], [...c.slice(1), '--version'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0) { PY = c; break; }
  }
});

/* ==========================================================================
 * ① 旗标契约
 * ========================================================================== */
describe('① 旗标枚举：恰为 6 个 asar 旗标，不含 reasoning_config / --all', () => {
  test('ASAR_PATCH_FLAGS 与任务书六旗标逐项相等', () => {
    assert.deepEqual(ASAR_PATCH_FLAGS, [
      '--usage-chart', '--model-width', '--tps-footer',
      '--thought-slider', '--model-puller', '--enhance-prompt',
    ]);
    assert.equal(ASAR_PATCH_FLAGS.length, 6);
  });
  test('不含 reasoning_config 与 --all（§1.3 步骤 2 双保险①）', () => {
    assert.ok(!ASAR_PATCH_FLAGS.includes('--all'));
    assert.ok(!ASAR_PATCH_FLAGS.some((f) => /reasoning/i.test(f)), 'reasoning_config 严禁混入还原旗标');
    // 与旧 patcher ALL_PATCH_FLAGS（:137-145，7 项含 reasoning_config）的差集恰为 reasoning
    assert.equal(7 - ASAR_PATCH_FLAGS.length, 1);
  });
});

/* ==========================================================================
 * ⑤ 清退清单 × prune 常量集合交叉核对（任务书指定断言）
 * ========================================================================== */
describe('⑤ 清退清单与 prune_artifacts 常量集合交叉核对', () => {
  const REAL_BASELINE = PATCHED_ARTIFACTS; // 真实安装目录 ls 实测命名（§1.3 现状清点）
  test('glm 部分与 prune :2812/:2814 全等', () => {
    const planGlm = plannedCleanupArtifacts().filter((x) => x.startsWith('glm/')).map((x) => x.slice(4));
    assert.deepEqual([...planGlm].sort(), [...PRUNE_ARTIFACTS_COLLECT.glmDefault, ...PRUNE_ARTIFACTS_COLLECT.glmDeep].sort());
  });
  test('实测残留逐个被清单命中（zp-lock 为迁移专有，亦在清单）', () => {
    const plan = plannedCleanupArtifacts();
    for (const name of REAL_BASELINE) {
      assert.ok(plan.some((e) => e === name || matchesGlob(e, name)), `清单未覆盖实测残留 ${name}`);
    }
  });
  test('prune asar 级模式（:2807/:2809-2810）命中的实测名，清单同样命中（防漏项）', () => {
    const asarPats = [...PRUNE_ARTIFACTS_COLLECT.asarFolderDefault, ...PRUNE_ARTIFACTS_COLLECT.asarFolderDeep]
      .map((s) => s.replaceAll('{asar}', 'app.asar'));
    const plan = plannedCleanupArtifacts();
    for (const pat of asarPats) {
      for (const name of REAL_BASELINE) {
        if (matchesGlob(pat, name)) {
          assert.ok(plan.some((e) => e === name || matchesGlob(e, name)),
            `prune ${pat} 命中的 ${name} 不在清退清单（手写漂移漏项）`);
        }
      }
    }
  });
  test('清单 asar 级条目的命中能力 ⊆ prune 模式族（防增项；zp-lock 与 prune 原文 tmp 两条除外）', () => {
    const asarPats = [...PRUNE_ARTIFACTS_COLLECT.asarFolderDefault, ...PRUNE_ARTIFACTS_COLLECT.asarFolderDeep]
      .map((s) => s.replaceAll('{asar}', 'app.asar'));
    const pruneVerbatim = asarPats.filter((s) => s.includes('tmp')); // 'app.asar*.tps-tmp' / 'app.asar.*.tmp'（:2807 原文照抄）
    for (const entry of plannedCleanupArtifacts()) {
      if (entry.startsWith('glm/')) continue;
      if (entry === 'app.asar.zp-lock') continue;                     // 迁移专有（prune 清单外，§1.3 实测）
      if (pruneVerbatim.includes(entry)) continue;
      const covered = REAL_BASELINE.filter((n) => entry === n || matchesGlob(entry, n));
      assert.ok(covered.length > 0, `清单条目 ${entry} 不命中任何实测残留（疑似幻觉条目）`);
      for (const n of covered) {
        assert.ok(asarPats.some((pat) => matchesGlob(pat, n)),
          `清单条目 ${entry} 命中的 ${n} 不被任何 prune 模式覆盖（超出 prune 集合的增项）`);
      }
    }
  });
  test('v2 配置备份绝不进 resources 清退清单（§1.3 步骤 8：只列出绝不删）', () => {
    const plan = plannedCleanupArtifacts();
    for (const n of PRUNE_ARTIFACTS_COLLECT.v2Deep) {
      assert.ok(!plan.some((e) => e.includes(n)), `v2 条目 ${n} 不得进入清退清单`);
      assert.ok(!plan.some((e) => e.includes('v2/')), '清退清单不得含 v2 路径');
    }
  });
});

/* ==========================================================================
 * ② --check / --dry-run 在 fixture 上输出正确（checkMigrate + CLI）
 * ========================================================================== */
describe('② checkMigrate 在 fixture 上输出正确', () => {
  let fx;
  before(() => {
    fx = buildFixture(DATA, { patched: true, wantFile: true }); // 任务书指定 fixture 根：假 resources 树 + 假 v2 根
  });

  test('patched fixture：报告字段与磁盘一致', { skip: !PY && 'py 不可用' }, async () => {
    const snap = snapshotTree(DATA);
    const r = await checkMigrate({
      resourcesDir: fx.resourcesDir,
      v2Dir: fx.v2Dir,
      stateDir: fx.stateDir,
      pluginsCacheDir: fx.cacheDir,
      zcodeRunning: async () => false,
      listProcesses: async () => [{
        pid: 4242, name: 'python.exe',
        commandline: 'C:\\Python313\\python.exe ...apply_after_exit.py --watch',
      }],
    });
    assert.equal(r.zcodeRunning, false);
    assert.deepEqual(r.watchdogProcesses, [{ name: 'python.exe', pid: 4242 }]);
    assert.equal(r.wantFilePresent, true);
    assert.ok(r.wantFiles[0].endsWith('_watchdog.want'));
    assert.match(path.basename(r.providerConfigBackupPlan), /^provider_config\.pre-migrate\.\d{8}-\d{6}\.json$/);
    assert.ok(r.providerConfigBackupPlan.startsWith(path.join(fx.stateDir, 'backups')));
    assert.equal(r.reasoningBakDiff, null);            // 本 fixture 无 .reasoning-bak
    assert.equal(r.dryRun.pyAvailable, true);
    assert.equal(r.dryRun.pythonCmd, PY.join(' '));
    assert.equal(r.dryRun.exitCodes.check, 0);
    assert.equal(r.dryRun.exitCodes.revertDryRun, 0);
    assert.deepEqual(r.dryRun.flagsPlanned, ASAR_PATCH_FLAGS); // 六旗标全部命中（已打/将还原）
    assert.match(r.dryRun.checkOut, /已打/);
    assert.match(r.dryRun.revertDryRunOut, /将还原|将移除/);
    assert.match(r.dryRun.kernelCheckOut, /zcode\.cjs/);        // 无参数形态内核还原检查
    assert.match(r.asarSha256, /^[0-9a-f]{64}$/);
    assert.equal(r.expectedSha256, EXPECTED_PRISTINE_SHA256);
    assert.equal(r.clientVersion, '3.15.2');
    assert.equal(r.clientVersionApplies, true);
    assert.equal(r.fallbackReinstall, false);
    assert.deepEqual(r.cleanupPlan, [...PATCHED_ARTIFACTS].sort());
    assert.equal(r.v2Residues.length, 1);
    assert.ok(r.v2Residues[0].path.endsWith('provider_config.json.pre-fix.124959.bak'));
    assert.ok(Number.isFinite(r.v2Residues[0].mtimeMs));
    assert.deepEqual(snapshotTree(DATA), snap); // checkMigrate 全程只读
  });

  test('clean fixture：无残留、无命中旗标', { skip: !PY && 'py 不可用' }, async () => {
    const c = buildFixture(path.join(TMP, 'clean'), {});
    const r = await checkMigrate({
      resourcesDir: c.resourcesDir, v2Dir: c.v2Dir, stateDir: c.stateDir, pluginsCacheDir: c.cacheDir,
      zcodeRunning: async () => false, listProcesses: async () => [],
    });
    assert.equal(r.wantFilePresent, false);
    assert.deepEqual(r.watchdogProcesses, []);
    assert.deepEqual(r.dryRun.flagsPlanned, []);
    assert.deepEqual(r.cleanupPlan, []);
    // clean fixture 仍有 pre-fix 残留 → 步骤 8 照列
    assert.equal(r.v2Residues.length, 1);
    assert.equal(r.fallbackReinstall, false);
    assert.equal(r.clientVersionApplies, true);
  });

  test('reasoning-bak 与现行差异被 diff 出（步骤 2 双保险②）', async () => {
    const c = buildFixture(path.join(TMP, 'rbak'), { reasoningBak: 'diff' });
    const r = await checkMigrate({
      resourcesDir: c.resourcesDir, v2Dir: c.v2Dir, stateDir: c.stateDir, pluginsCacheDir: c.cacheDir,
      zcodeRunning: async () => false, listProcesses: async () => [],
    });
    assert.notEqual(r.reasoningBakDiff, null);
    assert.ok(r.reasoningBakDiff.length > 0);
    assert.ok(r.reasoningBakDiff.some((l) => l.startsWith('-L')), JSON.stringify(r.reasoningBakDiff));
    assert.ok(r.reasoningBakDiff.some((l) => l.startsWith('+L')));
    const same = buildFixture(path.join(TMP, 'rbak-same'), { reasoningBak: 'same' });
    const r2 = await checkMigrate({
      resourcesDir: same.resourcesDir, v2Dir: same.v2Dir, stateDir: same.stateDir, pluginsCacheDir: same.cacheDir,
      zcodeRunning: async () => false, listProcesses: async () => [],
    });
    assert.deepEqual(r2.reasoningBakDiff, []); // 一致 → 空 diff，不拦截
  });

  test('默认路径解析（V1）：不注入 pluginsCacheDir 时落到 <home>/.zcode/cli/plugins/cache 真实布局', async () => {
    const home = path.join(TMP, 'default-home');
    fs.rmSync(home, { recursive: true, force: true });
    // 真实旧插件缓存布局（实测 ls ~/.zcode/cli/plugins/cache/zcode-toolkit/zcode-tokenspeed/0.6.16/…）
    const want = path.join(home, '.zcode', 'cli', 'plugins', 'cache', 'zcode-toolkit', 'zcode-tokenspeed',
      '0.6.16', 'skills', 'zcode-tokenspeed', 'scripts', '_watchdog.want');
    fs.mkdirSync(path.dirname(want), { recursive: true });
    fs.writeFileSync(want, '[]');
    const c = buildFixture(path.join(TMP, 'default-fx'), {});
    const r = await checkMigrate({
      resourcesDir: c.resourcesDir, v2Dir: c.v2Dir, stateDir: c.stateDir,
      env: { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') }, // 不设 ZTK_PLUGINS_CACHE_DIR → 走默认
      zcodeRunning: async () => false, listProcesses: async () => [],
    });
    assert.equal(r.wantFilePresent, true, '默认 pluginsCacheDir 必须含 cache 段才能命中真实布局');
    assert.equal(r.wantFiles.length, 1);
    assert.ok(
      r.wantFiles[0].includes(path.join('.zcode', 'cli', 'plugins', 'cache')),
      `默认路径应含 plugins${path.sep}cache 段：${r.wantFiles[0]}`,
    );
  });

  test('仓库 legacy 布局（V1）：repoRoot/skills/<plugin>/scripts/_watchdog.want 命中（无多余嵌套层）', async () => {
    const root = path.join(TMP, 'repo-layout');
    fs.rmSync(root, { recursive: true, force: true });
    const want = path.join(root, 'skills', 'zcode-tokenspeed', 'scripts', '_watchdog.want');
    fs.mkdirSync(path.dirname(want), { recursive: true });
    fs.writeFileSync(want, '[]');
    const c = buildFixture(path.join(TMP, 'repo-layout-fx'), {});
    const r = await checkMigrate({
      resourcesDir: c.resourcesDir, v2Dir: c.v2Dir, stateDir: c.stateDir, pluginsCacheDir: c.cacheDir,
      repoRoot: root,
      zcodeRunning: async () => false, listProcesses: async () => [],
    });
    assert.equal(r.wantFilePresent, true, 'repoRoot 扫描不得多拼 skills/zcode-tokenspeed 一层');
    assert.ok(r.wantFiles.some((p) => p === want), `应恰好命中 ${want}（实际 ${JSON.stringify(r.wantFiles)}）`);
  });
});

describe('② CLI --check / --dry-run（fixture 路径注入）', () => {
  let fx;
  before(() => {
    fx = buildFixture(path.join(TMP, 'cli'), { patched: true, wantFile: true });
  });
  const ioOf = () => {
    const lines = [];
    return { lines, io: { out: (s) => lines.push(s), err: (s) => lines.push(`[stderr] ${s}`) } };
  };
  const paths = (x) => ({
    resourcesDir: x.resourcesDir, v2Dir: x.v2Dir, stateDir: x.stateDir, pluginsCacheDir: x.cacheDir,
  });
  // CLI 侧注入与 checkMigrate 直调同一组假采集器（zcodeRunning=false + 一个假看护进程）
  const fakeProcs = {
    zcodeRunning: async () => false,
    listProcesses: async () => [{
      pid: 4242, name: 'python.exe',
      commandline: 'C:\\Python313\\python.exe ...apply_after_exit.py --watch',
    }],
  };

  test('--check：退出码 0，输出盘点要点', { skip: !PY && 'py 不可用' }, async () => {
    const { lines, io } = ioOf();
    const code = await cliMain(['--check'], { ...io, paths: paths(fx), opts: fakeProcs });
    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /只读盘点/);
    assert.match(text, /ZCode\.exe 未运行/);
    assert.match(text, /WANT_FILE 存在/);
    assert.match(text, /拟备份 .*provider_config\.pre-migrate\.\d{8}-\d{6}\.json/);
    assert.match(text, /\[3\] 预演/);
    assert.match(text, /清退清单（已存在的 27 项）/);
    assert.match(text, /v2 残留（仅列出，1 项/);
    assert.match(text, /兜底建议：暂不需要/);
    assert.ok(!text.includes('若加 --confirm 将执行'), '--check 不得输出预演动作段');
  });
  test('--dry-run：附「将执行」预演段且逐项列出待删文件', { skip: !PY && 'py 不可用' }, async () => {
    const { lines, io } = ioOf();
    const code = await cliMain(['--dry-run'], { ...io, paths: paths(fx), opts: fakeProcs });
    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /若加 --confirm 将执行（预演，不执行）/);
    assert.match(text, /将终止看护进程/);
    assert.match(text, /将删除 WANT_FILE/);
    assert.match(text, /将备份 provider_config\.json/);
    assert.match(text, /--usage-chart --model-width --tps-footer --thought-slider --model-puller --enhance-prompt（不用 --all）/);
    for (const n of PATCHED_ARTIFACTS) assert.ok(text.includes(`将删除 resources/${n}`), n);
    assert.ok(!text.includes('--all '), '六旗标形态外不得出现 --all');
  });
  test('--json：输出可解析的 MigrateReport', { skip: !PY && 'py 不可用' }, async () => {
    const { lines, io } = ioOf();
    const code = await cliMain(['--check', '--json'], { ...io, paths: paths(fx), opts: fakeProcs });
    assert.equal(code, 0);
    const report = JSON.parse(lines.join('\n'));
    assert.ok(Number.isFinite(report.ranAt));
    assert.deepEqual(report.cleanupPlan, [...PATCHED_ARTIFACTS].sort());
    assert.equal(report.expectedSha256, EXPECTED_PRISTINE_SHA256);
  });
  test('用法错误：未知旗标 / 互斥模式 → 退出码 2', async () => {
    const a = ioOf();
    assert.equal(await cliMain(['--wat'], { ...a.io, paths: paths(fx) }), 2);
    assert.ok(a.lines.some((l) => l.includes('未知旗标')));
    const b = ioOf();
    assert.equal(await cliMain(['--check', '--confirm'], { ...b.io, paths: paths(fx) }), 2);
    assert.ok(b.lines.some((l) => l.includes('互斥')));
  });
});

/* ==========================================================================
 * ③ 无 --confirm 不动任何文件
 * ========================================================================== */
describe('③ 无 --confirm：不动任何文件（门控先于一切变更）', () => {
  test('runMigrate 缺 confirm → MigrateGateError + fixture 树逐字节不变', async () => {
    const fx = buildFixture(path.join(TMP, 'gate'), { patched: true, wantFile: true, reasoningBak: 'diff' });
    const opts = {
      resourcesDir: fx.resourcesDir, v2Dir: fx.v2Dir, stateDir: fx.stateDir, pluginsCacheDir: fx.cacheDir,
      zcodeRunning: async () => false, listProcesses: async () => [],
    };
    const snap = snapshotTree(path.join(TMP, 'gate'));
    await assert.rejects(runMigrate(opts), (e) => {
      assert.ok(e instanceof MigrateGateError);
      assert.equal(e.name, 'MigrateGateError');
      assert.ok(Array.isArray(e.pending) && e.pending.length > 0);
      assert.match(e.message, /--confirm/);
      return true;
    });
    await assert.rejects(runMigrate({ ...opts, confirm: false }), (e) => e instanceof MigrateGateError);
    assert.deepEqual(snapshotTree(path.join(TMP, 'gate')), snap);
  });
  test('confirm=true 但 reasoning-bak 差异未确认 → 第二道闸门，仍不动任何文件', { skip: !PY && 'py 不可用' }, async () => {
    const root = path.join(TMP, 'gate-rbak');
    const fx = buildFixture(root, { patched: true, reasoningBak: 'diff' });
    const snap = snapshotTree(root);
    await assert.rejects(runMigrate({
      confirm: true,
      resourcesDir: fx.resourcesDir, v2Dir: fx.v2Dir, stateDir: fx.stateDir, pluginsCacheDir: fx.cacheDir,
      zcodeRunning: async () => false, listProcesses: async () => [],
    }), (e) => {
      assert.ok(e instanceof MigrateGateError);
      assert.ok(e.pending.some((l) => l.includes('--ack-reasoning-bak')));
      assert.ok(e.pending.some((l) => l.startsWith('-L') || l.includes('-L')), 'pending 应含 diff 摘要');
      return true;
    });
    assert.deepEqual(snapshotTree(root), snap);
  });
});

/* ==========================================================================
 * ④ 备份生成（fixture + confirm；绝不触真实路径）
 * ========================================================================== */
describe('④ runMigrate confirm=true（fixture）：备份生成 + 步骤语义', () => {
  test('时间戳备份写入 state/backups；校验未过（版本失配）不清退、WANT_FILE 删除留痕', { skip: !PY && 'py 不可用' }, async () => {
    const root = path.join(TMP, 'confirm-run');
    const fx = buildFixture(root, { version: '9.9.9', patched: true, wantFile: true });
    const stub = makeTasklistStub();
    const pcBefore = fs.readFileSync(path.join(fx.v2Dir, 'provider_config.json'), 'utf8');
    const { report, actions } = await runMigrate({
      confirm: true,
      resourcesDir: fx.resourcesDir, v2Dir: fx.v2Dir, stateDir: fx.stateDir, pluginsCacheDir: fx.cacheDir,
      zcodeRunning: async () => false,
      listProcesses: async () => [],
      patcherCwd: stub,
    });
    const text = actions.join('\n');
    // 步骤 1：WANT_FILE 已删
    assert.match(text, /步骤1：删除 WANT_FILE/);
    assert.equal(fs.existsSync(path.join(fx.cacheDir, 'zcode-toolkit', 'zcode-tokenspeed', '0.6.16',
      'skills', 'zcode-tokenspeed', 'scripts', '_watchdog.want')), false);
    // 步骤 2：备份生成（写 state，不写 v2）
    const backups = fs.readdirSync(path.join(fx.stateDir, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^provider_config\.pre-migrate\.\d{8}-\d{6}\.json$/);
    assert.equal(fs.readFileSync(path.join(fx.stateDir, 'backups', backups[0]), 'utf8'), pcBefore);
    assert.equal(fs.readFileSync(path.join(fx.v2Dir, 'provider_config.json'), 'utf8'), pcBefore, '现行配置不得被改动');
    // 步骤 4：六旗标 revert 成功（patcher 内部 tasklist 预检被 stub 绕开）
    assert.match(text, /步骤4：legacy patcher 六旗标 revert 退出码 0/);
    assert.match(text, /步骤4-内核：无参数形态内核还原退出码 0/);
    // 步骤 5：版本 9.9.9 ≠ 3.15.2 → 校验失效 → 步骤 6 必须跳过（stale 残留仍在盘上）
    assert.match(text, /步骤6：跳过/);
    assert.ok(fs.existsSync(path.join(fx.resourcesDir, 'app.asar.enhance.bak.stale-20261013-130424')), '未校验不得清退');
    assert.equal(report.switchReady, false);
    assert.equal(report.fallbackReinstall, true);
    assert.match(text, /步骤7（兜底/);
    assert.match(text, /步骤9：尚未全绿/);
  });
});

/* ==========================================================================
 * 冒烟（显式 opt-in）：真实安装目录上仅直跑 legacy patcher 的 --check（只读）。
 * S5 处置：默认跳过——触碰真实用户文件（读真实 app.asar/zcode.cjs，check 分支以 r+b 句柄
 * 打开但不写字节），且依赖本机装有 ZCode + py；仅当显式设 ZTK_SMOKE_REAL=1 时启用
 * （本地/CI 默认 fixture-only；启用者自担「对真实安装目录发起子进程读取」的责任）。
 * ========================================================================== */
const SMOKE_REAL = process.env.ZTK_SMOKE_REAL === '1';
describe('冒烟：真实安装目录 legacy patcher --check（只读，ZTK_SMOKE_REAL=1 才启用）', () => {
  const realResources = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'resources');
  const realRoot = path.dirname(realResources);
  const smokeSkip = () =>
    (!SMOKE_REAL && `未设 ZTK_SMOKE_REAL=1（真实安装冒烟默认关闭；S5）`) ||
    ((!PY || !fs.existsSync(path.join(realResources, 'app.asar'))) && '真实安装或 py 不可用，跳过');
  test('六旗标 --check 退出码 0 且报告 3.15.2', { skip: smokeSkip() }, () => {
    const r = spawnSync(PY[0], [...PY.slice(1), LEGACY, realRoot, ...ASAR_PATCH_FLAGS, '--check'],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /=== 客户端版本 3\.15\.2/);
    assert.match(r.stdout, /执行汇总/);
  });
  test('无参数形态内核 --check（§1.3 尾注）退出码 0', {
    skip: (!SMOKE_REAL && '未设 ZTK_SMOKE_REAL=1（真实安装冒烟默认关闭；S5）')
      || ((!PY || !fs.existsSync(path.join(realResources, 'glm', 'zcode.cjs'))) && '真实安装或 py 不可用，跳过'),
  }, () => {
    const r = spawnSync(PY[0], [...PY.slice(1), LEGACY, realRoot, '--check'],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /zcode\.cjs/);
  });
});
