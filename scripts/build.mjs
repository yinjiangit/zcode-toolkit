/**
 * build.mjs —— 发布拷贝：src/ → dist/ 纯拷贝 + 逐文件字节比对校验（方案 §4「构建」：
 * 不用 esbuild——纯 ESM + node ≥22.5 直接运行，dist/ 只是发布时对 src/ 的拷贝，
 * 保留 ${ZCODE_PLUGIN_ROOT}/dist/server.mjs 路径约定与 showcase 模板一致）。
 *
 * 语义：
 *   1. 递归拷贝 src/ 下所有文件到 dist/（保持相对结构；mkdir -p 父目录）。
 *   2. 每个文件拷贝后立即读回 src 与 dist 两份内容做 Buffer 字节比对，不一致即失败。
 *   3. 清理 dist/ 下 src/ 已不存在的陈旧文件（发布拷贝的失效源会留死代码——hooks 直接运行
 *      dist/doctor.mjs，陈旧文件是真 bug 源；.gitkeep 保留）。
 *   4. 打印逐文件结果摘要；任一步失败 exit 1（测试 test/server-smoke.test.mjs 以退出码为准）。
 *
 * 零 npm 依赖（node:fs/node:path）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

/** 递归收集目录下全部文件的相对路径（按路径排序，输出确定）。目录不存在 → 空数组。 */
function listFilesRel(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk('');
  return out.sort();
}

function fail(msg) {
  console.error(`[build] 失败：${msg}`);
  process.exit(1);
}

// —— ① 纯拷贝 + ② 逐文件字节比对 ——
const srcFiles = listFilesRel(SRC);
if (srcFiles.length === 0) fail(`src/ 下没有文件（${SRC}）`);
if (fs.existsSync(DIST) && !fs.statSync(DIST).isDirectory()) fail(`${DIST} 存在但不是目录`);

const copied = [];
for (const rel of srcFiles) {
  const from = path.join(SRC, rel);
  const to = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  // 字节级校验：读回两份完整内容比对（不是 size/mtime 近似）
  const a = fs.readFileSync(from);
  const b = fs.readFileSync(to);
  if (!a.equals(b)) fail(`字节比对不一致：${rel}（src ${a.length}B vs dist ${b.length}B）`);
  copied.push(`${rel} (${a.length}B)`);
}

// —— ③ 清理 src/ 已不存在的陈旧文件（.gitkeep 保留）——
const keep = new Set([...srcFiles, '.gitkeep']);
const pruned = [];
for (const rel of listFilesRel(DIST)) {
  if (keep.has(rel)) continue;
  fs.rmSync(path.join(DIST, rel), { force: true });
  pruned.push(rel);
}
// 清掉拷贝/删除残留的空目录（只删 dist 内的空壳，不触其他路径）
function pruneEmptyDirs(dir) {
  let empty = true;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!pruneEmptyDirs(abs)) empty = false;
    } else empty = false;
  }
  if (empty && dir !== DIST) fs.rmdirSync(dir);
  return empty;
}
if (fs.existsSync(DIST)) pruneEmptyDirs(DIST);

console.log(`[build] src/ → dist/ 完成：拷贝 ${copied.length} 个文件，逐文件字节比对全部一致`);
for (const line of copied) console.log(`  ✓ ${line}`);
if (pruned.length > 0) {
  console.log(`[build] 清理陈旧文件 ${pruned.length} 个（src/ 已不存在）：`);
  for (const line of pruned) console.log(`  − ${line}`);
}
