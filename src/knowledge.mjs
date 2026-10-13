/**
 * knowledge.mjs —— 宿主版本 → 已知 schema / 格式知识表（方案 §4；§2.3-4/§2.5 doctor 检查项①的数据源）。
 *
 * 全局约定（所有 src/ 模块一致，并行实现者必须遵守）：
 * - 对 ~/.zcode 的一切路径一律可注入，解析优先级：函数入参 > 环境变量 > 默认真实路径：
 *   - ZTK_DB_PATH   默认 ~/.zcode/cli/db/db.sqlite —— 只读数据源；连接必须 node:sqlite readOnly:true，任何代码路径禁止写。
 *   - ZTK_V2_DIR    默认 ~/.zcode/v2 —— provider_config.json / enhance_config.json 所在根。
 *   - ZTK_STATE_DIR 默认 ~/.zcode/zcode-toolkit —— 插件自有 sidecar（doctor.json、迁移备份等）。
 *   - 其余路径（ZCode 安装目录、插件缓存目录等）经函数入参注入，默认值在各模块 JSDoc 声明。
 * - 测试一律注入 fixture 路径，绝不触真实 ~/.zcode。运行时允许的写仅限：
 *   provider_config.json（用户显式确认后；仅 puller.applyProviderConfig，带跨进程锁）、
 *   enhance_config.json、ZTK_STATE_DIR 下 sidecar——**逐文件可审计清单见
 *   docs/state-write-allowlist.md（唯一写者契约的书面版，S4）**，要点：
 *   - doctor.json：唯一写者 = doctor hook（writeSidecar）；server 等其余代码绝不读写-改-写它；
 *   - host_capabilities.json：写者 = server（initialize 握手观测落盘，doctor ③ 只读消费——
 *     见 src/doctor.mjs 检查项③的「server 实现者契约」）；
 *   - g0d.json：写者 = server（启动时 G0-d env 继承观测；独立文件，S3：不做 doctor.json RMW）；
 *   - backups/（迁移/写入前的时间戳备份）：写者 = migrate.runMigrate / puller.applyProviderConfig。
 * - 零 npm 依赖：只用 node: 内置模块。
 *
 * 本模块数据来源（第一手）：
 *   - review/g0/g0a-report.md（2026-10-13 G0-a 只读实测）；
 *   - 2026-10-13 本实现会话复测（node:sqlite readOnly 只读查询真实 db 与插件缓存目录）。
 */

/**
 * 已知的 db.sqlite schema_migration 迁移 id 白名单（版本哨兵知识表）。
 *
 * 语义：doctor / tps 哨兵读取 schema_migration 表【顶部（最新）一行的 id】，
 * 用 isKnownSchema() 判定其是否在表内；不在 → 判定 schema 漂移 → TPS 走降级文案
 * 「TPS 数据源暂不可用（宿主版本 X）」、doctor 记 degraded，绝不崩进程（方案 §1.1⑤ 降级行、§2.5 doctor①）。
 *
 * 注意：id 对应的 app_version 列是 db 内部版本（如 0.16.5），**不是**桌面客户端版本号（3.15.2）——哨兵以 id 列为准
 * （g0a-report.md §1 勘误）。
 *
 * 实测基线（均为只读查询，ORDER BY id DESC）：
 *   - g0a-report.md §1（2026-10-13）：顶部 5 行 0018…0022；
 *   - 2026-10-13 全表复测：共 22 行（app_version 0.2.0 → 0.16.5），顶部仍为 0022_backfilled_session_reasoning。
 *     本表收录全表 22 项：顶部 id 判定用；旧行一并收录，宿主回滚到旧代际时仍可判 known（降级只针对未知代际）。
 *
 * @type {string[]}
 */
export const KNOWN_SCHEMA_MIGRATIONS = [
  '0001_base_session_store',
  '0002_local_setting',
  '0003_backfill_permission_local_setting',
  '0004_session_target',
  '0005_session_target_accounting',
  '0006_input_history_attachments',
  '0007_workflow_script_runtime',
  '0008_workflow_definition_scope',
  '0009_session_title_metadata',
  '0010_usage_observability',
  '0011_session_target_summary_title',
  '0012_session_trace_id',
  '0013_session_target_active_run_accounting',
  '0014_message_part_sequence',
  '0015_message_part_sequence_backfill_and_guard',
  '0016_session_input_ledger',
  '0017_session_input_start_now_delivery',
  '0018_session_input_failed_status',
  '0019_dwf_journal',
  '0020_provider_model_selection',
  '0021_official_glm_selection',
  '0022_backfilled_session_reasoning',
];

/**
 * 列数与列分布基线（doctor①核对「列分布事实」的数据源；g0a-report.md §1 + 2026-10-13 复测一致）。
 *
 * 关键事实：turn_usage【无】query_source（26 列）；model_usage【有】query_source（40 列，方案附录 A-3 记 38 已演进）。
 * 该分布是 tps 两步走过滤 SQL（先经 model_usage 圈 main_turn 会话、再对 turn_usage 聚合）的存在前提——
 * doctor①核对它，漂移即记 degraded（§2.5 doctor① 勘误注）。
 *
 * @type {{
 *   turn_usage: { columnCount: number, hasQuerySource: boolean },
 *   model_usage: { columnCount: number, hasQuerySource: boolean },
 * }}
 */
export const KNOWN_TABLE_COLUMN_BASELINE = {
  turn_usage: { columnCount: 26, hasQuerySource: false },
  model_usage: { columnCount: 40, hasQuerySource: true },
};

/**
 * ServicePort 格式漂移史（方案 §1.2：zcode-tps.js:850-857 的格式漂移适配知识沉淀于此，
 * 供 doctor 做「宿主版本 → 已知格式」互备判断）。如实标注边界：插件 server 进程无法访问 renderer
 * 事件流，真·ServicePort 备胎只存在于默认关闭的 Go 兜底模块（方案 §2.3-4/V4）。
 *
 * @type {{hostVersion: string, format: string, note: string}[]}
 */
export const KNOWN_SERVICEPORT_FORMATS = [
  { hostVersion: '<=3.11', format: 'string', note: 'ServicePort 为字符串形态' },
  { hostVersion: '3.12.2+', format: 'object', note: '对象形态 + scoped-service-port 字段' },
];

/**
 * showcase / zcode-guide 已知版本记录（doctor④ ui.surfaces 协议漂移预警（§2.3-8）的对照基线）。
 *
 * 实测（2026-10-13，只读）：
 *   - zcode-guide：~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/ 下 0.1.0 / 0.2.0 / 0.3.0
 *     三版本目录并存，最新 0.3.0（其 .zcode-plugin/plugin.json 的 version 字段实读 = 0.3.0）；
 *   - showcase 0.4.3：来自方案调研副本 /tmp/zc_probe/showcase（manifest 模板来源），本机插件缓存未安装——
 *     doctor④在缓存中发现【不在本表内】的版本时记 warn（未知识化，ui.surfaces 协议可能漂移）。
 *
 * @type {{ showcase: string, 'zcode-guide': string }}
 */
export const KNOWN_PLUGIN_VERSIONS = {
  showcase: '0.4.3',
  'zcode-guide': '0.3.0',
};

/**
 * 判定迁移 id 是否在知识表内（tps.mjs / doctor.mjs 的 schema 哨兵都引用本函数，不得各自重写判定）。
 *
 * @param {string} id - schema_migration 表顶部行的 id（如 '0022_backfilled_session_reasoning'）。
 * @returns {boolean} true = 已知识化的 schema 代际；false = 未知代际。
 *   调用方收到 false 必须走降级路径（TPS 显示「数据源暂不可用」+ 面板保留历史快照；doctor 记 degraded），
 *   不得当异常抛崩、不得静默继续查询。
 *   对 null/undefined/非字符串入参返回 false（防御式，不抛）。
 */
export function isKnownSchema(id) {
  return typeof id === 'string' && KNOWN_SCHEMA_MIGRATIONS.includes(id);
}
