# test/data —— 测试夹具目录

只放测试 fixture（db.sqlite 副本/伪造 provider_config.json/假服务器脚本等）。

**硬性边界（方案安全边界）**：测试一律注入本目录（或 test/.tmp/）下的 fixture 路径，
绝不读写真实 `~/.zcode`（含 v2/、cli/db/）；绝不触 ZCode 安装目录；db 连接一律 `readOnly:true`。
