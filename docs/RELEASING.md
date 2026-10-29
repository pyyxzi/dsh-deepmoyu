# 发布指南

源码、npm 包、GitHub Release 和插件市场条目是四个独立产物。本项目的构建命令不自动推送、发布 npm、创建 Release 或提交市场 PR。

## 1. 准备源码

Git clone 已包含仓库元数据；从完整源码 ZIP 解压后，部署与一般测试可以直接运行，重新执行发布检查/打包前应在该源码根执行 `git init`，建立受控文件清单即可，不要求提交或设置远程仓库。归档故意不分发维护者的 `.git` 和认证信息。

- 更新 `package.json`、锁文件和 `CHANGELOG.md`，确认版本尚未被占用。
- 确认素材公开分发权限已记录在 [ASSETS.md](ASSETS.md) 与 `assets-permissions.json`。
- 核对 README、部署指南、隐私、安全报告入口和可复跑测试命令。
- 源码树不得包含运行数据、Cookie、模型密钥、`.npmrc` 或本机虚拟环境。

```sh
npm ci
npm view dsh-deepmoyu version
```

## 2. 执行验收

```sh
npm test
npm run test:python
npm run test:mcp
npm run test:ui
npm run test:browser
npm run test:isolation
npm run release:check
npm audit --registry=https://registry.npmjs.org
```

Python 与浏览器依赖按 [贡献指南](../CONTRIBUTING.md) 配置。真实宿主门禁在提供本机 DSH 时执行；无宿主时的明确跳过不等于通过真实宿主验收。CI 只运行被明确隔离的测试，不读取账号，不发送平台消息。

更新 [RELEASE_AUDIT.md](RELEASE_AUDIT.md)，区分真实媒体、真实宿主实现、合成浏览器和 mock 外部服务。未通过的检查和无法验证的环境必须保留说明。

## 3. 构建并测试实际归档

```sh
npm run release:build
npm run release:smoke
```

产物位于忽略提交的 `release/`：

- `dsh-deepmoyu-<版本>.tgz`：npm/DSH 安装包，只包含运行文件、素材和用户文档。
- `dsh-deepmoyu-<版本>-source.zip`：可上传或解压开发的完整源码，包括锁文件、测试、CI 和发布资料。
- `SHA256SUMS`：两个归档的 SHA-256。
- `archive-verification.json`：文件数、归档哈希以及 npm 文件清单。

构建从当前工作树获取已跟踪与未忽略的新文件，保留尚未提交的实现，不从旧 Git 提交生成过期 ZIP。源码 ZIP 逐文件回读并与当前源码比较；npm 包的 `package.json` 仅保留运行期 `check` 命令并移除开发依赖声明，其他文件逐字节核对。检查路径越界、符号链接、私有数据、常见凭证内容模式与缓存。清洁安装测试使用临时目录安装实际 tarball，并执行包内自检。

npm 运行包提供 `npm run check`；`npm test`、界面验收和发布命令仅在完整源码 checkout/ZIP 中提供。清洁验收还会解压源码 ZIP，在独立目录初始化 Git、执行 `npm ci`、发布清单检查及完整 Node 测试，证明不依赖维护者的上级工作区。可用 `RELEASE_TMPDIR` 或 `QA_OUTPUT_DIR` 指定临时目录。归档带有生成时间信息，不宣称两次构建的压缩字节完全一致；每次产物按其校验和验证。

构建与审核之间如有任何源码修改，重新构建并执行清洁安装。不要上传历史工作区的旧 ZIP。

## 4. GitHub 与 npm

将经过审阅的源码提交到 `pyyxzi/dsh-deepmoyu`，确认 CI 结果后再创建对应版本标签和 Release。可以附加上一步的两个归档、校验和与审查记录。不要把 `release/` 归档作为源码提交进去。

npm 发布需要该包的发布权限和 registry 要求的认证。确认账号、版本、归档和发布目标后，再执行：

```sh
npm whoami --registry=https://registry.npmjs.org
npm publish ./release/dsh-deepmoyu-<版本>.tgz --registry=https://registry.npmjs.org --access public
```

发布完成后查询指定版本的 `dist.integrity`、`dist.shasum` 和仓库信息，下载 registry tarball 并核对内容；本地构建通过不能替代发布后检查。npm 版本不可覆盖，不应为发布失败临时篡改归档内容。

## 5. 插件市场

按 2026-10-29 核对的官方贡献规则，将本仓库的
`marketplace/pyyxzi__dsh-deepmoyu.yml` 复制到目录仓库的
`data/plugins/pyyxzi__dsh-deepmoyu.yml`，提交只涉及该条目的 PR。

需核对：

- 目标仓库公开可访问、创建至少满一天、仍在维护，并有 `dsh-plugin` topic。
- `package.json` 具有 `dsh.bundle`，声明的 patch 存在且能加载。
- 条目 URL、名称和代码仓库一致，功能描述客观准确，分类符合实际用途。
- 图标是 GitHub 托管的位图；根 `screenshots.json` 指向仓库内 1–8 张真实界面截图。
- 若条目已存在，更新该条目，不创建重复项。不要手改目录仓库自动生成的 README，也不要添加不支持的 `npm:` 字段。

npm 发布不是收录前提，也不会自动创建条目。目录 CI 与维护者审核是外部流程；本地打包不能证明已收录。

规则来源：

- DSH 插件打包文档：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- 市场贡献指南：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

提交前重新读取外部指南，以其当时规则为准。

### 本轮查询的外部状态

2026-10-29（北京时间）查询显示，本仓库公开、未归档、默认分支为 `main`，已有 `dsh-plugin` topic；目录中尚无本仓库条目。GitHub 返回的创建时间为 **2026-10-28 05:18:16 UTC**，因此满足“创建满一天”的最早时间为 **2026-10-29 13:18:16（北京时间）**。在此之前可准备并上传源码及发布包，市场目录的年龄门禁仍会拒绝提审。该状态是查询时快照，不是已收录声明。
