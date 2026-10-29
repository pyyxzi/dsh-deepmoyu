# 部署指南

## 安装前

确认 DSH 已能独立启动、模型可用，并确定要安装的 profile。下面使用 `web`，其他 profile 应替换名称。DSH 桌面版如果没有将 `dsh` 加入 PATH，应使用该安装提供的 CLI 启动方式；不要猜测另一份安装的位置。

该 profile 必须是已配置的 Web/Desktop 组合，提供 `webServer` 和 `agentPresets`。`dsh plugin` 对一个全新名称创建的纯 base profile 不会自动变成 Web 应用；应先按 DSH 官方部署文档创建 Web/Desktop profile，再安装本插件。不要把本插件直接加到只含 base/headless 的 profile。

包的引擎声明是版本范围，不是每个历史宿主都具备全部扩展能力的保证。角色工具要求会话作用域，视频制作要求模型选择及目标续轮/终态能力。工作台会按实际能力报告限制。

工作台面向桌面版或本机浏览器访问。插件会拒绝其他网站、不同本机端口及非回环 Origin 的 API 请求；本轮不将公开网络反向代理访问列为已支持部署方式。不要为绕过限制关闭来源校验，也不要把没有宿主认证保护的 DSH 端口暴露到公网。

## npm 正式版

```sh
npm view dsh-deepmoyu version
dsh plugin --profile web add dsh-deepmoyu
```

需要固定版本时，先确认它确实已发布，再使用 `dsh-deepmoyu@<版本>`。本地源码版本或 GitHub 标签不会自动改变 npm registry。

## 本地发布包

下载维护者发布的 `.tgz` 和 `SHA256SUMS`，核对 SHA-256。PowerShell 可使用：

```powershell
Get-FileHash -Algorithm SHA256 .\dsh-deepmoyu-2.4.1.tgz
dsh plugin --profile web add "C:\Downloads\dsh-deepmoyu-2.4.1.tgz"
```

Linux/macOS 可使用：

```sh
shasum -a 256 dsh-deepmoyu-2.4.1.tgz
dsh plugin --profile web add "/absolute/path/dsh-deepmoyu-2.4.1.tgz"
```

离线只有插件 tarball 仍不一定足够：首次安装需要解析其 npm 依赖，主 Python 工具链还需下载依赖。完全离线部署需预先准备对应平台的依赖缓存；项目不宣称一个 tarball 即覆盖全部离线依赖。

## GitHub 或源码 ZIP

克隆仓库，或解压带有 `package.json` 的源码包，进入该目录：

```sh
npm ci --omit=dev
```

PowerShell 本地链接：

```powershell
$pluginPath = (Get-Location).Path
dsh plugin --profile web add "link:$pluginPath"
```

Linux/macOS 本地链接：

```sh
dsh plugin --profile web add "link:$(pwd)"
```

保持该源码目录存在，不要在链接安装后移动它。DSH 的插件命令管理 bundle 列表，普通部署不需要手工改 profile 的 JSON 或 junction。开发者安装 `npm ci` 可同时获得测试依赖。

## 加载与首次配置

1. 完全退出并重开 DSH，启动相同 profile。
2. 单击桌宠 → 工作台 → 偏好与设置 → 账号与环境。
3. 安装主依赖；插件使用独立 Python 环境，不写入宿主包目录。需要本地转写时另装可选依赖。
4. 扫码登录并执行连接检查。
5. 在运行方式中配置会话/后台各自的模型、时长和预算。
6. 如需发送，单独启用相应权限；需要人工决定时同时开启发送前审核。

普通对话不需要选择此模式，也不会获得角色工具。仅选中鲸鱼摸鱼模式不会自动开始浏览。

## 升级与迁移

先停止任务并备份 `<DSH_HOME>/bili-duty/`。npm 安装用户可安装已发布的新版本并重启。维护本地分叉时，应更新该源码 checkout 并安装锁定依赖，不应通过 registry 重装覆盖本地改动。

从旧包名 `dsh-dafeiyu` 迁移时，先确认旧包与新包指向同一运行目录，停止旧实例并移除旧包的加载项，再安装新包。不要同时加载两份插件。内部 preset、HTTP 路由及状态文件沿用 `dafeiyu/feiyu` 标识，以兼容既有数据。

不要用新建 profile、清空状态或删除判重数据库来处理普通升级错误。数据损坏与文件不存在是不同情况，先备份并检查日志。

## 卸载与回滚

```sh
dsh plugin --profile web remove dsh-deepmoyu
```

重启 DSH 后移除工作台与模式。运行数据保留；手动删除前先确认其中的凭证、记忆和视频是否需要备份。回滚代码时使用已验证的旧版本并保留数据备份；不承诺未来数据结构均可向旧版逆向兼容。

## 故障定位

| 现象 | 检查项 |
| --- | --- |
| 没有桌宠 | 当前 profile 是否包含 bundle、插件是否激活、桌宠是否隐藏 |
| 菜单可见但接口 404 | 当前进程是否完全重启、包目录是否指向预期版本 |
| 角色工具不可用 | `toolScope` 诊断与宿主会话作用域能力 |
| 新会话创建失败 | 来源工作区、来源权限和所选模型是否有效 |
| Python 安装失败 | 安装日志、Python/uv 路径、下载源与完整性校验 |
| 视频失败 | 制作会话终态、独立任务日志、字体、配音和音视频校验 |
| 已开始但显示未计量 | 模型服务是否提供可信 usage；不要将缺失数据改为 0 |

公开提交诊断前去除凭证、二维码、模型密钥、私信和个人路径。数据流见 [隐私说明](PRIVACY.md)。
