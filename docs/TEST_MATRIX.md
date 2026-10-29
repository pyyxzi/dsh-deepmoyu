# 功能与验收矩阵

本表对应 2.4.1。完整结果和环境边界见 [发布审查记录](RELEASE_AUDIT.md)。测试中的“发送成功”是受控 MCP 的包装器契约，不代表向真实账号发送过内容。

## 全部角色工具

`tests/tool-surface.test.mjs` 保存可执行的 `TOOL_SURFACE_EVIDENCE`。它校验注册工具清单与正向执行集合完全相等，并逐项核对有意义的输入、准确下游调用和返回字段；另外对全部工具执行普通模式和退出后的旧句柄拒绝检查。

| 工具 | 已验证的功能 |
| --- | --- |
| `bili_whoami` | 登录身份读取、完整长 MID |
| `bili_search` | 关键词、排序、范围/数量边界、已读过滤 |
| `bili_subtitle` | 字幕原文、时间参数、成功后已读记录 |
| `bili_danmaku` | 数量上限、时间聚合、样本与跳转 |
| `bili_buzzwords` | 热词、热度和图片字段映射 |
| `bili_video_info` | BV、作者、分 P、长 CID |
| `bili_rank` | 分区与榜单时间、已读过滤 |
| `bili_hot_videos` | 分页、上限与已读过滤 |
| `bili_user_videos` | 长 UID、分页、排序、关键词 |
| `bili_seen` | 补记与再次查询命中 |
| `bili_received_replies` | 长 rpid/root、回复资格 |
| `bili_my_notices` | 点赞、@ 与条数上限 |
| `bili_learn` | 新增待审、工具不能自行批准 |
| `bili_records` | 活动来源、稳定事件标识 |
| `bili_soul` | 指定章节追加和读回 |
| `bili_taste` | 统计与样本不足状态 |
| `bili_my_dynamics` | 动态列表、长 ID、评论状态 |
| `bili_opus_comments` | 长动态/评论标识与回复资格 |
| `bili_my_video_comments` | 视频/评论数量限制与本人评论排除 |
| `bili_reply_opus` | 开关允许后的受控发送与精确目标 |
| `bili_dm_inbox` | 收件箱、长 UID/消息序号、资格 |
| `bili_dm_thread` | 对话目标、消息数与消息标识 |
| `bili_dm_reply` | 当前资格核对、精确 UID/序号发送 |
| `bili_deliver` | 向已人工配置的目标投递 |
| `bili_comments` | 评论数量、正文、长评论/作者标识 |
| `bili_sticker` | 图库列表；上传/审核另有专项 |
| `bili_reply` | 评论包装器、纯文字与 BV 发送 |
| `bili_status` | 登录、权限、长 UID 与运行状态 |
| `bili_pace` | 指定通道的只读节奏状态 |
| `bili_say` | 有效旁白记录及来源关联 |
| `bili_run` | 受控后台启动与结束 |
| `bili_feiyu` | 建立、查询、暂停、恢复与清理自有目标 |
| `bili_pv` | 成片、制作任务及会话列表；制作另有实渲染 |
| `bili_moment` | 已授权后的受控动态发送 |
| `bili_login_start` | 本轮二维码与 key |
| `bili_login_poll` | 当前二维码完成与凭证私密持久化 |
| `bili_setup` | 安装流水线完成与真实运行校验状态 |
| `bili_config` | 安全偏好修改；人工授权字段不能被模型改变 |

## 深层专项

| 功能范围 | 主要自动证据 |
| --- | --- |
| 模式、旧句柄与全局服务别名 | `mode-scope.test.mjs`、`tool-scope-alias.test.mjs`、`host-tool-scope.test.mjs`、两项人格/goal QA |
| 普通宿主会话不受影响 | `host-bundle-smoke.mjs` 真实 bundle/预设声明组合与回环模型普通请求 |
| 新会话、工作区和有效权限 | `pet-session.test.mjs`、`pet-run-routes.test.mjs`、`pet-run-settings.test.mjs` |
| 后台桥接、取消、计量 | `background-tools.test.mjs`、`model-relay.test.mjs`、`manual-browsing.test.mjs`、真实 headless relay |
| 时段、定时与恢复 | `automation*.test.mjs`、`background-window.test.mjs`、`product-status*.test.mjs` |
| 配置事务、授权与防护 | `config-safety.test.mjs`、`authorization.test.mjs`、`send-review-routes.test.mjs` |
| 登录与环境升级 | `login.test.mjs`、`python-env.test.mjs`、`install-routes.test.mjs` |
| 真实 Python MCP | `check-real-mcp.mjs`，实际 FastMCP 握手与本地 SQLite 守卫 |
| 节奏、永久判重及发送复核 | `pace*.test.mjs`、`dup-cross-channel.test.mjs`、`reply.test.mjs`、`verify*.test.mjs`、`test_guard_cross_channel.py` |
| 端到端长 ID | `mcp-ids.test.mjs`、`tool-surface.test.mjs`、`check-dm-uid-browser.cjs` |
| 学习、记忆与隐私 | `memory-chain.test.mjs`、`memory-center*.test.mjs`、`background-output.test.mjs` |
| 表情与图片 | `sticker*.test.mjs`、`test_reply_pictures.py`；包括格式、字节审核、公开地址、容量、取消和并发 |
| 账本、回顾与陪伴 | `token-ledger.test.mjs`、`product-status*.test.mjs`、`companion*.test.mjs` |
| 视频编排、终态与媒体 | `pv-*.test.mjs`、`test_pv_*.py`、实际配音/封面/渲染/校验全链 |
| 可选 ASR 与收藏边车 | `test_optional_sidecars.py`：本地输入保留、独占清理、同视频并发、参数与失败；外部服务为 fake |
| 桌宠与全部页面 | `check-ui.cjs`、六项浏览器 QA，含十个主/子页、三视口、菜单、记忆、请求竞态与 UID |
| 下载与供给链 | `uvfetch.test.mjs`、实际官方 uv 下载/校验；npm 与主 Python 依赖审计 |
| 分发完整性 | `release-contract.test.mjs`、`test_release_archives.py`、`release:check/build/smoke` |

## 边界

- 代码行覆盖率不等于所有行为都已验证；矩阵与实际结果分别保留，不用测试总数替代功能证明。
- 真实平台发送、私人账号登录、GPU/用户自配音色和大型 Whisper 模型的识别质量，不通过本轮自动测试冒充验证。
- 目录打开已测三个平台的进程参数与故障行为，本机以外桌面未实机测试；GitHub CI 配置不等于远程 CI 已经运行。
