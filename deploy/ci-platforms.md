# CI 平台对照

本仓库同时托管在 CNB、GitHub、GitLab、Gitee、GitCode。校验逻辑只有一份，
放在 `scripts/ci-common.mjs`。各平台只负责检出代码、准备 Node 和登录镜像仓库。

## 结论

| 平台 | 校验 | 发布镜像 | 镜像地址 | 配置来源 |
| --- | --- | --- | --- | --- |
| CNB | 有 | 有 | `docker.cnb.cool/azurekiln/azurekiln-qfli-server/qfli-server` | `.cnb.yml` + 平台自带登录 |
| GitHub | 有 | 有 | `ghcr.io/azurekiln2333/azurekiln-qfli-server/qfli-server` | `.github/workflows/build-and-push.yml` + `GITHUB_TOKEN` |
| GitLab | 有 | 有 | `registry.gitlab.com/azurekiln-team/azurekiln-qfli-server/qfli-server` | `.gitlab-ci.yml` + 预置变量 |
| Gitee | 无 | 无 | 无 | 免费云构建不覆盖个人仓库 |
| GitCode | 有 | 无 | 无 | `.gitcode/workflows/verify.yml` |

生产服务器跟踪的是 CNB 镜像 `latest`。其余仓库的镜像属于验证与备份通路。

## CNB

`.cnb.yml` 的发布任务读取 `CNB_REPO_SLUG_LOWERCASE`、`CNB_COMMIT`、`CNB_BRANCH`，
镜像名前缀由仓库路径决定，因此镜像地址为 `docker.cnb.cool/<仓库路径>/qfli-server`。
`services: [docker]` 在可信推送与标签流水线里自动登录，配置文件不读任何注册表密钥。

发布任务使用 `cnbcool/default-dev-env:latest` 镜像，该镜像需自带 Node 与 Docker CLI。
`publish` 命令在构建镜像前重跑全部校验，测试失败就不会推送。
建议在 CNB 控制台核对一次发布任务的运行结果，再依赖它出正式镜像。

## GitHub Actions

工作流固定 `actions/checkout` 与 `actions/setup-node` 的提交哈希，权限只有 `contents: read`。
发布任务额外申请 `packages: write`，用 `github.token` 登录 GHCR，不需要自定义 secret。
`verify` 任务先通过，`image` 任务才会运行。

GHCR 包默认继承仓库可见性。公开仓库对应公开包，服务器可匿名拉取。
若包被改成私有，拉取前需要 `docker login ghcr.io`。

## GitLab CI

`.gitlab-ci.yml` 全部使用预置变量：`CI_REGISTRY`、`CI_REGISTRY_PATH`、`CI_REGISTRY_USER`、
`CI_REGISTRY_PASSWORD`、`CI_COMMIT_SHA`、`CI_COMMIT_BRANCH`、`CI_COMMIT_TAG`。
流水线令牌自带本项目容器仓库的写权限，不需要手工创建 CI/CD 变量。

发布任务用 `docker:dind` 服务，TLS 证书目录为 `/certs`。
`docker:28.6.1-cli` 镜像不含 Node，因此在 `before_script` 里执行 `apk add nodejs npm`。
若 Runner 刷新镜像后预装版本低于 24，需要改用 `node:24.15.0-bookworm` 作为 job 镜像并自装 Docker CLI。

自建 GitLab 实例改 `CI_REGISTRY_HOST` 即可复用同一脚本。

## Gitee：不加工作流

依据 Gitee 官方帮助中心的流水线（GiteeGo）文档：

- 《GiteeGo 计费规则和产品定价》写明免费版每月赠送 1000 核分，超出按量计费。免费额度存在。
- 但《初识 Gitee 流水线》把流水线定义为**企业**产品的能力，帮助中心把它挂在“企业版”栏目下。
  GiteeGo 的流水线入口按企业维度开通，个人免费仓库没有提交即触发的托管构建。
- 现有远端是个人账号下的公开仓库 `gitee.com/azurekiln/azurekiln-qfli-server`，不是企业仓库。

因此本仓库不加 `.workflow/`（GiteeGo 目录名）。免费额度是面向企业版的赠送，
个人仓库要拿到托管构建需要先升级为企业账户，这属于账号决策，不写进仓库。
若将来仓库迁移到企业账户，GiteeGo 可用同一份 `scripts/ci-common.mjs verify` 作为构建命令。

## GitCode / AtomGit：只加校验

依据 AtomGit 官方帮助文档（`docs.gitcode.com`）：

- 《产品总览》与《快速开始》确认流水线目录是 `.gitcode/workflows/`，托管 Runner 开放使用。
  默认标签 `[ubuntu-latest, x64, small]` 是 2 核 8 GB。
- 《使用 AtomGit 托管 Runner》列出 6 档规格，未提到计费。文档没有给出免费额度数字。
- 《快速开始》把“申请获取代码化流水线内测名额”列为前提条件，名额有限且需联系 AtomGit 客服。
- 文档与 API 文档只描述 Runner、构件与缓存，没有公开说明托管镜像仓库的推送地址与凭据。

结论：可以提交校验工作流，成本为零；发布镜像缺少官方公开的镜像仓库凭据说明，
需要先申请内测名额并确认镜像仓库，因此这里只保留校验。

`pull_request` 事件下，来自 fork 的流水线读不到项目密钥。本工作流不读密钥，不受影响。

## 服务器侧

生产服务器只拉取 CNB 镜像。换注册表时改 `QFLI_SERVER_IMAGE`，不要改 `docker-compose.yaml` 的默认值：

```sh
QFLI_SERVER_IMAGE=ghcr.io/azurekiln2333/azurekiln-qfli-server/qfli-server:latest
QFLI_SERVER_IMAGE=registry.gitlab.com/azurekiln-team/azurekiln-qfli-server/qfli-server:latest
```

Watchtower 只更新带 `com.centurylinklabs.watchtower.scope=qfli-server` 标签的容器，
换镜像地址后仍需 `docker compose up -d server` 才生效。

## 标签约定

- 分支 `main`：推送 `sha-<12位提交>` 并更新 `latest`。
- 标签 `vX.Y.Z`：推送同名标签并更新 `latest`。
- 标签 `vX.Y.Z-rc.1` 等预发布：只推预发布标签，不动 `latest`。

脚本拒绝 `main` 以外的分支和不符合 semver 的标签，避免提交信息决定镜像名。
