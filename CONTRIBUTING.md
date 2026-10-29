# 开发与贡献

## 环境

- Node.js 22+、npm、Git。
- Python 3.11–3.13。可用 `PYTHON` 指定执行文件；建议独立虚拟环境。
- Chrome 或 Chromium，用于真实 React/浏览器验收；可用 `CHROME_PATH` 指定路径。

```sh
npm ci
python -m venv .venv-test
```

激活该虚拟环境后安装 `vendor/bilibili-mcp/requirements.txt`。依赖安装需要网络；媒体测试不会使用真实 B站账号。GPT-SoVITS 及其模型不在测试基础依赖中。

`requirements.in` 固定已验证的直接依赖，`requirements.txt` 记录 universal 哈希锁。更新依赖时使用其文件头记录的 uv 命令重新生成，并重新执行依赖审计与媒体测试；不要为保留旧 Python 环境降级到已知存在漏洞的 Pillow。

## 测试命令

| 命令 | 范围 |
| --- | --- |
| `npm test` | host/client 自检与全部 Node 单元/集成回归 |
| `npm run test:python` | Python 发送守卫、图片发送及视频测试 |
| `npm run test:mcp` | 真实 Python/FastMCP 握手与本地 SQLite 守卫调用；不读取凭证、不访问平台 |
| `npm run test:ui` | 完整工作台场景、交互断言、变异测试及源码契约 |
| `npm run test:browser` | 真实 React 的全部页面、菜单几何、记忆操作与请求竞态 |
| `npm run test:isolation` | 人格与真实宿主目标驱动隔离；按实际宿主能力执行 |
| `npm run release:check` | bundle、锁文件、市场资料、截图、授权记录与 npm 文件清单 |
| `npm run release:build` | 构建并回读校验 npm tarball 和源码 ZIP |
| `npm run release:smoke` | 临时目录中清洁安装实际 tarball 并运行自检 |

Windows 示例：`$env:PYTHON = 'C:\path\python.exe'`；Linux/macOS：`export PYTHON=/path/to/python`。浏览器产物目录可通过 `QA_OUTPUT_DIR` 指定，默认使用系统临时目录。

真实宿主 headless 门禁可用 `node scripts/qa/headless-relay.mjs` 执行，只访问回环模拟服务；会临时解包宿主依赖，空间不足时设置 `DSH_QA_TMPDIR`。不会重装本机插件或修改实际 profile。

不带宿主的 CI 不可假称真实宿主测试通过；提供 `DSH_HOST_ASAR` 时必须指向真实可读取的桌面宿主。显式配置的路径错误应失败。外部 API 使用 fakes 时，报告应明确说明。

## 修改约束

- 配置、凭证、状态与媒体产物写入运行目录，不写源码目录。
- 角色工具只注册到已选中角色的会话作用域；不要增加全局 fallback。
- 普通会话不获得角色提示词或记忆；停止和清理只操作本插件拥有的任务。
- 发送授权、审核、判重、节奏和冷却是不同门禁，不能互相代替。
- 保留源项目及第三方署名；素材与音色的公开分发权限另行确认。
- 修改 JS 后需完全重启 DSH。本机链接开发安装不应通过 registry 重装覆盖。

详细行为约定见 [AGENTS.md](AGENTS.md)。提交 PR 时说明行为变化、修复前的复现、验证命令和实际限制；不要只报告测试总数。

## 发布

发布需要额外的清单、归档和部署验收，见 [发布指南](docs/RELEASING.md)。CI 不自动向 npm 发布，也不修改 DSH profile 或市场仓库。
