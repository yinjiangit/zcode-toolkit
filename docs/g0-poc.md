# G0 验证记录（阶段 0 归档）

- **归档日期**：2026-10-13（本文件整合 G0 阶段两份第一手报告：**G0-a 实测报告**
  `review/g0/g0a-report.md`（数据源/实时性/基准）与 **G0-环境勘察**产物
  `review/ref/install-notes.md`、`review/ref/showcase-plugin.json`、
  `review/ref/showcase-server-excerpts.md`（工具链/安装通道/showcase 模板/校验探针））
- **方案依据**：`review/zcode-toolkit-rebuild-plan.md` §6 阶段 0（v4，四实验 + 基准记录）
- **第一手数据**：G0-a 实验脚本与原始日志在工作区 `review/g0/`（p1–p7 探针脚本 +
  `p3_poll_log.jsonl` 210s 轮询原始日志）；本文件是**仓库内归档副本**，阶段 3 TPS 验收的
  对拍基准以下文数字为准（评审意见 #13-②：基准须在迁移清退前采集——已满足，采集于
  2026-10-13，早于任何 migrate 执行）。
- 标注约定：〔G0-a〕= 数据源实测员第一手；〔勘察〕= 环境勘察员第一手；
  〔复核 2026-10-13〕= 发布收尾阶段由文档工程师重跑核实。

---

## 1. G0-a TPS 数据源与会话识别 ✅ go（已完成，2026-10-13）〔G0-a〕

**对象**：`~/.zcode/cli/db/db.sqlite`（实测时 362,594,304 字节活库，WAL 同期在写）；
node v24.14.1（win32），`node:sqlite` `readOnly:true` 只读连接，零 npm 依赖。
安全边界：全程只读连接，未向 `~/.zcode/` 与 ZCode 安装目录写入任何字节。

### 1.1 结论与判据对账（方案 §6 go 判据）

| 问题 | 结论 |
|---|---|
| db 只读轮询可行？ | **可行**。105 次轮询（210.8s）与 ZCode 并发写入共存，**0 次** SQLITE_BUSY/错误（V11 WAL 并发读证据） |
| 实时性判据 | 「进行中 token 增长」＝否（105 次轮询 0 次见到 `completed_at IS NULL` 行，无流式中途落库）；「完成行落库延迟 P95 ≤ 3s」＝**是：P95 = 1969ms ≤ 3000ms**（n=19 小样本，如实注明）→ **go，TPS 标「实时」** |
| 「实时」的确切含义 | 行在轮次完成的瞬间以**完成态** INSERT（lag 样本 5/56/149/436ms 级），观感延迟全部由 2s 轮询相位决定——即「每 2s 轮询能捡到刚完成的行」/「最近完成轮 ≤2s 可见」，**不是** token 级流式数字，文案不得假装 |
| 落库延迟分布 | model_usage 18 新行 lag：min=5 / p50=702 / p90=1934 / **p95=1969** / max=1969ms；turn_usage 1 新行 lag=436ms；合并 n=19 |
| 轮询查询成本 | 会话 id 缓存后主路径两条查询 avg ≈ 0.03ms；会话 id 解析查询（走 `model_usage_query_source_idx`）avg ≈ 6.1ms / p95 8.5ms → 工程上缓存 + 低频（建议 30s）重解析。2s 周期完全无压力 |
| 30 分钟长跑 | **未执行**（实测 210.8s=3.5 分钟，任务下限 ≥3 分钟已满足；长跑留待运行期观察） |

**代码落点对齐**：`src/tps.mjs`（realtime=true 口径 + 两步走 SQL + 会话 id 缓存）、
`src/knowledge.mjs`（schema 哨兵知识表 + 列分布基线）均已按本结论实现；
工具/banner 文案中的「P95=1969ms」「≤2s 可见最近完成轮」即引用本档数据。

### 1.2 会话过滤口径（两步走 SQL）

方案 §1.1⑤ 字面 SQL（turn_usage 过滤 query_source）**不可执行**——实测勘误：**turn_usage 无
query_source 列**（26 列），query_source 在 model_usage（40 列，cid 9）。正确实现两步走：

```sql
-- ① 低频解析（缓存结果，建议 30s；仅当最新轮所属会话 ≠ 缓存会话时重解析）：
SELECT session_id FROM model_usage
WHERE query_source='main_turn' AND session_id NOT LIKE 'sess_dwf-%'
ORDER BY started_at DESC LIMIT 1;
-- ② 每 2s 轮询（对已解析 session_id）：
--   最近轮：  SELECT … FROM turn_usage WHERE session_id=? ORDER BY started_at DESC LIMIT 1
--   会话累计：SELECT COUNT(*), SUM(input_tokens), … FROM turn_usage WHERE session_id=?
```

验证三连（`node p4_scope.mjs` + `p5b_checks.mjs`）：该口径圈出 41 个用户主会话；
`main_turn AND session_id LIKE 'sess_dwf-%'` 命中 0 会话（排除条件零误伤）；同时含 main_turn
与 subagent 的会话 = 0（subagent 行全部挂独立前缀 `sess_subagent_agent_<uuid>`）。
「精确当前会话映射」（MCP `extra.sessionId` ↔ db chat session_id）未取得直接证据——按方案以
「最新用户主会话」口径并在面板标注 session 尾号（多窗口并发时用户可察觉错位）。

### 1.3 doctor 版本哨兵基线

`schema_migration` 顶部迁移 id = **`0022_backfilled_session_reasoning`**（app_version 列是 db
内部版本 0.16.5，**不是**客户端版本 3.15.2——哨兵以 id 列为准）；知识表收录全表 22 项
（`src/knowledge.mjs` KNOWN_SCHEMA_MIGRATIONS）。列分布事实基线：turn_usage 26 列无
query_source / model_usage 40 列有——它是两步走 SQL 的存在前提，doctor① 核对之。

### 1.4 主会话基准（阶段 3 TPS 验收对拍用）〔G0-a〕

对象：`sess_6d861983-8d22-48c7-bbcf-4ec4ee195775`（模型 `account:bigmodel-individual-coding-plan/GLM-5.3`，
model_usage 115 请求全部此一模型；采集时刻 2026-10-13，采集于迁移清退之前）。
最近 10 轮（按 started_at 倒序）——tok/s = output_tokens/((completed_at−first_token_at)/1000)：

| # | turn | started(UTC) | 状态 | TTFT ms | 生成 s | tok/s | out | in | cR | total | 模型请求 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | turn_604bdb51 | 09:17:27 | completed | 6,436 | 1,333.4 | 29.1 | 38,839 | 1,587,597 | 1,495,040 | 1,626,436 | 12 |
| 2 | turn_6412b0de | 09:15:09 | completed | **null** | n/a | n/a | 7,621 | 263,638 | 0 | 271,259 | 1 |
| 3 | turn_a4b63825 | 09:11:07 | completed | 18,766 | 47.9 | 50.2 | 2,405 | 608,158 | 314,048 | 610,563 | 2 |
| 4 | turn_eb7baa1e | 07:57:06 | completed | 12,701 | 392.8 | 24.3 | 9,532 | 845,642 | 300,096 | 855,174 | 3 |
| 5 | turn_4bda0b8e | 06:50:03 | completed | 23,410 | 53.4 | 56.7 | 3,027 | 259,732 | 19,712 | 262,759 | 1 |
| 6 | turn_a0fc9695 | 05:29:48 | completed | 9,930 | 295.4 | 44.0 | 13,006 | 888,303 | 708,544 | 901,309 | 4 |
| 7 | turn_8ba1b7c5 | 05:08:21 | completed | 10,797 | 1,012.7 | 24.2 | 24,525 | 6,597,165 | 6,452,288 | 6,621,690 | 35 |
| 8 | turn_fb0eee02 | 04:55:25 | completed | 6,858 | 492.3 | 27.9 | 13,735 | 2,340,067 | 2,314,688 | 2,353,802 | 15 |
| 9 | turn_5ffcdd6f | 04:49:14 | completed | 9,976 | 90.7 | 26.4 | 2,396 | 563,632 | 438,976 | 566,028 | 4 |
| 10 | turn_f33e5b93 | 03:08:28 | completed | 27,330 | 538.2 | 30.9 | 16,656 | 2,022,892 | 1,903,488 | 2,039,548 | 16 |

- **最近 10 轮 tok/s**：中位 ≈ 28.5，区间 24.2–56.7；**TTFT 中位 ≈ 10.9s**，区间 6.4–27.3s。
- **会话累计（全 14 轮 = 13 completed + 1 cancelled）**：

| 轮数 | 输入 tokens | 输出 tokens | reasoning | 缓存写 | 缓存读 | computed_total |
|---|---|---|---|---|---|---|
| 14（13 completed） | 18,191,365 | 143,822 | 0 | 0 | 15,980,672 | 18,335,187 |

- 口径备注：①该供应商 reasoning/cache_creation 恒为 0（不拆分上报，如实记录）；②存在
  TTFT/first_token_at 为 NULL 的完成轮（out=7,621）——TPS 展示须按 NULL 容忍处理；③cancelled
  轮计入 14 轮计数，banner「轮数」口径需决定是否排除 cancelled。
- 阶段 3 验收：新实现同会话指标（tok/s/TTFT/累计）与本基准对拍，误差须可解释（旧 zcode-tps.js
  已于阶段 1 清退，对照基准而非旧版本体）。

### 1.5 回填方案的 4 处勘误（已吸收进实现）

① turn_usage 无 query_source，过滤两步走；②「无 session_id 索引」修正为「无专列索引，但 PK
(session_id,turn_id) 最左前缀可用（SEARCH 不产生全表扫描）」；③ model_usage 新增
`model_usage_query_source_idx`（共 5 索引）；④ subagent 会话独立前缀 `sess_subagent_agent_*`
（turn_usage 混含 72 dwf + 23 subagent 行，单表聚合必须先经 model_usage 圈会话）。

---

## 2. 环境勘察结论（G0 开工勘察，2026-10-13）〔勘察 + 复核〕

### 2.1 工具链与仓库

- node v24.14.1（满足 ≥22.5）、py 3.12.10 与 3.13.5 并存、claude CLI 2.1.283
  〔复核 2026-10-13 逐条重跑 `--version`〕。
- 旧插件缓存布局：`~/.zcode/cli/plugins/cache/zcode-toolkit/zcode-tokenspeed/0.6.16/`
  （市场名 zcode-toolkit → 插件 zcode-tokenspeed → 单版本目录）〔复核 2026-10-13 ls〕——
  这也是 README 安装节与市场 manifest 命名的实测依据。
- `legacy/zcode_patcher.py` 冻结副本与旧缓存原件 sha256 比对一致后入库（阶段 1 骨架动作，
  vendor 纪律——migrate 不依赖旧缓存存活）。

### 2.2 安装通道事实

- **本机无 `zcode` CLI**：`command -v zcode` exit 1〔复核 2026-10-13 重跑〕；安装目录与
  `~/.zcode/cli` 下亦无可执行 CLI 入口〔勘察〕。
- `claude` CLI 有 `plugin install/marketplace add/validate` 子命令，但其插件仓（`~/.claude`）与
  ZCode 插件仓（`~/.zcode/cli/plugins`）是**两套**（`claude plugin list` 实测只列 claude 自家插件）〔勘察〕。
- **已证可用通道 = 桌面客户端插件 UI**：zcode-toolkit 市场确经某通道进入
  `known_marketplaces.json` 且 0.6.16 实装〔勘察〕。
- **本地测试市场机制**（官方 plugin-creator SKILL.md + installing-and-updating.md 第一手摘录，
  全文 `review/ref/install-notes.md`）：agent 只产源码与市场清单，**注册市场/安装/更新/试用全部由
  用户在 ZCode UI 手动完成**；添加市场粘**市场根目录**（含 marketplace.json 的目录）；
  更新三段式 = 改源码 + bump 版本 + 同步 catalog entry，然后用户「刷新该市场 → 插件详情 → 更新」；
  「源码编辑不是热加载」；不能因源码存在就报告已装——交付口径必须显式标注待添加/待安装/试用待验。
  README 安装节路 A 即按此机制逐步写成。

### 2.3 showcase 0.4.3 官方模板勘察（manifest 同构依据）

〔勘察，全文 `review/ref/showcase-server-excerpts.md` + `showcase-plugin.json`〕

- 插件形态模板：`mcpServers.<name>`（stdio，`node ${ZCODE_PLUGIN_ROOT}/dist/server.mjs`，
  env 注入 `${user_config.*}`）+ `ui.surfaces[]`（id/title/icon/server/resourceUri/availability）
  + `userConfig`。1.0.0 的 `.zcode-plugin/plugin.json` 即按此同构。
- server 侧：MCP SDK 单文件 bundle，`registerTool` 的 `_meta.ui`（resourceUri/visibility/csp/surface）
  是 UI 呈现载体；**常驻 banner = `show_status_banner` 工具 + `openai/outputTemplate` 指向
  banner.html 资源 + 资源级 `_meta`（widgetHeightHint 等）**——1.0.0 banner 实现照此。
- 沙箱桥：无 contextBridge；UI 页面经 window.postMessage 与宿主通信，握手
  `ui/initialize → hostCapabilities → ui/notifications/initialized`；
  `getHostCapabilities()` 观测到的能力键含 **`serverTools`**（另有 message/sampling/downloadFile）
  ——这是侧栏面板「工具通道自动探测」设计（tools/list 探测 + 指引模式回落）的依据。
- 订阅推送：`resources/subscribe` + `notifications/resources/updated`（只对已订阅 URI 推送）
  ——`ui://zcode-tokenspeed/live/tps.json` 周期推送照此实现。

### 2.4 `claude plugin validate` 探针结论

最小插件目录（manifest 按 showcase 模板含 `ui.surfaces`，探针存档
`<工作区>/.zcode/tmp/validate-probe/myprobe/`）：

```text
$ claude plugin validate --json myprobe
{ "success": true, … "errors": [],
  "warnings": [{ "path": "ui", "message": "Unknown field 'ui'. Claude Code ignores it at load time." }] }
exit 0
```

**结论**：可作为发布 lint 使用（exit 0 / errors 空），但对 ZCode 特有字段 `ui` 报
「未知字段（警告，非错误）」——与方案 §3.1 预期一致（claude schema 不认识 ZCode 扩展字段，
不阻断）。〔复核 2026-10-13 重跑原样复现〕

---

## 3. G0-b provider_config 热加载 ⏳ 留作用户装机实测（安全默认文案已内建）

- **判据**：按 §1.1⑧ 合并策略写入一个测试模型条目（只写 provider_config.json，不同步
  config.json）→ 不重启会话观察模型列表是否出现 → 回滚写入。go → 拉取后提示「已生效」；
  no-go → 面板明示「重启会话生效」。
- **为何留作装机实测**：需要真实 ZCode 客户端运行中做「写入 → 观察模型选择列表 → 回滚」实验，
  本仓工作流内禁止写真实 `~/.zcode/v2/provider_config.json`（安全边界），无法代办。
- **安全默认已内建**：server 工具 `ztk_provider_config_apply` 的返回文案当前按 **no-go 谨慎口径**
  写「若未即时生效请重启会话」；README 故障排查节同口径。装机实测若判 go，只需收紧文案，
  行为无需返工。

## 4. G0-c 真实安装通道 ⏳ 留作用户装机实测（安全默认文案已内建）

- **判据**：桌面客户端插件 UI 添加 GitHub 市场 + 安装/升级/卸载全流程实测，操作原文回填
  README 安装节；探测是否存在 ZCode CLI 入口；`claude plugin validate` 对含 `ui.surfaces`
  manifest 的接受度（→ 已由 §2.4 探针先行回答：可用，警告不阻断）。
- **已写进 README 的两路安装**：路 A 本地测试市场（按 install-notes 机制逐步操作）、
  路 B GitHub 市场添加后安装——均为按已证通道与官方文档机制写出的**待装机验证**操作序列，
  README 安装节留有【G0-c 回填位】。
- **面板工具通道状态（防御式接线已内建）**：`ui/dashboard.html` 的 serverCall 在桥握手后以
  标准 MCP 方法名探测（`tools/list`）：宿主若转发 MCP 方法，面板动作经桥直调 `tools/call`，
  并 `resources/subscribe` 订阅消费 server 已实现的 `ui://zcode-tokenspeed/live/tps.json`
  周期推送（`notifications/resources/updated` → 自动刷新 TPS 详表）；探测超时/报错即自动回落
  指引模式（徽标明示「工具通道可用 / 指引模式」），**绝不假装成功**。待装机确认的唯一事项：
  真实宿主沙箱桥是否实际转发标准 MCP 方法（showcase 勘察观测到 hostCapabilities.serverTools
  能力键，支持该假设）——若转发形态不同，只需改 serverCall 单点。接线行为已在本仓离线验证
  （模拟转发/不转发两种宿主，见修复轮记录；真机确认仍归 G0-c）。

## 5. G0-d 插件 server env 继承 ⏳ 观测点已备、待装机读数

- **判据**：插件 server 启动时观测 `process.env`，坐实 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
  是否被 mcpServers 进程继承（该变量在 ZCode 派生子进程 env 中存在〔评审实测〕，插件 server
  进程未证）。
- **已备观测点**：`src/server.mjs` 启动时把该 env 的存在性与指向路径（只记路径，绝不记
  apiKey）写入 `<stateDir>/g0d.json` sidecar（独立单写者文件）；stderr 启动日志同步打印一行
  结论。**装机后读取该文件即得结论**，无需改代码。
- **补充数据点**：ZCode 派生的**深层**子进程（工作流子代理的 bash shell）env 中实测存在
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=C:\Users\59924\.zcode\v2\provider_config.json`——
  支持「ZCode 向子进程传播该变量」的假设；但 mcpServers 插件进程的 spawn 路径可能另行构造
  env（plugin.json 显式注入键），**插件 server 进程是否继承仍以装机读 g0d.json 为准**。

---

## 6. 验收对照（方案 §6 阶段 0 验收）

- 四实验结论 + 基准数据归档：G0-a ✅（§1，含主会话基准表）+ 环境勘察 ✅（§2）；
  G0-b/c/d ⏳ 留作用户装机实测（§3–§5，安全默认文案均已内建，双 no-go 不阻塞主线）。
- demo banner 可显示：✅（`ui.surfaces` + `show_status_banner` 已实现，server-smoke 测试覆盖）。
- 双 no-go 不阻塞主线（降级文案已定义），只影响文案与轮询周期默认值——G0-a 已 go，2s 默认成立。
