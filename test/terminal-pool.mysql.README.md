# MySQL 终端池集成测试（可选）

## 目的

验证 MySQL 上的终端池 schema 与跨业务实例协调。SQLite 测试不能证明 InnoDB 行锁行为。

## 前置条件

- 使用一次性 MySQL 8.0 或 8.4 实例。禁止指向生产库。
- 数据库名必须包含 `test`。测试脚本会拒绝其他名称。
- 环境已安装本目录依赖。

## 测试命令

```bash
cd azurekiln-qfli-server
QFLI_TEST_MYSQL=1 \
DB_DRIVER=mysql \
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=13379 \
MYSQL_USER=root \
MYSQL_PASSWORD=qfli_test_root \
MYSQL_DATABASE=qfli_pool_test \
node --test test/terminal-pool.mysql.test.js
```

测试结束后调用 `db.close()` 关闭连接池。没有这一步进程不会退出。

## 临时容器示例

必须让容器与测试在同一 WSL 会话内启动。WSL 最后一个会话结束时发行版会关闭容器。
下面使用 ROOT 引擎。它与终端运行时的 rootless 引擎分开，互不争用。

```bash
docker run -d --name qfli-pool-mysql-root \
  -e MYSQL_ROOT_PASSWORD=qfli_test_root \
  -e MYSQL_DATABASE=qfli_pool_test \
  -e MYSQL_ROOT_HOST=% \
  -p 127.0.0.1:13379:3306 \
  -v qfli-pool-mysql-root-data:/var/lib/mysql \
  mirror.gcr.io/library/mysql:8.4 \
  --innodb-buffer-pool-size=64M --performance-schema=OFF --skip-log-bin

# 等待就绪后再执行测试。
docker exec qfli-pool-mysql-root mysqladmin ping -h127.0.0.1 -uroot -pqfli_test_root --silent

# 测试结束后清理。
docker rm -f qfli-pool-mysql-root
docker volume rm qfli-pool-mysql-root-data
```

使用 ROOT 引擎时给 `docker` 加 `sudo -n`。终端运行时的 rootless 引擎不要与测试共用。

## 覆盖内容

- 新建 `terminal_slots` 与 `terminal_coord` 表。
- `terminal_coord` 单行版本号锁串行化放置。
- 两个模块实例模拟两个业务副本，共享同一 MySQL。
- 两用户并发放置到不同节点。
- 同用户并发放置只成功一次。
- 令牌围栏拒绝迟到提交。
- 执行与确认回收的真实 HTTP 往返。

## 已验证结果

- 2026-10 在 `qfli-terminal-test` 的 ROOT 引擎上用缓存 `mysql:8.4` 实跑。
- `test/terminal-pool.mysql.test.js` 2/2 通过，退出码 0。
- 进程正常退出，容器与卷已删除。
- rootless 引擎与 `qfli-sqlbox` 未改动。

## 仍未验证

- 旧库 `ALTER TABLE` 补充 `reclaim_user_id`。SQLite 路径已验证，MySQL 未构造旧表。
- InnoDB 锁等待超时与死锁回滚。
- 生产规模的并发与长时压测。

在这些项取得实际结果前，不得声称完整生产验证完成。
