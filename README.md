# zcode-tokenspeed · ZCode 官方 MCP Apps 插件（TPS 监控 / 提示词润色 / 模型拉取）

<p align="left">
  <a href="https://github.com/c80361619/zcode-toolkit/releases"><img src="https://img.shields.io/badge/version-1.0.0-blue.svg?style=flat-square" alt="Version"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.5-339933.svg?style=flat-square&logo=node.js&logoColor=white" alt="Node ≥22.5">
  <img src="https://img.shields.io/badge/python-0%20(%E4%B8%8D%E5%86%8D%E9%9C%80%E8%A6%81)-success.svg?style=flat-square" alt="Zero Python">
  <img src="https://img.shields.io/badge/dependencies-0%20(node%20built--in%20only)-success.svg?style=flat-square" alt="Dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License"></a>
</p>

1.0.0 是**破坏性变更**：旧 0.6.x 的 asar 补丁链（思考强度滑条、用量图表去截断、模型弹窗加宽、
自愈看护、Python 工具链）已全部废弃删除。新形态是**一个官方 MCP Apps 插件**（manifest 同构
showcase 0.4.3：`mcpServers` node 进程 + `ui.surfaces` 侧栏面板 + `userConfig` + hooks）——
**零 asar 注入、零写入 ZCode 安装目录、零管理员权限、零 Python**，全部资产在 `~/.zcode` 用户目录。

> ⚠️ **声明**：非官方开源插件，与 ZCode 官方团队无关联。第三方声明见 [NOTICE.md](NOTICE.md)。
> （仓库名 `zcode-toolkit` ≠ 插件名 **`zcode-tokenspeed`**——市场内原位升级按插件名识别。）

---

## 三项功能

| 功能 | 形态 | 说明 |
|:---|:---|:---|
| 📊 **TPS 监控** | **常驻 banner + 侧栏面板详表** | 最近完成轮 tok/s / TTFT / 输入输出缓存读 + 会话累计 + 模型分布。数据源 `~/.zcode/cli/db/db.sqlite` **只读轮询**（G0-a 实测：完成轮 ≤2s 可见，P95=1969ms；非 token 级流式） |
| ✨ **提示词润色** | **`/polish` 斜杠命令 + 面板「粘贴 → 润色 → 复制」流** | 走 `provider_config.json` 凭据外呼模型（可在插件设置用 `polish_key` / `polish_base_url` 覆盖）；结果只返回，**绝不写回输入框** |
| ⚡ **模型拉取** | **侧栏面板确认流** | 填 baseURL / API Key / 协议（显式三选一）→ `ztk_models_fetch` 拉取去重 → 勾选 → `ztk_provider_config_apply` 合并写入 `~/.zcode/v2/provider_config.json`（providerId 精确匹配、apiKey 绝不反向覆盖、先备份再原子写、并发有跨进程锁保护） |

三项功能也都可直接对会话模型说：调用 `ztk_tps_query` / `ztk_polish` /
`ztk_models_fetch → ztk_provider_config_apply`；另有 `ztk_doctor_status`（体检）与
`ztk_migrate`（迁移预演）两个工具。

### 侧栏面板：工具通道自动探测（可用直连，否则指引模式）

侧栏面板在桥握手后会**自动探测**宿主沙箱是否转发标准 MCP 方法（`tools/list`）：转发则三个功能区
（TPS 刷新、模型拉取、润色）的动作按钮**直连插件 server 执行**，并订阅
`ui://zcode-tokenspeed/live/tps.json` 周期推送自动刷新 TPS 详表（面板徽标显示「工具通道可用」）；
不转发则自动回落**指引模式**——按钮提示你把对应的 MCP 工具调用转述给会话模型执行（徽标显示
「指引模式」），绝不假装成功。真实宿主的转发行为待装机确认（见
[docs/g0-poc.md](docs/g0-poc.md)）；无论通道形态如何，三功能本体经 MCP 工具与 `/polish` 命令始终可用。

## 前置要求

- **Node ≥ 22.5**（含 `node:sqlite`；开发机实测 v24.14.1）——`mcpServers.command=node` 与
  SessionStart hook（doctor 哨兵）共用这一依赖。**不再需要 Python。**
- ZCode 桌面客户端（TPS 数据源与迁移链路在 win32 / 客户端 3.15.2 实测）。

---

## 安装（新用户，两条路任选其一）

已证通道是**桌面客户端插件 UI**（本机实测无 `zcode` CLI，命令行安装形态未经证实，不在此承诺）。

### 路 A · 本地测试市场（开发/试用）

适合先用本地源码装一次看效果。机制摘自官方 plugin-creator 文档（完整归档见
[docs/g0-poc.md](docs/g0-poc.md) 环境勘察节）：**注册市场 / 安装 / 更新全部由你在 ZCode UI 手动完成**。

1. `git clone` 本仓库到任意目录（或直接用本地工作副本）。**市场根目录 = 仓库根**——
   `marketplace.json` 在仓库根，插件 entry 的 `source` 为 `"./"`，插件 manifest 在
   `.zcode-plugin/plugin.json`（目录名与 manifest `name` 一致性由仓库布局保证）。
2. 打开 ZCode **插件市场（Plugin Marketplace）→ 添加（Add）→ 添加插件市场（Add Plugin Marketplace）**，
   粘贴/选择**仓库根目录**（含 `marketplace.json` 的目录；不是 `.zcode-plugin` 子目录），点**添加**。
   桌面本地用户也可直接选目录。
3. 进入**个人（Personal）**，找到市场 `zcode-toolkit` 下的 **zcode-tokenspeed**，
   核对名称/描述/版本（1.0.0）后点**安装（Install）**。装好默认启用，也可在
   **设置 → 插件（Settings → Plugins）** 管理。
4. **更新**：源码更新（`git pull` + 版本号递增 + `marketplace.json` entry 同步）后——
   市场页齿轮 → **市场源（Marketplace Sources）** → 找到该本地市场 → **刷新该市场**（复用既有市场源，
   不要重复添加）→ 回**个人**，打开插件详情，出现新版本时点**更新（Update）**。
   注意：**源码编辑不是热加载**——刷新只更新目录，已安装副本必须再执行 Update。
5. 安装后**新建任务**发一条小验收提示（如让模型调用 `ztk_tps_query`）确认能力可用。

### 路 B · GitHub 市场（正式分发）

1. 打开 ZCode **设置 → 插件 → 右上角「创建」→「添加插件市场」**（或插件市场页的添加入口），
   来源填：`c80361619/zcode-toolkit`
2. 在插件列表找到 **zcode-tokenspeed**（1.0.0），点**安装**（装好默认启用）
3. 新会话首启时 SessionStart 的 doctor 哨兵会自动体检（结果落 `~/.zcode/zcode-toolkit/doctor.json`；
   也可随时让模型调用 `ztk_doctor_status`）

> 【G0-c 回填位】两条路的 UI 确切路径与安装/升级/卸载操作原文，待装机实测后回填
> （0.6.16 当年即经桌面客户端插件 UI 装成，通道本身已证；逐步操作序列见
> [docs/g0-poc.md](docs/g0-poc.md) G0-c 节）。

---

## 存量用户迁移指引（0.6.x → 1.0.0，**先 migrate、后升级**）

旧版直接在 ZCode 安装目录打 asar 补丁（残留约 3.2GB 备份垃圾，且旧看护进程可能在升级时重放补丁）。
**顺序原因一句话**：市场内原位升级后旧插件缓存目录是否保留未经验证、补丁链可能半死不活——
先把补丁链与垃圾彻底清退（migrate 的还原引擎已 vendor 在新仓库 `legacy/zcode_patcher.py`，
不依赖旧缓存存活），再切换到新插件。

```bash
git clone https://github.com/c80361619/zcode-toolkit.git   # 或直接进入已有仓库（main 分支）
cd zcode-toolkit

# ① 只读盘点（绝不改动任何文件；py 可用时自动预演六旗标还原）
node dist/migrate.mjs --check

# ② 预演「若加 --confirm 将执行什么」（仍不执行）
node dist/migrate.mjs --dry-run

# ③ 完全退出 ZCode（托盘右键退出）后，手动执行清退（唯一破坏性模式，需你显式确认）
#    存在 provider_config.json.reasoning-bak 且与现行配置有差异时，另需 --ack-reasoning-bak
node dist/migrate.mjs --confirm
```

migrate 会：终止旧看护进程并删除 `_watchdog.want` 队列 → 备份 `provider_config.json` →
按六旗标还原 app.asar（**不用 `--all`**，绕开会回滚供应商配置的 reasoning 分支）→ 校验
sha256 回到官方原始字节 → 精确清单清退 3.2GB 垃圾 → 列出（不删）v2 根残留。

全绿（`switchReady=true`）后：**卸载旧插件 → 安装/升级 1.0.0 → 首启确认 doctor 全绿**。
py 不可用或客户端版本失配时，migrate 会指引走兜底方案：ZCode 重装/升级一次即可全量覆盖
`resources\app.asar` 为官方原字节。

## ZCode 升级后：零维护

- 1.0.0 **从不写 ZCode 安装目录**（`C:\…\Programs\ZCode\`），全部资产在 `~/.zcode` 用户目录——
  ZCode 自身升级只覆盖安装清单内文件，**用户目录内插件资产零触碰，无需任何重放/恢复动作**。
- 唯一动作是下一次 SessionStart 的 doctor 哨兵自动体检（db schema 版本 / provider_config 可写性 /
  能力协商 / 插件版本漂移 / 旧补丁残留），异常 → banner 降级提示，不崩、不静默。
- 边界如实说明：宿主若改变插件装载机制/缓存布局，不受本插件控制——届时唯一信号是
  banner/面板消失（doctor 也不会运行），处理方式是重装插件或等适配版本。
- 插件自身升级走市场机制（见安装节），与 ZCode 宿主升级完全解耦。

## 故障排查

- **看不到 banner/面板**：让模型调用 `ztk_doctor_status`（五项哨兵见上），按报告指引处理。
- **doctor 报「检测到旧补丁残留」**：按上方迁移指引先跑 `node dist/migrate.mjs --check`。
- **模型拉取写入后未即时生效**：重启会话（热加载结论待装机实测，面板/工具文案已按谨慎口径标注）。

## 卸载

ZCode 插件界面卸载即可——安装目录从未被 1.0.0 写过，用户目录内插件资产随官方机制移除。
（若你是从 0.6.x 升级而来且从未跑 migrate：先按迁移指引清退旧补丁，再卸载。）

## 开发

```bash
node scripts/build.mjs        # 发布拷贝：src/ → dist/ 纯拷贝 + 逐文件字节比对（无构建器）
node --test "test/*.test.mjs" # node:test 全仓回归（真实安装冒烟默认关闭，设 ZTK_SMOKE_REAL=1 才启用）
```

全 Node ESM、零 npm 运行时依赖。架构与目录树见仓库源码各模块头部注释；阶段 0 验证记录见
[docs/g0-poc.md](docs/g0-poc.md)；运行时写目标的逐文件允许清单（唯一写者契约）见
[docs/state-write-allowlist.md](docs/state-write-allowlist.md)。

## 历史版本（0.6.x）

0.6.x 的补丁链实现、自愈看护与逐版本变更记录已随重构退役——完整档案见
git 历史（`git log` / 历史 tag）。本 README 只描述 1.0.0 起的保留功能。

## 许可协议

本项目采用 [MIT License](LICENSE) 开源协议。第三方组件声明见 [NOTICE.md](NOTICE.md)。
