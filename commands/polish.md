---
description: 润色输入框草稿（增强提示词——调用 ztk_polish 工具润色 $ARGUMENTS 草稿并返回结果）
---

# /polish

把 `$ARGUMENTS` 作为草稿原文，调用 zcode-toolkit server 的 MCP 工具 `ztk_polish` 完成润色，把结果返回给用户。

执行步骤：

1. 调用工具 `ztk_polish`，入参 `draft` = `$ARGUMENTS` 的原文（不要改写、不要摘要）。
   用户在草稿里附带 `model:"providerId/modelId"` 或 `effort_level:"…"` 之类要求时，对应映射到同名可选入参；
   未指定就不传（走解析链默认）。
2. 工具成功返回后：把返回文本**原样**展示给用户——不附加解释、不加 markdown 围栏、不改写语言
   （上游模型被要求只输出润色后文本，见 `src/polish.mjs` 提示词模板）。
3. 提醒用户自行复制结果；主线形态**没有**自动写回输入框（官方无此 slot，方案 §1.1⑦ 明确接受的损失）。

错误处理（工具返回 isError 时）：

- 原样转述错误 message 给用户，**不要**自行更换模型重试——显式指定命不中即用户意图，
  静默换模型顶替正是本次重构要消灭的行为（`src/polish.mjs` 解析链①）。
- `NO_MODEL`：message 自带引导文案（去面板「模型拉取」写 provider_config.json /
  写 `enhance_config.json` 指定默认润色模型 / 插件设置配 polish_key），照抄即可。
- `AUTH`/`NETWORK`/`UPSTREAM`/`PARSE`：转述即可，不要重试（重试语义已在 server 侧实现）。
