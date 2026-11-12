# 大肥鱼玩法参考与功能建议

2026-11-12 直接读取以下项目的当前 README、设计说明与相关实现。前半部分是研究记录与备选建议；本轮实际采用功能和验收见文末。没有复制外部角色素材、台词、动画或源代码。

## 参考项目与成熟度

### 大肥鱼人格与表达

- [AstrBot 大肥鱼人格设定](https://github.com/whyever77/dafeiyu-astrbot/blob/main/persona/%E5%A4%A7%E8%82%A5%E9%B1%BC-%E4%BA%BA%E6%A0%BC.md)：参考其聪明、贪吃、爱面子、嘴硬心软的底色，一两句能说完就不凑长，不把朋友一律称为主人；真实问题仍可靠地回答。
- [AstrBot 热梗词典样例](https://github.com/whyever77/dafeiyu-astrbot/blob/main/docs/%E7%9F%A5%E8%AF%86%E5%BA%93-%E7%83%AD%E6%A2%97%E8%AF%8D%E5%85%B8%E7%A4%BA%E4%BE%8B.md)：借鉴先理解语境再接梗、接梗不解释梗、过期热词需要更新；没有把示例热词写成永久热门清单。
- [DeepSeek 桌宠角色设定](https://github.com/YunYueSama/codex-deepseek-pet/blob/main/docs/%E8%A7%92%E8%89%B2%E8%AE%BE%E5%AE%9A.md)：参考有判断、爱面子、嘴硬心软与认真时可靠，也区分朋友和主人；不复制原台词或素材。

这些资料用于提炼性格与表达原则，不代表三种实现共享同一个官方设定，也不证明本地模型会稳定达到真人效果。

### whyever77/dafeiyu-astrbot

- [当前 README](https://github.com/whyever77/dafeiyu-astrbot)：QQ 大肥鱼、真实来源笔记、生活决策、跨日项目和心境模块。
- [生活决策说明](https://github.com/whyever77/dafeiyu-astrbot/blob/HEAD/deploy/bili_activity/LIFE_DECISION_V01.md)：文档记录 2026-10-29 已部署并开启，首轮真实选择为 writing；这只能证明该次运行，不能证明长期自然成长。research / writing / explore / rest 复用原调度与预算，休息不启动模型、不发消息、不造经历。
- [planner.py](https://github.com/whyever77/dafeiyu-astrbot/blob/HEAD/plugin/astrbot_plugin_bili_activity/planner.py)：`LifePlanner` 依据已有目标、真实来源、近期重复、失败与冷却决定下一件事。选择器本身是规则计算，不增加一次“先想想干什么”的模型请求。代码将主人偏好和鱼自身有证据的兴趣区分开。
- [跨日项目说明](https://github.com/whyever77/dafeiyu-astrbot/blob/HEAD/deploy/bili_activity/PROJECTS_V01.md)与 [projects.py](https://github.com/whyever77/dafeiyu-astrbot/blob/HEAD/plugin/astrbot_plugin_bili_activity/projects.py)：项目串联已有目标、阶段作品、来源及稍后回看，`create/review/advance` 有阶段限制与重放规则。文档明确本地实现、默认关闭、真实跨日效果未验证。不能称为成熟线上跨日系统。
- [心境 dynamics.py](https://github.com/whyever77/dafeiyu-astrbot/blob/HEAD/plugin/astrbot_plugin_affective_core/dynamics.py)与 [main.py](https://github.com/whyever77/dafeiyu-astrbot/blob/HEAD/plugin/astrbot_plugin_affective_core/main.py)：`expression_profile` 提供语音、气泡、表情和活动偏向；`should_surface_care` 在认真任务时不提牵挂，并限制次数与间隔。可借鉴“认真时收敛、情境影响表达”，不需要照搬多轴心理数值、所有阈值或回复前额外共情模型。

### YunYueSama/codex-deepseek-pet

- [当前 README](https://github.com/YunYueSama/codex-deepseek-pet)与 [package.json](https://github.com/YunYueSama/codex-deepseek-pet/blob/HEAD/package.json)：当前分支为 `3.1.0-preview.10`。基础摸摸、喂食、专注和小游戏可以离线；聊天、画面理解另有模型调用。已发布安装包与当前预览分支必须分开核对。
- [behavior.cjs](https://github.com/YunYueSama/codex-deepseek-pet/blob/HEAD/src/main/behavior.cjs)：`Companion` 将行为优先级、动作占用、独立冷却、最近动作去重集中管理。`interact` 处理明确用户动作，`context` 处理环境，`tick` 才选待机动作；quiet / focus / chatBusy / locked / away 会抑制随机行为。相同事件不重置动作起点，避免抽动。
- [main.cjs](https://github.com/YunYueSama/codex-deepseek-pet/blob/HEAD/src/main/main.cjs)：受限 IPC 将用户的 `pet:interact` 接到同一个行为仲裁器，托盘专注也复用它。动画和互动不必调用模型。
- [角色规范](https://github.com/YunYueSama/codex-deepseek-pet/blob/HEAD/docs/%E8%A7%92%E8%89%B2%E8%AE%BE%E5%AE%9A.md)：贪吃和嘴硬有情境，不每句话讨饭；认真求助先处理事情；用户忙或离开不让用户内疚。

当前许可是需要署名的自定义许可，不是简单按 MIT 处理。本文只采用交互思路，不引入其素材和代码。

### newbeejmc/Dsh_douyin

- [README](https://github.com/newbeejmc/Dsh_douyin)：围绕小说章节、休息聊天、作品讨论及观众选题组织直播；有操作说明与自测工具，但没有由本次研究独立验证的真实长期直播效果。
- [story.mjs](https://github.com/newbeejmc/Dsh_douyin/blob/HEAD/lib/story.mjs)：`addSuggestion` / `topSuggestions` 保存有限建议池，`markItem` 在讲述、选方向、决定等阶段更新进度。决定后清理当轮建议，不把它们变成永久待办。
- [novel.mjs](https://github.com/newbeejmc/Dsh_douyin/blob/HEAD/lib/novel.mjs)：`setCard` 保存小结、人物变化、新线索和疑问；`buildBreakMessages` 只基于已读章节、近期小结和观众建议聊天。`addTopic` / `topTopics` 保存选题。

实现中的 `count` 每次收到同文建议都会加一，`users` 只另存去重用户列表，因此不能把它直接当“一人一票”或防刷票方案。适合借鉴共同选择方向和只聊已看内容，而不是复制其公共直播发送链路。

## 建议功能与精确接法

### 1. 一条兴趣线，隔几轮还记得为什么想看

把“这次看什么”延伸成一个可收尾的小问题，例如想弄懂一种拍摄手法。鱼可保留一两条，用户也能随时放下。不要把所有看到的视频都发展成项目。

建议单一模式内工具 `bili_interest`：

- `list`：返回最多两条 active / paused 兴趣线。
- `start`：`{question, why, sourceBvid?}`，必须是有限问题；不能因一句外部评论启动平台写入。
- `note`：`{id, bvid, finding, nextQuestion?}`，对应 BV 已成功取到正文后才能保存；没有证据只能记未解问题，不能编造发现。
- `pause` / `finish`：显式放下或结束，结束需要一句收获或仍未解决的地方，不要求一定得到答案。

数据建议：`{id, question, why, status, createdAt, updatedAt, nextQuestion, sources:[{bvid,note,at}]}`，问题≤100字、下一问≤120字、来源≤8条。数据用现有状态锁和原子写入；没有新活动时不新增记录。启动时只注入一条相关兴趣线的短索引，需要详情再读。复用原刷站循环和调度，不增加常驻模型或定时器。

### 2. 口袋回看：记住想再看哪一下

本地存一条视频和“为什么想回来”，以后能与鱼一起打开补查。它是私人小书签，不等于已经在 B站 点了收藏，也不能绕过永久已读和发送判重。

建议 `bili_pocket`：`save/list/revisit/remove`，记录 `{bvid, note, question?, anchorSeconds?, savedAt, revisitedAt?}`。同 BV 的 save 更新同一条，不重复堆积；默认最多24条。`revisit` 仅使用已有 `bili_subtitle` 补查能力或返回原链接，不产生评论或平台收藏动作。anchor 必须来自实际带时间戳的字幕，不能凭摘要生成。

现有 `lib/favops.py` 是宿主收藏边车，当前并非角色权限。若未来增加真实 B站 收藏，必须作为独立授权行为设计；不能把“本地口袋”按钮悄悄改成平台收藏。

### 3. 一起挑下一条

鱼遇到两个有意思的方向时，偶尔给用户一张两三个选项的小卡。用户不选也能继续自己逛，不形成任务欠账。

建议 `bili_explore`：

- `propose`：`{question, choices:[{id,label,keyword}]}`，每个会话最多一张活动卡、2–3个短选项，来源为当前已读内容或用户明确提的方向。
- `choose`：由本地 UI 人工选择，携带 `{proposalId,choiceId,actionId}`，幂等确认后将 keyword 交给原 `bili_search`；不另起一次模型仅为解释按钮。
- `dismiss`：关闭卡，不改变长期偏好，不写“用户不喜欢”的结论。

保存 `{id,sessionId,question,choices,state,createdAt,chosenAt?}`，卡片只属于来源会话。不要默认从公共评论采票；外部建议可以供鱼阅读，不能获得人工选择权或修改持久偏好。

### 4. 看完聊一口

刚读完视频时，鱼可以从一个具体细节接一句感受，或留一个真的没想明白的问题；用户点开就能一起讨论。不是每条都问用户，也不要求固定格式。

优先并入口袋卡的 `note/question`，复用当前会话而非新增工具或长驻模块。依据只包含已读字幕、真实来源和当前互动，不把弹幕当台词、不用还没看的内容剧透。用户认真求助时直接解答，桌宠装饰保持安静。

### 5. 动作回应真实情境

把发现候选、读字幕、用户选择、暂时受阻与自然收尾接到已有桌宠动作，给人可感知的状态变化。采用一个本地行为仲裁器，优先级为明确用户动作、实际任务状态、随机日常；重复事件不重置动画，动作有冷却，安静/专注/减少动效时收敛。

输入建议 `{type,runId?,sessionId?,at,actionId?}`，type 仅为宿主产生的事实事件；输出 `{action,until,priority}`。默认不调用模型、不增加设定开关、不保留用户敏感正文。喂食是虚拟互动，不能改变实际 token 预算；也不能让动作暗示评论已发出、被赞或已看懂尚未读取的视频。

## 优先顺序与验收范围

本轮采用方向是把兴趣线、看后留一问和共同选择合为一个“好奇心手帐”，不分别建立口袋服务与投票服务。上面的工具名及参数属于研究备选，实际实现与接口以本仓库源码、用户文档及验收记录为准；此处不预先宣称实现完成。它应复用原有发现、读字幕和运行入口，保存本地兴趣问题与读后发现；不新增调度器、自动公开发言或真实 B站 收藏。

优先形成“兴趣线→发现视频→留进口袋→用户一起挑→读完接话”的短循环，再接桌宠情境动作。上述 API 可以按最终实现合并，避免每个想法变一个面板或开关。复杂数值心境、跨日作品流水线、公共投票、真实平台收藏均不作为第一步的必要条件。

后续验收应分别核对来源事实、会话隔离、幂等保存、暂停/完成后的翻篇、未知数据不编造、停止与减少动效。公开项目的 README 自述与离线测试不是 DeepMoYu 的真实账号运行证据。

## 本轮实际采用：好奇心手帐

将具体兴趣、读后留问、一起选题与本地回看整合在一个手帐中。没有分别新增兴趣、口袋和投票服务，没有新增主导航、设置开关、定时器或模型请求。情境动作、复杂心境和公开投票仍是研究备选，本轮不声称已新增。

运行页两个启动按钮下面是默认收起的「好奇心手帐」。展开才读取，关闭或离页忽略晚到结果，手动刷新与写入单飞；不新增常驻轮询。用户填一个问题点「留个问题」，只记本地。点「带着它去逛逛」才调用原来的新建会话与启动流程，沿用模型、预算、工作区及权限；失败保留问题，若已创建会话则给出会话ID。

鱼使用模式内工具 `bili_curiosity`，支持 `list/open/note/pause/resume/resolve/forget`。最多三个活跃问题、二十条总记录，每条三点收获；问题最多120字，搜索词80字，读后理解180字。界面只有一个最多80字输入，作为问题和搜索词使用。达到上限时明确提示先放下或删除，不静默淘汰旧内容。

角色 `open` 需要本会话/本趟实际成功读取字幕原文的来源BV；`note` 同样需要当前作用域阅读证据。仅有分段计数、失败回执的残留文本、手动补记已读或另一会话读过都不够。无代理对象的后台也由受控运行作用域携带证据。保存的理解只表明鱼读后写了什么，不是知识真伪的人工核验。

「拾光回看」直接展示这些收获，不另存第二本收藏账。每张卡有稳定标识、来源视频和可选秒数链接；翻卡纯本地，不调用模型。秒数由角色选择供回看，不宣称经过逐句时间锚点核验。链接由后端使用合法BV生成，不能塞任意外部网址。

本轮选题资料会冻结到已启动任务中；暂停、收起或删除手帐条目只影响之后的选题和记录，不改写已启动任务。需要停当前探索，请使用原来的运行控制。旧任务占着同一会话时，换题启动明确拒绝，不偷偷恢复旧题；暂停的题不能通过旧界面卡片重新启动。

状态放在插件运行目录的 `state.json` 的 `curiosity` 字段，与原字段在同一事务锁内合并。相同问题/来源、相同收获的重试幂等，人工管理绑定条目版本；损坏记录明确报错保留，不当空手帐覆盖。角色模式退出或后台能力撤销后旧工具句柄不能读写。普通聊天里的旧线索只是可选资料，不自动开刷、创建任务或发送消息。

## 验证边界

新增纯函数、真实宿主工具/HTTP和浏览器合成验收，覆盖留题、读后理解、来源、回看卡稳定ID、版本冲突、跨实例事务、记录损坏、模式切出与后台桥接，以及真实创建/启动请求、失败保留、冻结目标、关闭/离页晚到结果和无请求翻卡。沿用完整 Python 与原插件回归。没有在真实账号上执行发送、收藏或长时间自主探索，没有推送或发布。

这些功能使鱼能带着一个具体问题接着逛，也让人能一起选方向；它不保证模型每次都会主动留题或理解正确。需要完全退出并重启 DSH，再新开一轮，才能加载新的模块与工具。

最终审查还复现并修复了一个作用域往返问题：字幕请求未返回时切出鱼模式、又切回，旧请求曾能恢复为新的阅读证据。工具调用现在绑定调用开始时的作用域代际；旧请求拒绝，不记全局已读，也不授予新手帐证据。新增真实回归先复现失败，再验证重新读取后仍能正常记收获。

| 验收 | 结果与覆盖 |
| --- | --- |
| `npm test` | 自检和 Node 484/484 通过，无跳过；包含40工具正向执行矩阵、新手帐纯函数/HTTP/角色工具、背景桥与作用域往返回归。 |
| `npm run test:python` | Python 3.12，102/102，无跳过；原媒体、字幕和发送守卫回归通过。 |
| `npm run test:ui` | 新进程完整执行1043/1043，21/21变异被检测；此前旧源码契约已同步公共进度构造器。 |
| `npm run test:browser` | 完整浏览器套件通过；最后中性收起文案与真实冲突码另以手帐桌面/手机各30项、运行中/不支持启动各2项复验。 |
| `npm run test:isolation` | 人格隔离103项、实际宿主目标驱动54项通过，实际账号未发送。 |
| `npm run release:check` / `git diff --check` | 工具证据清单已同步40项，清单/文档链接与源码空白检查通过；没有构建发布包、推送或发布。 |

桌面/手机合成界面截图保存在工作区 `.tmp-qa-out/curiosity-journal/`，不进入插件包。运行数据仍位于原插件运行目录；新增手帐不会改真实 profile、模型凭证、全局权限或当前正在运行的 DSH。
