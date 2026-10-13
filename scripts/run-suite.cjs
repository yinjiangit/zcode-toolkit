/**
 * run-suite.cjs —— test/ 目录作为 node --test 位置参数时的模块入口（门禁修复）。
 *
 * 背景：node ≥ 22 起 test runner 位置参数按 glob 语义处理，目录路径（`node --test <repo>/test/`）
 * 在部分 node/win32 组合（本机 node 24.14.1 实测）不再递归找测试文件，而是被当作模块入口直接
 * 加载，报 `Cannot find module '...\test'`（同坑记录见 .github/workflows/ci.yml 回归步骤注释）。
 *
 * 修法：`test/package.json` 的 `main` 指向本文件（注意——本文件刻意放在 scripts/ 而不是 test/ 下：
 * 裸 `node --test` 会把 test/ 目录下所有 .js/.cjs/.mjs 都当独立测试文件并发执行，入口若在 test/
 * 内会导致整套测试被双重并发执行、sqlite fixture 竞争报 "table schema_migration already exists"；
 * 而 test/package.json 是 .json 不被匹配，本文件也不在 test/ 下——三种调用形式互不干扰）。
 *
 * 行为：按确定顺序（文件名排序）串行动态 import test/*.test.mjs，与 CI 的 glob 形式
 * （node --test "test/*.test.mjs"）跑完全相同的真实测试——任何真实回归在两种形式下同样会红。
 * 零 npm 依赖（node:fs/node:path/node:url）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = path.resolve(__dirname, '..', 'test');
const testFiles = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (testFiles.length === 0) {
  console.error('[run-suite] test/ 下没有 *.test.mjs（异常状态，疑似文件丢失）');
  process.exitCode = 1;
} else {
  // 串行 import：保证各文件按确定顺序注册到同一 root harness（node:test root 默认串行执行）。
  // Windows 下动态 import() 只接受 file:// URL（裸盘符路径报 ERR_UNSUPPORTED_ESM_URL_SCHEME），
  // 故经 pathToFileURL 转换。CJS 无顶层 await，用 promise 链；任一文件模块体抛错 →
  // 记录并以非零码退出（门禁保持敏感）。
  testFiles.reduce(
    (chain, f) => chain.then(() => import(pathToFileURL(path.join(dir, f)).href)),
    Promise.resolve(),
  ).catch((err) => {
    console.error('[run-suite] 加载测试文件失败：', err);
    process.exitCode = 1;
  });
}
