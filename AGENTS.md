# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

> ## 🐋 这是什么
> 本包 = **`dsh-deepmoyu`（DeepMoYu · 鲸鱼摸鱼）**，从 **`dsh-bili-scroll` 0.1.19** 分叉而来（上游
> [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)，MIT）。当前版本 `2.3.0`。
> **所有自动更新通道已整个删除**：`/api/bili-duty/upgrade`、`/api/bili-duty/update` 两条路由、
> `runUpgrade()`、`upgrading` / `lastUpdateSource` / `ghUpdateCache` / `updateCache` 四个变量、
> 设置页的「检查更新」「升到 vX.Y.Z」两个按钮 —— 全没了。
>
> **为什么删**：那个按钮会让宿主跑 `dsh plugin add`，把包目录重装成上游原版，而本分叉的所有改动都在包目录里。
> 2026-10-21 真发生过一次（m17605），恢复花整整一轮。
>
> ⇒ **本机这份分叉安装**（`D:/A_four_2/大肥鱼/plugin/dsh-dafeiyu`，工作区目录名仍沿用历史代号 `dsh-dafeiyu`）**绝对不要**跑 `dsh plugin add` / 点任何更新按钮；要升级只能从 `devtools\backups\plugin-ours-*` 手动覆盖。
> ⇒ 它在本机是**本地包**：profile 里靠 `dependencies: "dsh-deepmoyu": "file:D:/A_four_2/大肥鱼/plugin/dsh-dafeiyu"` +
> `node_modules` 里的 junction + `cordis.patch.yml` 的 `- id: dafeiyu` 接进去。
> （从 npm/GitHub 正常安装本插件的其他用户**可以**用 `dsh plugin add dsh-deepmoyu`，见 README。）

`dsh-deepmoyu`（插件名「**DeepMoYu · 鲸鱼摸鱼**」，模式名「🐟 鲸鱼摸鱼模式」）：每天替用户刷一轮 B 站 —— 搜、**读字幕原文**判断、写一份日报，特别值得的会发一条评论 **@ 用户**。也可以在鲸鱼摸鱼模式下**在这个对话里一轮接一轮地刷**（不另起进程）。
**内部代号说明**：cordis 入口 id / agent preset id / HTTP 路由（`/feiyu`、`/pet/*`）/ 工具名（`bili_feiyu`）/ 状态文件（`feiyu.json`）仍用历史代号 `dafeiyu`/`feiyu`——改名只动身份与显示层，内部标识保持不变以兼容既有运行数据与会话。

## 排查「发不出去」时，先看这三处（2026-10-21 两个真 bug 换来的）

1. **`activity.jsonl` 里那句「没成」的原文**是判据，别只看工具回执：
   - `name 'key_video_reply' is not defined`（或 `key_opus_reply` / `key_dm_reply` / `legacy_dm_keys` / `legacy_opus_keys`）
     ⇒ `vendor/bilibili-mcp/mcp_server.py` 的 import 块漏了 `runtime_guard` 的判重键函数。
     **改 vendor 那一份**（家目录那份每次加载会被 `ensureHomeFiles` 按内容覆盖回去），
     并同步 `devtools/patch_mcp_guard.py` 的 `BLOCK_A`，不然重跑补丁会把 bug 写回来。
   - `12014 发送失败，已达到当前评论发送上限` ⇒ **不是插件坏了**，是这个号的评论额度用完了
     （按账号算，跨天也未必立刻恢复）。必须回 `guard_status: "rejected"` + `retry_blocked: false`；
     要是回成 `unknown` / `already_replied: true`，说明 `_guarded_send` 的 `reject_codes` 少了 12014，
     那条判重键会被**永久毒死**，得去 `runtime-guard.sqlite3` 里把 `status='unknown'` 的行清掉。
2. **12014 只掐视频评论**：同一分钟 `bili_reply_opus` / `bili_dm_reply` 照样能发（2026-10-21 实测）。
   `lib/pace.mjs` 的 `QUOTA_SCOPES` 只管 `comment` + `reply`，**别把 `opusReply` / `dm` / `moment` 塞进去**，
   塞了就是白白停掉三条通的通道。
3. **改完 JS（`index.js` / `client.js` / `lib/*.mjs`）必须重启 DSH**：ESM 模块已缓存，
   宿主不会重新 `import`，`patchReload: live` 只重算 patch 层。Python 侧（`mcp_server.py`）不用重启 DSH，
   杀掉 python 子进程，下一次工具调用就会重 spawn 读新文件。

## 帮用户安装时，按这个顺序

1. **前提**：机器上有 `Python 3.10+` **或** `uv`（有一个即可）。
   两个都没有**也不用让用户先装** —— 插件点「装依赖」时会**自己下一份 `uv` 到自己的家目录**（免管理员、不用 PATH）；
   只有它自己也下不动时（网络到不了 GitHub / 加速代理 / PyPI 镜像），才需要引导用户手动装。
   · 它是**直连 GitHub → 国内加速代理 → PyPI 镜像**依次试的，并且会**核对官方 sha256** ✓
   · ⚠️ 若用户机器上的**杀软拦了这次下载**：让他把 `%USERPROFILE%\.dsh\bili-duty\bin\` 加白，或干脆自己装 uv / Python 3.10+ ✓
   · ⭐ **万一下载链路都不通**（有用户反馈"桌面版上这条链路经常不通"）：**手动放一份 `uv.exe` 到 `<家目录>\bin\` 就行**
     —— 插件会**用那一份、跳过下载** ✓（他 `PATH` 里本来就有 `uv` 的话，直接用那个 ✓）
2. **接进 profile**（本地包，**不要用 `dsh plugin add`**）：
   · 改 `profiles/web/package.json`：`dependencies` 加 `"dsh-deepmoyu": "file:D:/A_four_2/大肥鱼/plugin/dsh-deepmoyu"`，
     `dsh.profile.bundles` 里加 `"dsh-deepmoyu"`
   · `node_modules` 建 junction：`cmd /c mklink /J "<prof>\node_modules\dsh-deepmoyu" "D:\A_four_2\大肥鱼\plugin\dsh-deepmoyu"`
     （⚠️ `mklink /D` 符号链接要管理员权限，会失败；必须用 `/J`）
   · `cordis.patch.yml` 里把条目改成 `- id: dafeiyu` / `name: dsh-deepmoyu`（config 原样保留）
3. ⚠️ **提醒用户重启一次 dsh**（必须，bundle 层要重启才组装）。
4. 让用户**点右下角那只桌宠 → 设置 →「账号与环境」**：点「**装主依赖**」→ 点「**扫码登录**」（手机扫码，选"记住我 / 长期"）。
   · ⚠️ 2026-10-26 起**DSH 的「设置」里已经没有「刷B站」这一页了**（使用者要求：鲸鱼摸鱼的设置不进默认设置）。
     所有入口都收在桌宠身上：**单击鱼（或右键鱼）→ 菜单 → 设置**。工作台侧栏九项：偏好与桌宠 / 运行方式 / 互动与投递 / 表情收藏 / 学习与记忆 / token 账本 / 运行日志 / 日报视频 / 账号与环境。
     新开会话刷、后台与定时聚合在「运行方式」，活动与事件在独立「运行日志」，学习与 soul 在「学习与记忆」。
     桌宠藏起来之后，右下角会留一个 20px 的小圆点，点它把鱼叫回来；「偏好与桌宠」里也有「显示桌宠」开关。
   · ⚠️ 菜单卡、各面板、toast 都是 `[data-bd-pet]`（128×128 的鱼盒）的**后代**，不是兄弟 ——
     `[data-bd-pet-card]{bottom:calc(100% + 14px)}` 靠它当定位参照。挂到外层那个 0 高的包装 div 上，
     卡片会被算到 `y<0` 的屏幕外，表现就是"点桌宠没反应"（2026-10-26 真踩过，见 `devtools/check-menu-dom.cjs`）。
     同理，`cursor/touch-action/user-select/transform` 这些"手感"规则一律锁在 `[data-bd-pet-fish]` 上，
     落到 `[data-bd-pet]` 会被卡片继承（菜单文字不能选、弹窗里不能滚、鼠标停在弹窗上鱼还在放大）。
   · 装完可以用「账号」页的「**测一下**」自检：它真跑一次登录检查 + 一次搜索，直接回答"能不能用"。
5. **别擅自打开「自动评论并 @ 你」** —— 那是拿用户的号说话；要用得让用户自己填「要 @ 谁」。

## ⚠️ 已知环境差异（有用户反馈）

- ⭐⭐ **桌面版 DSH（NEXT）/ 0.2.x 装不起来 —— 已知真 bug，0.1.4 起已修**：0.1.3 及以前装到桌面版上，
  设置页里**根本不出现「刷B站」**，DSH 只留一句 `warning: 1 entry did not activate … failed to import` ✓
  （根因：宿主半 import 的 `@deepseek-ai/schemastery` / `dsh-tools` 是 *optional peer*，而桌面版 profile 是
  `autoInstallPeers: false` ⇒ pnpm 永远不装；`dsh-tools` 自己还带 4 个 peer，光装它也救不回来 ✗）。
  ⇒ **本分叉版已含这个修法**（不再裸 import `@deepseek-ai/*` —— `lib/hostdeps.mjs` 先找宿主那棵树、
  再退到自己依赖里那份，`defineTool` 拿不到就用**本地等价实现**；`schemastery` 正式进了 `dependencies` ✓）。
  还不行就要 `duty.log` 里那几行（里面会写"宿主依赖是从哪儿取的" ✓）。
- ⭐⭐ **桌面版（Electron / 不是 npm 全局安装）上"跑一轮 0.17 秒就结束、code=0、什么都没干" —— 0.1.6 起已修**
  （issue #5 / #6 / #7，三个人报的）：根因是 Electron 里 spawn 的 node 少了 `ELECTRON_RUN_AS_NODE=1`，
  而且 `dsh` CLI 在桌面版里不在 PATH 上。现在会带那个环境变量、并去应用目录里找 dsh；
  **还找不到就在 `duty.log` 里明说"请在设置里把 dsh 路径指过去"**（不再静默失败）。
  ⇒ 本分叉版已含这个修法（带 `ELECTRON_RUN_AS_NODE=1`、并去应用目录里找 dsh）；还跑不起来就要 `duty.log` 里那几行。
- **桌面版上"自动跑会卡"**：跑那一轮用的是 `dsh --profile headless --patch <overlay> <prompt>` ——
  有用户反馈桌面版上会卡在那儿。**先确认 dsh 版本与 profile**，别硬跑；跑不起来就先只用手动「现在跑一轮」。
- **别让用户自己去装环境** ✗：插件自带一份 uv 与依赖安装能力，先照上面第 1 条处理。

## 仓库结构（改代码时看这里）

- `index.js` —— host 半端：工具注册、调度、HTTP 接口、配置与每趟后台生命周期。后台模型/工具桥、学习审核、真实 usage 记账与运行事件在此接线。
- `client.js` —— 浏览器半端：**桌宠与九项侧栏设置工作台**。暖白浅蓝、衬线页标题与文字导航，菜单使用无底色 outline SVG；账本由 `PetTokenLedger` 独立渲染并支持截图视图。桌宠无呼吸光圈与贴图发光，保留浮沉与泡泡。
  · **PetSettingsModal 吃 `status` prop**：PetRoot 传入 `[st, setSt, fails]`，弹窗开着不再起第二条 /status 轮询；独立渲染没传 prop 时由 `useStatus(5000, paused)` 轮询。hook 顺序固定，不能条件调用。
  · 页面 key 为 `basic/run/speech/stickers/learning/ledger/logs/video/other`；`run` 内含 session/background 分段，`logs` 内含 events/activity 分段。`PetOtherSettings` 依 view 拆 learning/environment；学习读取只在学习页启用，离页清理轮询。图库由 `PetStickersPanel` 按需读取，固定区域内滚动，内置区只读。遇图库路由 HTTP 404 时提示完全重启 DSH、暂停自动重试但保留手动重试；不把路由缺失显示成空图库。文件上传由浏览器读取已选图片字节，`POST /stickers/upload` 只接收 base64，不读取用户传来的任意路径。
  · **只创建当前页组件树**：不能恢复为预先求值全部 tab 的节点。`PetSettingsView` 以 `React.memo` 隔离父层泡泡/toast 更新；状态 tuple 与 toast 回调保持稳定。`/pv` 只在视频页轮询，图库只在表情页轮询；离页和卸载清理，首次 basic 不请求 pv/learn/stickers。不透明工作台和菜单不做 backdrop blur。
  · 普通页使用显式两列 CSS grid，通栏卡用 `data-bd-span="2"`，`data-bd-stack` 仅用于确实同列的分组；偏好页 `data-bd-basic-grid` 四张卡直接放入 grid，长内容按行 stretch，不能用两列独立 stack 造成上下错位。`data-bd-basic-card="pet"` 按内容高度显示，其开关行不使用 `margin-top:auto`，避免为了与邻卡等高制造大片空白。窄屏单列及横向导航。账本不套普通双列。学习列表固定 360px（窄屏 320px），筛选与分页在列表外；日志/活动固定高度并在内部滚动。
  · 运行日志轮询 gate 是 `tab==='logs'`；`unchanged` 响应也必须安排下一次 timeout，切页需 cleanup。不能把已知0当未知，也不能把未知计量显示为0。
  · 账本契约：`st.tokensTotal` / `st.tokensToday` / `st.totalTokenBudget` / `st.activeDays` / `st.tokenRounds.entries[]`。`tokensUnknown` 显示未计量；已知用量同时有 `unknownRequests>0` 显示部分计量。菜单底部本轮 token 优先读 active `backgroundRun.usage.total`，否则 `feiyu.tokens.thisRun`；`tokTitle()` 只展示称号。
  · 不往 `settings.section` 注册，`inject` 为空数组；`apply()` 挂 CSS 与桌宠。测试从 `debugParts` 取 `PetSettingsModal` / `PetRoot` / `PetFish`。旧全页 `Panel` 已删，「显示桌宠」在「偏好与桌宠」。
  · ⭐ 2026-10-28「刷多久」语义（使用者原话：应该是刷多久、刷几轮，不是最长多久）：后台轮时长是**工作量目标**——`promptFor` 写明「要把本轮时间刷满、一轮接一轮」；`runDuty` 的 close 里若子进程**干净提前收工**（`stopReason==='exit'`、code 0、无 error）且剩余 ≥2 分钟，就 `petLog('bg-continue')` 并自动接力（`opts._chain` ≤ 8 次保险丝，续跑时长=剩余分钟）。学习审核轮、手动停（'user'）、出错、时限到（'time-limit'）都不接力。弹窗后台时长兜底标签是「没填时段时，一轮刷几分钟」，E2E 用 `labeled('一轮刷几分钟')` 找它——改名会红。
  · ⭐ 2026-10-28 后台「时段」任务（使用者原话：只要是在这段时间，他就一直刷）：配置 `backgroundWindowStart/End`（HH:MM，可跨午夜）= **常设指令**——`automationTick` 每一跳用纯函数 `backgroundWindowLaunch(cfg, st, now)`（lib/run-settings.mjs，有单测：段内/免跑牌/跨午夜尾段/边界）决定要不要 `runDuty('bg-window', { windowEndAt })`；`run.windowEndAt` 直接当 `runState.deadlineAt`（提示词会说「刷到几点」）。**配置本身就是持久化**：重启 DSH 不用恢复现场，下一分钟自动接上；「免跑牌」= `state.json` 的 `bgWindowHold`（手动停止时挂到时段结束，`/pet/stop` 写、`statusRev` 有它的位、手动 /pet/start 清）。时段**不进 /pet/start 请求体**（E2E 严格钉死 body），host 从 config 读。
  · ⭐ 2026-10-28 拟人包（全部显示层，不碰行为）：① `st.petEvent = {at,text,tone}` 是桌宠「说话」统一通道——`petEvent()` 写 state + act 流水，PetRoot 监听 `at` 变化冒 toast（**首见不冒**，ref 从 0 起步）；收工小结 `wrapUpLine`（深夜/傍晚/白天分档、翻车如实说、额度停牌说破「后半程只看不发」）、闲聊 `chatterLine`（`idleChatter` 开关，下一次开口时间存 `state.petChatterAt`，2.2~3.5h，定时这跳真要开跑就不聊）。② 时段任务连刷满 3 小时（按 `state.bgWindowSince` 的**墙钟**累计，懒模型单轮很短也能触发）⇒ `restUntil` 抢在接力**之前**算好：接力让路（`willContinue` 与小结/休息三方互斥——接力轮绝不发小结）、只认干净退出（user 停的牌不许缩短）、挂到时段结束前 15 分钟的免跑牌。③ `moodOf()` 从 soul「最近的心情」最后一行关键词推导 curious/content/glum，回落按最近一趟收尾 → `data-bd-pet-mood` 小灯四色。④ `st.attention.reasons`（依赖没装/审核积压 ≥5/额度停牌 >30min）→ aura `attention` 琥珀 + 菜单 footer 指引 + 首次 toast；**优先级在 run/bg 之下、idle 之上**。⑤ 后台子进程 pid 落 `state.bgChildPid`，宿主重启「认领」孤儿：只 ESRCH 探测 + 信标对账，**绝不单参 kill**（pid 复用误伤）。⚠️ PetRoot 有 `if (!pos) return null` 早退——**新 hook 一律挂在它之前**（2026-10-28 真踩过：挂早退后面，render-modal 的 hook 计数闸当场红）。
  · ⭐ 桌宠卡片贴缘几何：卡片 `left/right:-4px`（鱼盒 128 宽，贴边时 box 右缘=vw-6）——2026-10-27 之前的 `-8px` 会让卡片静止时戳出视口 2px（check-menu-dom top-right/top-left 真红过）。菜单回归闸等弹出动画（.22s）落定再量几何，别量在过冲半路。
  · 右键菜单悬浮预览（`[data-bd-preview]`）复用菜单卡的天蓝设计语言（`#edf8ff` 底、14px 圆角、徽章 eyebrow、虚线分隔、`bdPreviewIn` 入场动画，respect prefers-reduced-motion）；内容只用 /status 快照，悬停不发任何请求——这条契约有回归闸盯着。
- `lib/pet-session.mjs` —— 双击/菜单/设置中的新建会话复用同一路径。前端以 `uiWorkspace.selection` 和 `workspaces.list` 提供 `{sourceSessionId,workspaceId?}`，host 校验归属后仅向真实 `sessionController.create` 传 `agentPreset` 与 `workspaceId` 或 `cwd`。`cfg.workspace` 是提示词参考路径，不是执行工作目录；上下文不明且多工作区时不猜。
  · 权限从来源 agent 的实际 `sandboxPolicy` / `approval` / `permissionPresets` 读取，通过宿主预设 API/规范会话事件继承；保留 custom 组合和 Auto 身份检查，不接前端权限值、不改 profile/defaults。创建后继承失败返回 `ok:false` 和已建会话 ID，不能继续开刷。
- `lib/hostdeps.mjs` —— 从宿主树取依赖，拿不到才退到本包或本地等价实现；`lib/verify.mjs` 做评论发出后复核。
- `lib/model-relay.mjs` / `lib/model-relay-adapter.mjs` —— headless 通过本机临时能力调用父进程已注册的**原线路**，解决 buddy/xdpool 等只在 web profile 注册导致的 `NO_ADAPTER`。不复制凭证或改装 headless profile，不自动换收费模型。停止先撤销访问能力并中止流，按 `close` 收尾以免漏 stderr 尾部。
- `lib/background-tools.mjs` / `lib/background-tools-mcp.mjs` —— 后台工具复用父进程的开关、质量校验、判重、节奏、活动与学习账本，不直接绕到裸 Python MCP。后台不能伪造 `force`；已排队发送在提交前再检查停止信号。
- `lib/learn-review.mjs` / `lib/learn-review-mcp.mjs` —— 独立审核进程只批准/拒绝本批未变化的 pending 记录并附理由。普通鱼工具不能 approve/reject。失败同批至少 3 分钟重试、退避最多 30 分钟；实际剩余记录不为 0 时，code=0 也不能算整批完成。
- `lib/background-output.mjs` —— 有界 UTF-8 输出解码与脱敏诊断，保留模型、工具和失败进展。正常镜像同步成功不刷屏，错误必须可见。
- `lib/tokens.mjs` —— 每趟任务账本（`token-ledger.json`，最近 120 条）：
  · 入账点：`feiyuStart` / `adoptFeiyu`（连续 session）、`trackManualBrowsing`（实际内容工具触发的手动 session）、`runDuty`（background，含 schedule/window/review）；停止、销毁、blocked 或后台 close 收账。
  · 手动识别与人格分开：`browsingTools` 只包含实际 B 站内容读取和互动工具，设置/状态/记忆不算开刷；后台桥接执行不再建立手动账。`agent/status:running` 或 `session/event(session,event)` 的 `turn/start` 捕获请求前基线，首个内容工具开始认领本轮；`turn/end` / idle / disposed 幂等结账，普通预设的真实刷站可以入账但不放开人格/记忆门禁。
  · 手动停止使用 `agent.cancel({kind:'user'},{keepInbox:true})`；立即取消活动状态，保留 pending 直到请求退出以补最后 usage。`source:'manual'`、无 goal 的状态也必须在菜单/状态卡/设置/活动显示正在刷。缺投影时 `tokens.thisRun:null`、`tokensUnknown:true`，不能编成0。
  · 连续目标按活动分段计量：暂停时结束当前段，恢复时新建基线与明细；暂停间隙闲聊或独立手动刷站不能加到原目标。`resetTokensTotal` 要同时重设活动基线并重建活动明细，清账后不能从0游标回灌整段历史。
  · 总量以 `state.json` 的 `tokensTotal` 为准（实际刷站轮次增量 + 后台真实 usage）。明细只展示，**不能拿已裁剪明细加总冒充累计**。
  · 桥接只累加每请求最后一个可信 usage 快照，缺失不估算、不按 0 处理。混合有/无 usage 保留已知数并记 `unknownRequests`。旧 `bg-usage.jsonl` 仅兼容回填，不能与桥接重复入账；信标需同时有后台角色和明确 `BILI_DUTY_HOME`。
  · 后台 token 预算仍是**软预算**，真实 usage 用于记账；墙钟时限是独立定时器。不要误写成已有后台 token 硬熔断。
  · `/status` 与 `/pet/log` 支持 `?rev=`。`statusSnapshot()` 在同次请求复用 state 和镜像 manifest，`statusRev()` 将原变化信号摘要为 64 位十六进制 SHA256；别读 ledger 或扫 activity。保留 token 累计、今日、上限、连击和明细顶层字段，否则会回归累计显示 0。镜像由 `queueMirror()` 合并、延后和节流执行，不能放回同步状态响应路径。
  · `GET /diag` 排除凭证，不读 `bili_credential.json`；`resetTokensTotal` 连明细清空但保留上限，跨天重置 `tokensToday`。
- `lib/sticker.mjs` / `lib/sticker-download.mjs` / `lib/sticker-automation.mjs` —— 同一套内置只读与收集图库。自动收集和配图独立开关，默认关闭，概率默认 35% / 30%，冷却 60 / 180 秒，容量 1–60。下载逐跳校验公网地址并固定 DNS，最多 5MB；按内容去重，锁内复查容量和名称并合并账本，不接受客户端任意本地路径。设置页本地上传接收已选文件字节，限 PNG/JPEG/GIF/WebP、单张 5 MB，验证格式后与收集项共用容量、去重和删除规则；仅上传路由可接收至 7 MB JSON，其余接口保持原请求体限制。
  · 自动收集异步排队，仅由鱼模式评论图片触发；来源信号和会话范围必须在读取评论前捕获，停止时取消对应下载/排队并在提交前复查，不能取消其他会话或永久停掉后续新趟。`goals.pause` 本身不保证撤销正在运行的工具。
  · 自动配图只在允许的新视频评论通过原质量、权限和节奏闸后选择；显式图片优先，显式空字符串保留纯文字。回复楼层、私信和动态不自动配图；不能借配图绕过发送开关。图库 HTTP 接口与 `bili_sticker` 复用库函数，`/status` 不枚举图片。
- `prompts/duty.md` —— 一轮的章程，用户可改；`ensureCharter` 按摘要保护用户版本，新版可落 `duty.md.new`。
- `vendor/bilibili-mcp/` —— 内置 Python MCP（MIT，AGI_Ananas）。
- `selfcheck.mjs` —— 假 ctx 上真实运行两个半端的预检。
- `tests/` —— 统一入口 `npm test`（selfcheck + 全部 `.test.mjs`；包括桥接、停止竞态、真实/部分计量、后台自动审核、工作区归属、权限继承、图库与收集取消回归；数量以本次输出为准）。
  Python 那几个单独跑：`python tests\test_guard_cross_channel.py` 等；`verify_pv_sample.py` 是带参数的 CLI，不算用例
- `devtools/check-pet-image.mjs` —— 桌宠贴图那条静态路由的验收（`node devtools/check-pet-image.mjs`）：
  绕开浏览器真跑一遍 `index.js` 的 `apply()`，打 `/api/bili-duty/pet/image` 四条用例（200 真图 / 不传 name / 路径穿越 404 / 未知名 404）。
  ⚠️ 为什么要它：`pet-shot.cjs` 走 `file://` 直接读磁盘上的 png，**永远看不出路由挂没挂**；
  改了 `index.js` 之后宿主不重启，浏览器那边就是 404 + 静默退回纯 CSS 的鱼。
- `devtools/check-menu-dom.cjs` —— 桌宠菜单的**结构与定位**回归闸（`node devtools/check-menu-dom.cjs`）：
  假 React 真渲染 `PetRoot`（从 `debugParts` 取），断言卡片是 `[data-bd-pet]` 的后代、左右键与拖拽处理器挂对地方、
  再右键一次能收起；最后用 chrome headless 量 `getBoundingClientRect`，要求左下/右下两种摆位下卡片都完整落在视口内。
  ⚠️ 为什么要它：`render-modal.cjs` 只展开组件树、不做布局，卡片被甩到 `y<0` 那种 bug 它一个字都看不出来；
  截图能看出来但没有断言。改动 `PetRoot` 的渲染结构后**必须**跑这一条。

## 约定

- 配置与运行数据都在用户的 `$DSH_HOME/bili-duty/`，**不写进插件包目录**
- 谷时窗口按 DeepSeek 官方口径：工作日 9–12 / 14–18 是高峰，其余（含周末）都是谷时

## 看到工作区根目录那堆 `state.json` / `seen.md` 别当垃圾删

它们不是散落的文件，是**记录镜像**（`lib/mirror.mjs` 的 `mirrorOnce` 产出的脱敏投影，
每轮跑完 + 每次打开桌宠 ⚙️ 设置各同步一次）。名单固定 9 个：
`seen.md` `voice.md` `soul.md` `state.json` `feiyu.json` `duty.md` `charter.sha256` `config.json`（+ heavy 档的 `activity.jsonl`），
外加一份台账 `_mirror.json`（记 sha256 与来源）。

- **原件**在 `$DSH_HOME/bili-duty/`，镜像只是给人看的副本；删了下一轮会自动长回来
- 位置就在**工作区根目录**（`lib/mirror.mjs:11` 的 `MIRROR_SUBDIR = ''`）——
  这是 2026-10-21 使用者明确要的「在当前目录也放一份」，**不要**为了"整齐"把它挪进子目录
- 目标目录由 `out/` `digest/` 两个 junction 反推工作区根；两个都没了就退回 `cfg.mirrorDir`，
  再没有就不镜像（桌宠 ⚙️ 设置 →「全部设置」会提示）
