# 第三方组件与许可声明

本项目代码为原创实现。以下部分包含来自第三方的代码或设计参考，按相应许可要求在此集中声明。

## 1. 模型拉取前端脚本（MIT License，已随 0.6.x 退役）

- 0.6.x 曾 vendored 的 `skills/zcode-tokenspeed/scripts/zcode-model-puller.js` 及其配置同步逻辑
  移植版 `model_pull.py` **已于 1.0.0 随旧补丁链整体退役**，不在本包内分发；历史版本可经
  git 历史查阅（如 tag/commit `cb46ade` 及更早的 0.6.x 提交）。
- 1.0.0 的 `src/puller.mjs` 为全新 Node 实现（官方 MCP Apps 插件形态，server 单点拉取），
  继承其合并语义的关键约束（providerId 精确匹配、apiKey 不反向覆盖、读失败中止不重建），
  不含上述 vendored 代码。为尊重历史 vendored 版本的许可，保留其声明如下：

```
MIT License

Copyright (c) HHQ-666

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. 设计参考（非代码引用）

- 思考强度滑条（0.6.x 功能⑥，已废弃）的视觉规格曾参考 `dsh-reasoning-effort` 项目公开的
  设计语言，**代码为本项目自行实现**；该功能已随 1.0.0 裁剪退役，历史实现见 git 历史。
- 输入框「增强提示词」（现保留功能：`/polish` 命令 + 面板粘贴流）的交互与提示词要点对齐了
  WorkBuddy 的 `input.enhance` 功能，提示词模板为本项目自行撰写。
- 1.0.0 插件形态（mcpServers + ui.surfaces + userConfig manifest）同构 showcase 0.4.3 的
  官方模板（官方插件生态公开示例），协议行为以其公开实现为参照。
