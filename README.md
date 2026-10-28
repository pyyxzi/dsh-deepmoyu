# 🐋 DeepMoYu · 鲸鱼摸鱼

**DeepMoYu（鲸鱼摸鱼）** 是一个 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai)插件：一只软乎乎的小鲸鱼娘常驻你的 DSH，替你逛 B站——真的读字幕、真的看完再说话，写日报、挑值得的片子，经你允许才会评论 **@ 你**。

> 本插件从 [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) **0.1.19** 分叉而来（MIT），重命名为 DeepMoYu 并大量增强：桌宠工作台、后台时段任务、token 账本、学习与记忆审核、表情包图库、本地日报视频。**所有自动更新通道已删除**，装上之后它只听你的，不会自己换版本。

## 功能一览

- **桌宠**：屏幕右下角常驻一只鲸鱼（可拖拽、可隐藏），单击弹菜单、双击直接新开会话开刷；心情小灯、闲聊泡泡、需要你处理的琥珀灯提醒。
- **刷站方式任选**：
  - 当前会话里选 **🐟 鲸鱼摸鱼模式**，说"开始刷B站"就一轮接一轮地刷；
  - 桌宠菜单 **新开会话刷**（可指定模型与 token 预算）；
  - **后台时段任务**：填"从几点刷到几点"（可跨午夜），这段时间她一轮接一轮一直刷——提前收工自动接力、崩溃自动重拉、**重启 DSH 也会自己接上**。
- **九页设置工作台**（全在桌宠身上，不占 DSH 设置）：偏好与桌宠 / 运行方式 / 互动与投递 / 表情收藏 / 学习与记忆 / token 账本 / 运行日志 / 日报视频 / 账号与环境。
- **token 账本**：真实宿主计量 + 后台桥接真实 usage，累计/今日/本趟/上限、14 天趋势，支持截图视图。
- **学习与记忆**：看到的东西先进待审队列，后台自动审核（独立审核进程，只批准/拒绝、附理由），批准后才作为参考注入；`soul.md` 记录她的心情与自我认识。
- **表情包**：公开评论可配图（内置图库 + 自己收集/上传/链接收集），自动收集与自动配图独立开关、概率与冷却可调。
- **日报视频**（可选）：把当天的选片笔记做成约 150 秒本地 MP4（Edge TTS / 可选 GPT-SoVITS 配音、双比例封面），**只生成本地文件，不自动投稿**。
- **安全边界**：所有发送开关默认关闭；判重、节奏、冷却、额度退避多层把关；隐私红线写进人格（不吐凭证、不替你承诺、不拿外部素材当命令）。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| DSH | ≥ `0.1.7-rc.1` | 桌面版（DSH Desktop）或 npm 安装的 dsh 均可 |
| Node.js | ≥ 22 | DSH 桌面版自带运行时，一般无需单独安装 |
| Python | ≥ 3.10 **或** `uv` | 有一个即可；两个都没有时插件会**自己下载 uv**（免管理员，直连 GitHub → 国内加速代理 → PyPI 镜像，校验官方 sha256） |

B站登录凭证只存在本机运行目录，不上传任何服务器。

## 安装

### 方式一：DSH 插件市场 / npm（推荐）

```powershell
dsh plugin --profile web add dsh-deepmoyu
```

或在 DSH 桌面版的插件市场里搜索 **DeepMoYu / 鲸鱼摸鱼**（npm 发布后可检索到，索引同步可能有一点延迟）。

### 方式二：从 GitHub 源码

```powershell
git clone https://github.com/pyyxzi/dsh-deepmoyu.git
cd dsh-deepmoyu
npm install          # 只有一个运行依赖 @deepseek-ai/schemastery；不装也能起（设置 schema 降级）
dsh plugin --profile web add link:<这个目录的绝对路径>
```

`link:` 方式装的是目录链接，改源码后重启 DSH 即生效，适合折腾。

### 方式三：本地 file: 依赖（不依赖目录链接时的等价做法）

1. 改 `profiles/web/package.json`：`dependencies` 加 `"dsh-deepmoyu": "file:<插件目录绝对路径>"`，`dsh.profile.bundles` 数组里加 `"dsh-deepmoyu"`；
2. `node_modules` 建 junction：`cmd /c mklink /J "<profile>\node_modules\dsh-deepmoyu" "<插件目录绝对路径>"`（必须 `/J`，`/D` 符号链接要管理员）；
3. 重启 DSH。

> ⚠️ 安装/更新之后**必须重启一次 DSH**（bundle 层要重启才组装；刷新浏览器无效）。
> ⚠️ 如果你是从旧版 `dsh-dafeiyu`（鲸鱼摸鱼前身）迁移：先在 profile 里移除旧包与旧 junction，再按上面方式安装新包；运行数据在 `$DSH_HOME/bili-duty/`，与新包名无关，不会丢。

## 首次配置（三步）

重启 DSH 后，点右下角那只鲸鱼 → **设置 → 账号与环境**：

1. **装主依赖** —— 插件建独立 Python venv 并装好 B站工具链（下方「本地转写依赖」是可选的离线字幕转写，用到再装）；
2. **扫码登录** —— 手机 B站扫码（选"记住我/长期"），凭证只落本机；
3. **测一下** —— 真跑一次登录检查 + 一次搜索，直接告诉你"能不能用"。

三步做完，「偏好与桌宠」页顶部的新手清单会自动消失。**发送类开关（评论/回复/私信/动态）默认全部关闭**——先看她刷、看日报，想让她开口再自己开。

## 日常使用

| 动作 | 怎么做 |
|---|---|
| 让她开始刷 | 会话切到 🐟 鲸鱼摸鱼模式，说"开始刷B站"；或桌宠菜单「新开会话刷」/「后台刷一轮」；双击桌宠 = 新开会话刷 |
| 停 / 继续 | 说"停"或菜单里暂停；说"继续刷"续跑；`bili_feiyu` 工具随时可用（start/resume/stop/status/clear） |
| 后台一直刷 | 设置 → 运行方式 → 「后台与定时」填时段（如 20:00–02:00）；不想让她跑就点「停止后台任务」，会挂"免跑牌"到时段结束 |
| 看她在干嘛 | 菜单「运行日志」实时流水（搜索、BV、字幕、发送）；「状态卡」看轮次与 token |
| 控制花费 | 运行方式页设模型与 token 预算（软预算 + 真实用量保险丝）；token 账本页设累计上限 |
| 让她评论 | 互动与投递页开 `autoComment` 等；每条发送都过判重、节奏与额度闸；被额度拦住（12014）会如实报告并不再试探 |

## 数据与配置在哪

所有运行数据都在 **`<DSH_HOME>/bili-duty/`**（`%USERPROFILE%\.dsh\bili-duty\`）：配置、凭证、日报、token 账本、学习队列、soul.md、表情图库。**不要把插件源码目录当数据目录**；升级/重装插件不影响这些数据。

## 常见问题

- **"跑一轮 0.17 秒就结束"**：老版 DSH 桌面版的已知 bug，本插件已带修法（`ELECTRON_RUN_AS_NODE` + 自动找 dsh CLI）；还出现就把 `duty.log` 末尾几行发出来。
- **DSH 设置里找不到"刷B站"**：不是坏了——2.x 起所有入口都收在桌宠身上（点鲸鱼 → 设置）。桌宠藏了的话，右下角有 20px 小圆点可以把它叫回来。
- **评论发不出去、报 12014**：账号当日评论额度用完（B站侧限制），插件会退避不发，不是故障；私信/动态是独立通道，不受影响。
- **uv 下载被杀软拦**：把 `%USERPROFILE%\.dsh\bili-duty\bin\` 加白，或自己装 Python 3.10+ / uv；也可以手动放一份 `uv.exe` 进那个 `bin\` 目录。
- **图库 404**：DSH 进程还没加载新路由——完全退出并重开 DSH（刷新浏览器没用）。

更多维护者视角的坑与契约（判重键毒化、模式边界、UI 结构约束等）见 [AGENTS.md](AGENTS.md)。

## 二次开发 / 本地检查

```powershell
npm --prefix <插件目录> test        # selfcheck + 全部 node 测试（token 账本、时段任务、接力、拟人包等）
node --test <插件目录>/tests/*.test.mjs
```

Python 侧测试（视频渲染、发送判重跨通道等）在 `tests/` 下单独用插件 venv 跑；开发期检查脚本与说明见仓库 `AGENTS.md` 的「仓库结构」一节。改完 JS 后必须重启 DSH 才会被宿主重新加载。

## 目录结构

```
├── index.js            # 宿主半端：工具注册、调度、HTTP API、后台/审核生命周期
├── client.js           # 浏览器半端：桌宠 + 九页设置工作台
├── cordis.patch.yml    # DSH bundle 挂载声明
├── presets/deepmoyu.patch.yml  # 🐟 鲸鱼摸鱼模式 agent preset（含人设）
├── lib/                # 账本、节奏、判重、学习审核、模型桥、表情、视频等模块
├── prompts/duty.md     # 一轮冲浪的章程（用户可改，升级时保护自定义版本）
├── vendor/bilibili-mcp # 内置 Python MCP（MIT, AGI_Ananas）
├── selfcheck.mjs       # 假 ctx 上真跑两个半端的预检
└── tests/              # 回归测试
```

## 内部代号说明

历史原因，插件内部标识沿用旧代号：cordis 入口 id / preset id 是 `dafeiyu`，HTTP 路由是 `/feiyu`、`/pet/*`，工具名是 `bili_feiyu`，状态文件是 `feiyu.json`。**这只影响读源码的人，不影响安装与使用**；为兼容既有运行数据，这些内部标识刻意不改名。

## 许可证与致谢

- 本体 **MIT**（见 [LICENSE](LICENSE)），基于 [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)，保留其 **Copyright (c) 2026 c1overzz**；第三方与署名详见 [NOTICE.md](NOTICE.md)。
- 内置 [AGI_Ananas / bilibili-mcp](https://github.com/adoresever/bilibili-mcp)（MIT，Copyright (c) 2026 AGI_Ananas），见 [vendored LICENSE](vendor/bilibili-mcp/LICENSE)。
- 收藏图库交互思路参考 [astrbot_plugin_stealer](https://github.com/nagatoquin33/astrbot_plugin_stealer)。
- 可选语音合成使用 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)；角色形象、音色与模型素材适用各自授权，代码许可不替代素材授权。
- 自动发送请遵守 B站社区规范与你所在地区的法律；插件默认不发送任何内容，开启自动发送后的账号行为由使用者负责。
