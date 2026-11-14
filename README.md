# azurekiln-qfli-server

QFLIStudio+ 社区、云项目、在线终端后端。Node.js >= 22.9，默认 MySQL，可显式选择 SQLite。

## 身份和业务数据

`users` 只有两列：

```sql
id               -- user_ + 32 位随机十六进制字符，业务表和用户文件目录使用它
gateway_user_id  -- 网关 userinfo 的 sub，唯一、区分大小写
```

用户名、密码、邮箱、手机号、昵称、头像、简介、角色、华为 OpenID / UnionID 都由网关保存。

所有业务主键和关联 ID 都使用字符串：`user_`（用户）、`proj_`（云项目）、`post_`（帖子）、`comment_`（评论）、`zone_`（专区）、`audit_`（审计），后缀均为 32 位随机十六进制字符。用户在 MySQL 使用 `VARCHAR(37)`，其余业务实体使用 `VARCHAR(48)`，不使用自增 ID。计数、积分和时间戳仍是数值。
QFLI 不保存密码，不把华为 OpenID 当成 gateway_user_id。

- `user_state`：本站积分、签到状态、本站创建时间。
- 用户资料、任务和签到接口返回 `growth`（总经验、等级、本级经验、升级所需经验）。经验累计签到和已完成每日任务奖励，每 100 经验升一级；兑换只扣可用积分，不扣经验。历史签到记录仍计入经验。
- `auth_sessions`：本站会话，以及 AES-256-GCM 加密的网关 access/refresh token。密钥由 `QFLI_JWT_SECRET` 派生；更换密钥会让现有会话失效。
- 作者公开资料仅做 60 秒内存缓存，最多 1000 人，重启后从网关重新读取。网关暂不可用时展示缓存或本地用户编号。
- 每次受保护请求都向网关检查用户信息和角色。网关撤销令牌、停用客户端或封禁账号后，本站会拒绝继续使用对应会话。
- 使用单个 Node 进程。待完成授权和 MFA 在内存中，refresh token 轮换锁也是进程内的；多实例部署前需要共享授权状态和跨实例会话锁。

## 实际登录链路

```text
App 账号密码表单 -> QFLI POST /api/auth/login
  -> 网关 POST /oauth2/authorize（JSON 表单 + PKCE challenge）
  -> 返回 redirect 中的网关授权码
  -> QFLI POST /oauth2/token（client_id + client_secret + verifier）
  -> GET /oauth2/userinfo -> 本地 ID 映射 -> 本站 token + user -> App

App 华为原生一键登录 -> 华为 authorizationCode
  -> QFLI POST /api/auth/huawei
  -> 网关 POST /api/v1/auth/oauth/huawei/quick-login（code + PKCE challenge）
  -> 网关授权码 -> 与账号密码登录相同的换令牌和用户映射过程
```

账号密码、华为登录都在后端使用 PKCE S256。verifier 不下发 App，客户端密钥仅保存在 QFLI 后端。
原生表单无需打开浏览器。保留 `/oauth2/url`、`/oauth2/callback`、`/oauth2/complete` 作为可选浏览器授权入口。
回调地址参与原生表单的授权码签发和兑换，即使没有浏览器跳转也必须在网关登记。

账号密码登录先调用 `/api/auth/login/requirements`，网关验证密码后返回二步验证与图形验证要求。App 先弹二步验证，再弹需要的图形验证码，最后提交 `/api/auth/login`；网关仍校验所有必需的验证码。预检查不会建立登录会话，需要同时更新 OAuth2 网关的 `check_verification` 分支。邮箱二步验证码在预检查时发送。
华为二次验证返回本站 `challengeId`，App 提交 `/huawei/complete`，网关验证成功后再完成授权码兑换。

### 登录错误日志

后端标准输出使用 JSON 日志。每次请求生成 `requestId`，同时通过 `X-Request-Id` 和错误响应返回；App 的服务器错误提示会显示该编号。
按编号查找 `auth.request`、`gateway.response`、`gateway.connection_failed`、`request.failed` 和 `auth.response`，可看到失败阶段、上游接口路径、状态码、耗时、错误代号或网络错误代号。阶段包括 `gateway.huawei_authorize`、`gateway.token_exchange`、`gateway.userinfo`、`gateway.huawei_mfa` 与 `qfli.create_session`。
日志不记录密码、授权码、验证码、Token、Cookie、客户端密钥、PKCE verifier、请求体或 URL 查询参数。HTTP 503 配置错误会保留原状态，不再全部显示成 502。日志写到部署环境的 stdout/stderr，无需新增环境变量或数据库字段。

## 注册和邮箱验证

1. App 提交邮箱到 QFLI `/api/auth/email-code`。
2. QFLI 调用网关 `/api/email-verification/send`，`purpose=register`，实际由网关 SMTP 发送验证码。
3. App 提交用户名、邮箱、6 位验证码、密码、昵称到 QFLI `/api/auth/register`。
4. QFLI 转交网关 `/oauth2/register`，映射 `emailCode -> email_code`、`nickname -> name`。
5. 网关校验邮箱验证码后建立统一账号。App 返回账号密码登录页；本站身份在首次成功登录时创建。

网关启用注册图形验证码时，App 会显示图形验证码。密码策略以网关校验为准。
SMTP 未配置或实际发送失败时显示错误，不宣称已经发送验证邮件。

## 网关管理面板需要操作

在你的 `azurekiln-oauth2` 中创建或更新一个 QFLI 客户端：

| 项目 | 值 |
| --- | --- |
| ID | 例如 `qflistudio` |
| 状态 | 启用 |
| 客户端密钥 | 随机值，32-256 字节，仅填写到 QFLI 后端 |
| 回调地址 | `https://qfli.suanxiwanjie.cn/api/auth/oauth2/callback` |
| 要求 PKCE | 开启 |
| scopes | `openid, profile, email, phone, roles, offline_access, qfli_public_profile`（用逗号或换行分隔） |

`qfli_public_profile` 只作为该可信服务端客户端读取社区作者公开资料的许可，不加入用户登录请求的 scope。
`offline_access` 用于下发 refresh token；缺少它时 access token 过期后需要重新登录。
`roles` 下发管理员角色；`phone` 下发手机号；华为信息是否返回仍取决于华为应用权限和网关提供方配置。

另外在网关中：

- 配置 SMTP，并用管理面板发一封测试邮件。
- 开启注册；图形验证码和二次验证可按原有安全设置保留。
- 启用 Huawei 快速登录提供方，配置 App 对应的华为客户端信息、服务端凭据、OpenID / UnionID / 手机号权限。QFLI 的 `AZK_PROVIDER=qfli` 会发送 `provider=qfli_huawei`，网关中对应华为配置的标识需要与它一致。
- 不需要启用 password grant。现有 `/oauth2/authorize` JSON 表单接口已经支持签发授权码。

### 网关资料扩展

本目录 `gateway-extension/qfli-integration.js` 是给现有网关的两个补充接口，配套 `install.patch`：

- `PUT /oauth2/profile`：网关 access token + `openid profile`，只能修改当前用户昵称和简介。
- `GET /oauth2/public-profile/:id`：服务端 client authentication + `qfli_public_profile`，只返回作者公开资料，排除邮箱、手机号、角色。
- `userinfo` 的 `profile` 声明增加 `description`，让简介随网关资料读取。

这些扩展应与网关源码一起部署，然后重启网关。账号密码、华为登录、邮箱验证码、PKCE 兑换使用网关已有接口。

## QFLI 后端配置

在本目录 `.env` 填写（全部变量见 `.env.example`）：

```ini
PORT=3000
NODE_ENV=production
QFLI_JWT_SECRET=填写至少32位随机密钥
DB_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=填写数据库用户名
MYSQL_PASSWORD=填写数据库密码
MYSQL_DATABASE=填写已有数据库名
MYSQL_POOL_SIZE=10
PUBLIC_BASE_URL=https://qfli.suanxiwanjie.cn
AZK_OAUTH2_BASE_URL=https://你的实际网关域名
AZK_OAUTH2_CLIENT_ID=qflistudio
AZK_OAUTH2_CLIENT_SECRET=网关中配置的客户端密钥
AZK_OAUTH2_REDIRECT_URI=https://qfli.suanxiwanjie.cn/api/auth/oauth2/callback
AZK_OAUTH2_SCOPE=openid profile email phone roles offline_access
AZK_PROVIDER=qfli
QFLI_TERMINAL_URL=http://127.0.0.1:3101
QFLI_TERMINAL_SECRET=独立终端内部密钥，与执行服务相同
MODERATION_BASE_URL=https://审核服务地址
MODERATION_APP_ID=qflistudio
MODERATION_API_KEY=审核服务发给本应用的 API key
MODERATION_ADMIN_KEY=审核服务发给本应用的管理密钥
MODERATION_TIMEOUT_MS=3000
PUBLISH_RATE_PER_MINUTE=3
PUBLISH_RATE_PER_DAY=20
COMMENT_RATE_PER_MINUTE=10
COMMENT_RATE_PER_DAY=100
```

`MODERATION_*` 未配置时，发帖、评论、昵称/简介修改等发布类请求一律返回 503 `moderation.unavailable`，
浏览类接口不受影响。这是有意的 failClosed 行为：审核服务不可用时不允许发布。
部署时若审核服务与应用同机，可指向本机回环地址；跨机必须使用证书有效的 HTTPS。

MySQL 数据库需提前创建；表结构由后端启动时自动创建或迁移。数据库账号需拥有该库的读写、建表、修改表和索引权限。MySQL 连接失败会停止启动，不会自动切换到 SQLite。

网关接口路径统一在代码中维护，只配置 `AZK_OAUTH2_BASE_URL`，所有接口均由它和固定路径拼接。
`AZK_PROVIDER` 是当前软件的公共前缀：`qfli` 在华为登录时拼为 `qfli_huawei`。留空时省略 `provider` 参数，由网关选择唯一可用的华为配置。
未来接入微信、QQ 时可沿用 `qfli_wechat`、`qfli_qq` 的标识规则，仍需实现对应登录入口与授权处理。
生产使用 HTTPS；仅 `localhost`、`127.0.0.1` 等本机地址允许 HTTP 开发连接。
本机开发网关地址可填 `http://localhost:3146`；同时改为 `NODE_ENV=development`，回调地址与网关登记的本地地址必须一致。
服务端转发网关表单时使用网关的 Origin，符合现有同源请求校验；不转发 App 提交的 Origin / Cookie。

```bash
npm install
npm start
```

不在 App 放 client secret、Huawei 服务端密钥或网关 refresh token。App 只保存 QFLI token。

## 历史数据库迁移

首次启动会自动迁移，**上线前先停止旧后端并备份数据库和 data 目录**：

- SQLite 在迁移前通过 `VACUUM INTO` 写入 `data/qfli.before-gateway-id.<时间>.db`，身份迁移在事务中执行并检查外键。
- MySQL 保留历史资料归档表；DDL 无法整体回滚，迁移支持在中断后继续执行，上线前应自行备份 MySQL。
- 旧 `provider='azk'` 的 `provider_id` 迁移为 `gateway_user_id`，绑定关系保持不变。
- 整数用户 ID 自动改成 `user_` 加 32 位随机十六进制字符，MySQL 使用 `VARCHAR(37)`；旧 ID 和新 ID 的映射保存在 `qfli_user_id_migration(old_id,new_id)`。
- 旧本地账号迁移到字符串 ID，`gateway_user_id=NULL`；不按用户名自动认领。
- 积分、签到和创建时间搬到 `user_state`。历史资料存入 `legacy_user_profiles`，只供管理员核对，在线接口不把它当资料来源；密码哈希不进入该归档表。
- 帖子、评论、点赞、签到、积分、云项目和审计的用户关联同步更新；`data/cloud/u<id>` 与 `data/terminals/u<id>` 目录同步改名，内容保留。
- SQLite 用户 ID 迁移前另存 `data/qfli.before-string-id.<时间>.db`；MySQL 保存用户 ID 归档及迁移进度，支持启动中断后继续。
- 整数用户 ID 的旧 token 和会话失效，用户需要重新登录；网关 ID 不变。
- 其余整数业务 ID 自动迁移，旧/新对应关系保存在 `qfli_entity_id_migration(entity_type,old_id,new_id)`；同步转换专区、帖子、评论、回复、标签、点赞、审计和云项目的主键/外键。MySQL 保存实体归档和 DDL 进度；SQLite 另存 `qfli.before-entity-ids.<时间>.db`。
- 服务器云项目目录 `p<旧数字ID>` 同步改为 `p<proj_ID>`；云项目列表提供 `legacyId`，App 刷新后更新本地关联并保留原缓存目录和未同步文件。

管理员确认历史账号归属、并在此网关用户首次登录 QFLI **之前**运行：

```bash
npm run link-user -- user_0123456789abcdef0123456789abcdef 网关sub
```

从 `qfli_user_id_migration` 查询历史账号的新 ID，再执行绑定。脚本会从网关核对用户身份；拒绝覆盖已有绑定。已有两个本地 ID 的情况需先人工迁移业务数据。
SQLite 切换到 MySQL 不会自动复制数据。

## 在线终端隔离部署

终端已拆成独立执行服务 [azurekiln-qfli-terminal](../azurekiln-qfli-terminal/README.md)。业务 Node 只转发已认证请求，不执行用户 Shell，不接触 Docker socket。执行服务使用专用账号、rootless Docker、gVisor 和实际生效的 cgroup v2 限额；缺少配置或隔离能力时返回 503，禁止回退到宿主执行。

每台 2C2G 终端节点提供一个会话和一个执行槽。
每个用户保留一份临时工作区。
创建沙箱和清理进程也占用执行槽。
FIFO 队列最多等待 8 条请求。
等待期限为 20 秒。
每个用户最多保留一条执行或等待请求。
每条命令的期限为 60 秒。
输出上限为 100 KiB。
工作区上限为 256 MiB。
空闲 2 分钟或总计 30 分钟后回收会话。
空闲会话仍占用节点容量。
节点池没有空闲容量时返回 429。
增加终端节点可以增加总并发。
专用执行账号最多使用 1 核和 1 GiB 内存。
该账号的任务数上限为 1024。
管理员还须监控 OS、业务及数据库资源。

`POST /api/terminal/exec/stream` 返回 NDJSON，实时显示排队位置、初始化、上传、运行、清理及 stdout/stderr；原 JSON `/exec` 保留。两者接受 `{command,files?}`，快照最多 64 个规范相对路径文件，每个为 `{path,content:base64}`，解码后总量 256 KiB，HTTP body 384 KiB。快照仅通过受信工具写进临时沙箱新目录。业务层验证流、限制总量与单行大小、传递取消并处理接收反压；代理必须关闭缓存和缓冲，参见部署示例。

每条命令结束后清理后台进程，只保留会话文件；重置、异常、超时、断开和服务重启清除整个会话。编辑器隐藏底部终端保留执行，显式关闭或退出编辑器会取消请求并尝试释放本人会话；闲置会话仍按期限回收。

云项目仍在业务 `data/cloud` 独立保存，绝不挂载进沙箱。单用户最多 50 项目、256 MiB、5000 文件，单文件 1 MiB；拒绝符号链接、硬链接和特殊节点，拒绝读取 Git 内部路径，磁盘保留至少 1 GiB 或 10% 的空闲空间。云存储应使用独立有容量上限的磁盘/卷，避免耗尽数据库磁盘。限额适用于新增写入；历史异常数据需要管理员核对。

原云端 Git 接口返回 503。
独立安全执行方案接入后再恢复该接口。
普通云文件和同步接口继续保留。
`GET /api/terminal/pwd` 返回终端元数据。
`DELETE /api/terminal/session` 重置本人会话。
重置操作保留云项目。
终端节点池新增 `terminal_slots` 和 `terminal_coord` 表。
业务实例通过共享数据库协调槽位归属。

公开运营优先部署在独立执行 VM。按执行服务 README 完成旧实例处理、凭据轮换和 Linux 验收后再开放公网入口；本地 Windows 环境无法证明 gVisor 运行与限额生效。已有“迁移目标已存在”错误仍需核对源目录、目标目录和迁移记录，不要删除真实数据。

## 云 MySQL 练习库

云端 SQL 练习使用**另一个 mysqld**，与业务 MySQL 完全分开：独立容器、数据目录、磁盘和 socket，只在本机 Unix socket 上服务，不监听 TCP。业务 Node 每次使用前检查它的 `server_uuid` 与业务库不同、`skip_networking=ON`、`local_infile=OFF`、`secure_file_priv=NULL`、事件调度关闭，任一不符即返回 503，不回退到业务库。

以 root 部署（需要宝塔/系统里已有 Docker Engine；终端 bootstrap 已安装 docker-ce）：

```sh
install -m 0700 /www/wwwroot/azurekiln-qfli-server/deployment/sqlbox/bootstrap.sh /root/qfli-sqlbox-bootstrap.sh
bash /root/qfli-sqlbox-bootstrap.sh --business-env /www/wwwroot/azurekiln-qfli-server/.env
# 然后重启业务 Node，使其读取新增的 QFLI_SQLBOX_* 配置
```

- 镜像为官方 `mysql:8.4`，Docker Hub 不通时自动改用 `mirror.gcr.io/library/mysql:8.4`，也可 `--image` 指定可信镜像；服务按不可变 image ID 运行。
- 容器：`--network none`、只读根文件系统、去除全部 capabilities、`no-new-privileges`、非 root、内存 384 MiB（无 swap）、0.5 核、256 PIDs；数据放在 2 GiB 的独立 loop ext4 磁盘（`--disk-size` 可调，`nodev,nosuid,noexec`），磁盘未挂载时服务不启动，避免在空目录重新初始化。实测空闲约 125 MiB、负载后约 180 MiB。另外会启用 root Docker 守护进程，约再占 60–100 MiB，2 GiB 同机部署需关注剩余内存。
- 服务 `qfli-sqlbox.service`；root 密码只在 `/etc/qfli-sqlbox/root.password`。业务只拿到受限的 `qfli_sqlbox` 账号：可建用户、结束连接、读 `information_schema`，并只对 `qs\_%` 库有权限；不能读 `mysql.*`，不能修改带 `SYSTEM_USER` 的 root，没有 FILE/SUPER。安装器会实测这些条件。
- 安装器只在业务 `.env` 缺少时追加 `QFLI_SQLBOX_SOCKET`、`QFLI_SQLBOX_ADMIN_PASSWORD`、`QFLI_SQLBOX_USER_SECRET`，不会打印密钥；重复运行幂等，会重启练习库。不要更换 `QFLI_SQLBOX_USER_SECRET`，否则需要重新下发全部用户密码（账号名不变，下一次请求自动改密）。

每个登录用户对应一个派生 MySQL 账号 `qs_<tag>`，只能访问 `qs_<tag>_*` 库，默认库 `qs_<tag>_main`；App 永远拿不到 MySQL 凭据。每次请求使用新连接，不复用会话状态。限额：单用户数据 32 MiB、8 个库、64 张表，超出后降为只读+删除（`SELECT/DELETE/DROP`），清理后自动恢复；单条请求在超过配额前写入的数据仍会保留，整体由独立磁盘兜底。语句 8 秒（SELECT 另受 5 秒 `max_execution_time`）、结果 1000 行 / 1 MiB / 128 个结果集；全局 2 条同时执行、16 条等待 10 秒；每用户 1 条执行 + 3 条等待、每分钟 30 次。`LOAD DATA LOCAL`、`INTO OUTFILE`、事件、MyISAM/MEMORY/FEDERATED 等引擎不可用。

| 路径 | 内容 |
| --- | --- |
| `GET /api/sql/info` | 前缀、默认库、用量与限额 |
| `POST /api/sql/query` | `{database?,source,params?}`，单语句，参数绑定；`database` 省略为默认库，`""` 为不选库 |
| `POST /api/sql/script` | `{database?,source}`，多语句脚本，出错前的结果保留 |
| `DELETE /api/sql/databases` | 删除本人全部练习库并重建默认库 |

返回格式与 SQLab 原生客户端一致（`available/exitCode/error/sqlState/affectedRows/truncated/columns/columnInfo/rows`，脚本另有 `results`）；二进制列为大写十六进制。卸载：`systemctl disable --now qfli-sqlbox.service 'var-lib-qfli\x2dsqlbox-disk.mount'`，确认不再需要练习数据后再删除 `/var/lib/qfli-sqlbox` 与 `/etc/qfli-sqlbox`。

## API

| 路径 | 内容 |
| --- | --- |
| `POST /api/auth/login` | `{username,password,emailCode?,totpCode?,captchaId?,captchaCode?}` |
| `POST /api/auth/huawei` | `{authorizationCode}` |
| `POST /api/auth/huawei/complete` | `{challengeId,code}` |
| `POST /api/auth/email-code` | `{email}` |
| `POST /api/auth/register` | `{username,email,emailCode,password,nickname?,captchaId?,captchaCode?}` |
| `GET /api/auth/captcha` | `{id,image}`，PNG data URI |
| `POST /api/auth/logout` | 删除本站会话 |
| `GET /api/users/me` | 网关资料 + 本站业务状态 |
| `PATCH /api/users/me` | `{nickname?,bio?}`，修改网关资料 |
| `GET /api/users/me/tasks` / `POST /api/users/me/checkin` | 每日任务和签到；签到基础奖励由管理员配置，连续签到额外奖励沿用原规则 |
| `GET /api/users/me/checkins?month=YYYY-MM` | 签到日历；返回该月签到日期及奖励 |
| `POST /api/users/me/task-events` | 客户端每次成功创建/打开项目或修改文件后上报 `{key,eventId,day}`；同一事件 ID 重试不会重复计数或奖励 |
| `GET /api/users/me/points` | 当前余额和最近 100 条获取/扣除流水 |
| `GET /api/users/me/rewards` / `POST /api/users/me/rewards/:id/redeem` | 可兑换项及原子扣分；兑换后进入待处理状态 |
| `GET /api/users/me/redemptions` | 我的最近 100 条兑换记录 |
| `GET/PATCH /api/users/admin/tasks[/:key]` | 管理员查看并配置任务奖励、启用状态和每日目标次数 `targetCount` |
| `GET/POST/PATCH /api/users/admin/rewards[/:id]` | 管理员维护兑换项、库存及上架状态 |
| `GET/PATCH /api/users/admin/redemptions[/:id]` | 管理员查看兑换记录并标记已交付 |
| `GET /api/users/me/posts` | 本站帖子 |

### 内容审核与社区治理（2026-11 合规整改）

审核能力由独立的公共审核服务提供（仓库 `azurekiln-moderation`），QFLI 侧只有薄适配层
`src/moderation-service.js` 与传输层 `src/moderation-client.js`。审核逻辑、词库、IP 规则、
人工审核队列都在审核服务里，本仓库不存任何判定数据。

| 路径 | 内容 |
| --- | --- |
| `POST /api/posts` | 标题、正文、标签都要过审核；返回 `{id,status}`，`status` 为 `published` 或 `pending` |
| `GET /api/posts` / `GET /api/posts/:id` | `pending` 内容只对作者本人可见，对其他人和未登录返回已发布内容 / 404 |
| `GET /api/posts/:id/comments` | 未登录只看到已发布评论 |
| `GET /api/posts/:id/comments/mine` | 登录后带本人视角，自己的待审评论可见 |
| `POST /api/posts/:id/comments` | 评论过审核并限流；返回 `comment.status` |
| `PATCH /api/users/me` | 昵称、简介先过文本审核，命中返回 422 |
| `POST /api/reports` | `{targetType:"post"\|"comment"\|"user",targetId,reason}` → `201 {id,status}`；转发审核服务举报中心，同时本地留痕 365 天 |
| `DELETE /api/admin/posts/:id` / `DELETE /api/admin/comments/:id` | 必填 `{reason}`，写审计 `admin.post_delete` / `admin.comment_delete` |
| `PATCH /api/admin/posts/:id/status` | 人工复核后改成 `published` / `pending` / `rejected` |
| `GET /api/admin/reports` / `PATCH /api/admin/reports/:id` | 查看与处理举报，`{status:"handled"\|"rejected",resolution}` |
| `GET\|PATCH /api/admin/settings/pre-publish` | 先审后发开关，即时生效 |
| `GET /api/admin/users/:id/moderation` | 查看封停/禁言状态 |
| `POST\|DELETE /api/admin/users/:id/ban` / `mute` | 封停、禁言；必填 `{reason}`，写审计 |
| `GET\|POST\|PATCH\|DELETE /api/admin/moderation/keywords[/:id]` | 转发审核服务词库管理（需 `MODERATION_ADMIN_KEY`） |
| `GET\|POST\|PATCH\|DELETE /api/admin/moderation/ip-rules[/:id]` | 转发审核服务 IP 规则管理 |
| `GET /api/admin/moderation/scenes` / `PUT .../scenes/:scene` | 转发按场景的先审后发策略 |

错误码（新增路径）：

| 状态 | errorKey | 含义 |
| --- | --- | --- |
| 422 | `moderation.blocked` | 文本命中，带 `categories`，不回显命中词 |
| 403 | `moderation.ip_blocked` | IP 或地区规则命中 |
| 503 | `moderation.unavailable` | 审核服务不可用，发布类请求拒绝（failClosed） |
| 429 | `rate.limited` | 发布过于频繁，带 `retryAfter`（秒） |
| 403 | `account.banned` / `account.muted` | 账号被封停 / 被禁言，禁止发布 |

发布闸门顺序固定：封停/禁言 → 限流 → IP 规则 → 文本审核 → 先审后发判定。
限流按用户分别限制发帖与评论（`PUBLISH_RATE_*`、`COMMENT_RATE_*`），计数落库，重启不清零。

## 2026-11 合规整改（服务端部分）

### 日志与可信代理

`audit_logs` 保留 **365 天**，写入侧 `src/audit-retention.js` 与启动清理共用同一常量。
每行带 `ip`、`port`、`platform`、`login_type`。平台取自请求头 `X-Client-Platform`
（`harmonyos-app/<版本号>` 等），只存平台名；登录类型取 `password`、`huawei_login`、
`huawei_skip`、`huawei_bind`、`huawei_mfa`、`oauth2`、`register`、`logout`。
登录、注册、登出都落库。

地址只信任反向代理覆盖写入的 `X-Real-IP` / `X-Real-Port`，`X-Forwarded-For` 一律不读，
也不启用 Express `trust proxy`。nginx 示例见 `docs/deployment/nginx.conf.example`。

### 实名门槛

没有已验证手机号的账号使用社区浏览、发帖、评论、点赞、举报、云项目、在线终端、AI 或
SQL 沙箱，一律 403 `realname.required`，客户端引导走华为账号绑定手机号。
本地内置教程不请求服务端，不受影响。`/api/users` 与 `/api/auth` 不受限，保证任何状态都能注销账号。

华为登录在 `phoneAvailable === false` 时直接拒绝 `/huawei/skip` 与 `/huawei/bind`，
返回 403 `realname.phone_required`，不再建号。

### 永久注销

`POST /api/users/me/deactivate`，请求体 `{confirm:"DEACTIVATE"}`，返回 `{status:"deactivated",deactivated:true,retentionDays:365}`。
顺序固定：先调网关 `POST /oauth2/account/erase`（客户端凭据 Basic 鉴权，scope `qfli_account_erase`），
网关拒绝或不可达就保留本地数据并返回错误，让用户重试；成功后删除
`data/cloud/u<id>`、`data/terminals/u<id>`，事务内删除本站业务数据与会话，
审计行保留 365 天但 `user_id` 换成 `deleted_<sha256>`、`username` 置空。

### AI 与联网工具

后端只需配置 `QFLI_AI_BASE_URL` 和 `QFLI_AI_API_KEY`。
后端通过标准 `GET /v1/models` 获取模型列表。
`GET /api/ai/models` 向已登录客户端返回列表。
聊天请求可携带列表中的 `model`。
旧客户端未指定模型时，后端使用第一个模型。
后端不再读取 `QFLI_AI_MODEL`。
配置示例和接口约定见 [AI 模型发现](deploy/ai-models.md)。
AI 响应固定带 `aiGenerated: true`。
客户端据此显示“内容由 AI 生成”。
`POST /api/ai/web_search` 已下线（搜索走 Bing，属未披露的第三方），`src/web-search.js` 已删除；
`POST /api/ai/web_fetch` 保留并继续执行 SSRF 守卫。

#### 变量表

| 变量 | 必填 | 默认 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `QFLI_AI_BASE_URL` | 是 | 空 | HTTPS 根地址 | OpenAI 兼容根地址，可带 `/v1`，后端保留路径前缀。合规要求指向 DeepSeek 官方接口。 |
| `QFLI_AI_API_KEY` | 是 | 空 | 上游密钥 | 只放后端，不写客户端，不进日志。 |
| `QFLI_AI_CONCURRENCY` | 否 | 2 | 1–8 | 每用户并发请求数。并行会话要调大。 |
| `QFLI_AI_RATE_LIMIT` | 否 | 20 | 1–600 | 每用户每分钟请求数。并行会话要调大。 |
| `QFLI_AI_MAX_INFLIGHT` | 否 | 16 | 1–64 | 全服务在途上限，保护小主机。 |
| `QFLI_AI_TIMEOUT_MS` | 否 | 60000 | 100–120000 | 单次上游请求超时（毫秒）。 |
| `QFLI_AI_REASONING_EFFORTS` | 否 | 空 | 逗号分隔，如 `low,medium,high` | 不配置则不向客户端公布，界面也不显示推理强度选择器。 |
| `QFLI_AI_MODEL` | — | — | — | 已废弃，后端不再读取；模型来自上游列表。 |

#### `.env` 示例

值都是占位符，按实际环境替换：

```ini
QFLI_AI_BASE_URL=https://api.deepseek.com
QFLI_AI_API_KEY=<上游密钥>
QFLI_AI_CONCURRENCY=4
QFLI_AI_RATE_LIMIT=80
QFLI_AI_MAX_INFLIGHT=12
QFLI_AI_TIMEOUT_MS=60000
QFLI_AI_REASONING_EFFORTS=low,medium,high
```

#### 重启

`docker-compose.yaml` 用 `env_file: - .env`，变量在**创建容器时**注入。
只改 `.env` 而不重建容器，进程读到的还是旧值。

```sh
cd /data/qfli/server
docker compose up -d --force-recreate server
```

只重建 `server` 服务，不动 `watchtower`，避免打断镜像更新器。
全量写法 `docker compose up -d --force-recreate` 会连带重建 `watchtower`，功能相同但会中断一次更新轮询。
`docker compose restart` 不重新读 `env_file`，不要用它改配置。

#### 验证

先取登录令牌（令牌只在本机 shell 变量里，不写进仓库）：

```sh
TOKEN=$(curl -s -X POST https://qfli.suanxiwanjie.cn/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<账号>","password":"<密码>"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
```

查模型列表：

```sh
curl -s -o /tmp/ai-models.json -w '%{http_code}\n' \
  https://qfli.suanxiwanjie.cn/api/ai/models \
  -H "Authorization: Bearer $TOKEN"
```

| 状态码 | 含义 | 下一步 |
| --- | --- | --- |
| 200 | 配置生效，写入标准模型列表 `{object:"list",data:[...]}` | 查看 JSON 里的 `data[].id` |
| 401 | 未登录或令牌已过期 | 重新登录取 `TOKEN` |
| 403 | `realname.required`：账号没有已验证手机号，AI 与其他联网服务一律拒绝 | 先走华为账号绑定手机号 |
| 503 | `AI 服务未配置`：缺 `BASE_URL` 或 `KEY`，或地址不是 HTTPS、格式无效 | 补 `.env` 后 `--force-recreate` |
| 502 | `AI 服务凭据无效`：上游拒绝了密钥 | 核对 `QFLI_AI_API_KEY` 与上游控制台 |
| 429 | 触发每用户限流或并发上限 | 见下面的并发与限流 |
| 504 | 上游响应超时 | 调大 `QFLI_AI_TIMEOUT_MS` 或检查上游 |

发一次聊天（不传 `model` 时用列表第一个）：

```sh
curl -s https://qfli.suanxiwanjie.cn/api/ai/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

正常返回 `{aiGenerated:true,model,message:{role:"assistant",content}}`。

#### 并行会话为什么要调大并发和限流

- 每个运行中的会话占一个每用户并发名额。默认 2 表示最多 2 个会话同时打到上游，第 3 个立即 429「已有 AI 请求正在处理」。
- 一轮 agent 循环里每次工具调用都是一次独立的 `/api/ai/chat` 请求。一个会话一分钟内很容易发出十几次，默认 20 次/分钟很快用完。
- 客户端对 429 按 1 秒、2 秒、4 秒退避，最多 3 次；仍失败则本轮失败并提示重试。
- 建议同时运行 N 个会话时：`QFLI_AI_CONCURRENCY` ≥ N（上限 8），`QFLI_AI_RATE_LIMIT` ≥ 20×N（上限 600）。
- 全服务在途还受 `QFLI_AI_MAX_INFLIGHT` 与容器资源约束。2C2G 小主机建议 `QFLI_AI_MAX_INFLIGHT` ≤ 8，先保证 MySQL、终端执行器与业务接口不被挤占。

合规提示：上游必须是已披露的服务方。不得改指向会引入未披露第三方的搜索或转售接口。

成功登录返回 `{token,user}`，其中 `user.id` 是 `user_` 开头的字符串本地 ID，`user.gatewayUserId` 是网关 sub。`user.avatarUrl` 来自网关 `picture`，App 个人页显示该图片。
受保护 API 使用 `Authorization: Bearer <QFLI token>`。社区、云项目、在线终端 API 保持原路径。
本地项目与文件操作只能由客户端上报，服务端无法核验设备文件系统。默认每种操作设每日 1、5、10 次任务，达到每个档位时分别领取一次；`GET /me/tasks` 返回当日 `day`、每档 `progress/target/eventKey/done`。客户端逐次保存本机计数及待同步事件，断网后使用同一个 `eventId` 重试；任务、签到日历和积分兑换数据优先读取账号本地缓存，每天自动更新一次，手动刷新强制重取。兑换项由管理员创建，服务端只记录待处理/已交付，不自动发货。积分流水记录本次上线后发生的变动，历史签到不会自动回填流水。

## 当前联调条件

源码接口已按本地网关实现对齐。真实登录、SMTP 邮件和华为授权仍需要填写客户端配置、部署两端，并使用真实账号和设备联调；仅语法检查不能证明线上登录成功。

## 容器镜像部署

业务后端与终端执行器分别发布镜像。服务器只拉取预构建镜像。服务器不现场构建。

默认镜像为 `docker.cnb.cool/azurekiln/azurekiln-qfli-server:latest`，
由 CNB 流水线发布。镜像路径由仓库路径决定，见 `.cnb.yml` 与 `scripts/ci-common.mjs`。

部署目录只放 `docker-compose.yaml`、`.env` 与 `data/`：

```sh
cd /data/qfli/server
docker compose pull server watchtower
docker compose up -d server watchtower
docker compose ps
```

`.env` 从 `.env.example` 复制。启动前必须填写 `QFLI_JWT_SECRET`、`MYSQL_PASSWORD`、
`AZK_OAUTH2_BASE_URL`、`AZK_OAUTH2_CLIENT_ID`、`AZK_OAUTH2_CLIENT_SECRET`、
`QFLI_TERMINAL_SECRET`、`MODERATION_BASE_URL`、`MODERATION_API_KEY`、
`MODERATION_ADMIN_KEY`、`QFLI_MODERATION_SUBJECT_SALT` 与 `QFLI_AI_API_KEY`。
审核相关的三项留空时，发布类请求一律返回 503。

数据目录属于容器运行用户。迁移既有安装时先调整归属：

```sh
chown -R 1000:1000 /data/qfli/server/data
```

容器使用 host 网络。`127.0.0.1` 上的 MySQL、练习库 socket 与终端地址保持不变。

业务服务不挂载 Docker socket。只有独立的 watchtower 容器持有宿主 Docker socket。

两个更新范围分别是 `qfli-server` 和 `qfli-terminal`。不要用 `depends_on` 绑定两套。终端不可用时业务继续工作。

### 升级与回滚

```sh
docker compose pull server
docker compose up -d server
```

`up -d` 只在镜像变化时替换容器。回滚时把 `QFLI_SERVER_IMAGE` 固定到旧 digest，再执行 `up -d`。

### 构建流水线

校验与发布逻辑只有一份，放在 `scripts/ci-common.mjs`。各平台只负责检出、装 Node 和登录镜像仓库。

| 平台 | 校验 | 发布镜像 | 镜像地址 | 配置文件 |
| --- | --- | --- | --- | --- |
| CNB | 是 | 是 | `docker.cnb.cool/azurekiln/azurekiln-qfli-server` | `.cnb.yml` |
| GitHub Actions | 是 | 是 | `ghcr.io/azurekiln2333/azurekiln-qfli-server` | `.github/workflows/build-and-push.yml` |
| GitLab CI | 是 | 是 | `registry.gitlab.com/azurekiln-team/azurekiln-qfli-server` | `.gitlab-ci.yml` |
| GitCode / AtomGit | 是 | 否 | 无 | `.gitcode/workflows/verify.yml` |
| Gitee | 否 | 否 | 无 | 无 |

标签规则：`main` 推送 `sha-<12位提交>` 并更新 `latest`；`vX.Y.Z` 推送同名标签并更新 `latest`；
`vX.Y.Z-rc.1` 只推预发布标签，不动 `latest`。其他分支和非 semver 标签会被脚本拒绝。

Gitee 的免费云构建只面向企业账户，GitCode 缺少公开的托管镜像仓库凭据说明。
两家的依据与取舍写在 `deploy/ci-platforms.md`。

改镜像来源时只改环境变量，不改 compose 默认值：

```sh
QFLI_SERVER_IMAGE=ghcr.io/azurekiln2333/azurekiln-qfli-server:latest
```

### 多执行节点

业务端可配置多个终端执行节点。每节点使用独立的 `id`、`url` 与 `secret`。配置项是 `QFLI_TERMINAL_NODES`。格式见 `.env.example`。

业务实例共享同一个 MySQL。多业务副本仍受进程内授权状态限制。待共享 OAuth、MFA、绑定、限流和云文件存储完成后再开副本。

