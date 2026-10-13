# 运行时写允许清单（可审计书面版）

- **版本**：1.0.0（2026-10-13 随二轮修复落档；对应评审发现 S4 的「落成可审计的书面清单」建议）
- **效力**：本文件是 `src/knowledge.mjs` 全局约定中「运行时允许的写」的逐文件展开，供评审与
  owner 审计/裁定；代码侧契约注释（knowledge.mjs / doctor.mjs / server.mjs / puller.mjs）与
  本文件必须同步修订。**owner 正式签认前**，本清单按「现状等效授权」口径生效（单写者 + 原子写
  + 插件自有 state 根 + 测试断言四重缓解，见各项「验证」列）。
- **范围**：插件运行时（server / doctor hook / migrate / puller）可能产生的一切写动作。
  **ZCode 安装目录（resources/ 等）零写入**是结构性约束，不在清单内——任何代码路径禁止。

## 清单

| # | 写入目标 | 唯一写者 | 触发与门控 | 写机制 | 验证（测试断言） |
|---|---|---|---|---|---|
| 1 | `~/.zcode/v2/provider_config.json` | `puller.applyProviderConfig`（src/puller.mjs） | 仅 `ztk_provider_config_apply` 工具调用（调用即用户显式确认）；读失败/形状非法中止，禁止空配置重建 | 进程内互斥 + 跨进程锁 `provider_config.json.ztk-lock` + 备份 + 唯一名 tmp + rename 原子写 + rename 前 mtime 复核 | test/puller.test.mjs（写安全三原则 + S1 并发 4 测） |
| 2 | `<stateDir>/backups/provider_config.<ts>.<唯一后缀>.json` | `puller.applyProviderConfig` | 同 #1（每次成功写入前备份原文） | 普通写（备份文件本身） | test/puller.test.mjs |
| 3 | `<stateDir>/backups/provider_config.pre-migrate.<ts>.json` | `migrate.runMigrate`（src/migrate.mjs） | **仅** CLI 手动 `--confirm`（MCP 面永不代传 confirm） | copyFileSync | test/migrate.test.mjs ④ |
| 4 | `~/.zcode/v2/enhance_config.json` | `polish.mjs`（润色默认模型热配置） | 用户/模型按引导写入默认润色模型时 | tmp+rename | test/polish.test.mjs |
| 5 | `<stateDir>/doctor.json` | **doctor hook**（src/doctor.mjs `writeSidecar`） | 每次 SessionStart 自动（异常也 exit 0 不阻断会话） | tmp+rename；**唯一写者**——server 等其余代码绝不读写-改-写它（S3 处置） | test/doctor.test.mjs；test/server-smoke.test.mjs 断言 server 不创建 doctor.json |
| 6 | `<stateDir>/host_capabilities.json` | **server**（src/server.mjs `negotiate`，initialize 握手观测） | 每次 initialize 握手覆写（doctor 检查项③的「server 实现者契约」：doctor 只读消费） | tmp+rename；单写者 | test/server-smoke.test.mjs（两处断言） |
| 7 | `<stateDir>/g0d.json` | **server**（src/server.mjs `writeG0dObservation`，启动一次） | server 进程启动时记录 G0-d env 继承观测（只记路径形态，绝不记 apiKey） | tmp+rename；独立单写者文件（S3：不做 doctor.json RMW） | test/server-smoke.test.mjs |
| 8 | `~/.zcode/cli/db/db.sqlite` | **无写者（只读）** | 任何代码路径禁止写（`node:sqlite` readOnly:true） | — | 契约注释 + 只读连接实现 |
| 9 | ZCode 安装目录（`…/Programs/ZCode/resources/` 等） | **无写者** | migrate 对其只读盘点；破坏性还原仅经用户手动 CLI `--confirm` 调 vendor 的 legacy patcher 子进程 | — | test/migrate.test.mjs ③（无 confirm 不动任何文件） |
| 10 | migrate 清退删除（resources/ 残留清单内文件） | `migrate.runMigrate` | 同 #3（且仅在 sha256 校验通过后；精确清单逐项删，不通配递归） | fs.rmSync 逐项 | test/migrate.test.mjs ④（版本失配→跳过清退断言） |
| 11 | 旧看护进程终止 + `_watchdog.want` 删除 | `migrate.runMigrate` | 同 #3（步骤 1 动作） | taskkill / fs.rmSync | test/migrate.test.mjs ④ |

## 临时文件（写后必清理/自愈，不视为持久写）

- `provider_config.json.<唯一后缀>.ztk-tmp`（puller，rename 消费或失败清理）
- `provider_config.json.ztk-lock`（puller 跨进程锁，finally 释放；超龄残留可破除）
- `.<file>.<pid>.<ms>.tmp`（doctor/server sidecar 原子写中转，rename 消费）

## 修订记录

- 2026-10-13（二轮）：落档为可审计书面清单（S4）；doctor.json 收敛为 doctor hook 唯一写者、
  g0d.json 独立文件（S3）；host_capabilities.json / g0d.json 显式纳入（原评审口径外的两个 state 写）。
