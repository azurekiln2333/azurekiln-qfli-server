#!/usr/bin/env bash
# Installs the practice-only MySQL used by QFLI cloud SQL. It is a separate
# mysqld (own container, datadir, disk and socket) and never hosts business data.
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 022

fail() { printf 'QFLI sqlbox setup: %s\n' "$*" >&2; exit 1; }
step() { printf '\nQFLI sqlbox setup: %s\n' "$*"; }
usage() {
  printf 'Usage: bash %s --business-env PATH [--image TRUSTED_IMAGE] [--disk-size SIZE]\n' "$0"
  printf 'Copy this script to a root-owned path first; it writes a root systemd unit.\n'
}

business_env=
image=mysql:8.4
disk_size=2G
while (($#)); do
  case "$1" in
    --business-env) (($# >= 2)) || fail '--business-env needs a path'; business_env=$2; shift 2 ;;
    --image) (($# >= 2)) || fail '--image needs a trusted image'; image=$2; shift 2 ;;
    --disk-size) (($# >= 2)) || fail '--disk-size needs a size such as 2G'; disk_size=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done
[[ "$EUID" == 0 ]] || fail 'run as root'
[[ -n "$business_env" ]] || { usage >&2; fail '--business-env is required'; }
[[ "$image" =~ ^[a-z0-9][a-z0-9._/:@-]{0,250}$ ]] || fail 'invalid image reference'
[[ "$disk_size" =~ ^[1-9][0-9]{0,3}[MG]$ ]] || fail 'disk size must look like 512M or 2G'
business_env=$(realpath -e -- "$business_env") || fail 'business env does not exist'
[[ -f "$business_env" ]] || fail "business env must be a regular file: $business_env"
self=$(realpath -e -- "${BASH_SOURCE[0]}")
[[ "$(stat -c %u "$self")" == 0 ]] || fail 'copy this script to a root-owned path before running it'
(( (8#$(stat -c %a "$self") & 8#022) == 0 )) || fail 'this script must not be group/other writable'

for command in docker systemctl systemd-escape mountpoint findmnt mkfs.ext4 truncate od tr flock timeout awk; do
  command -v "$command" >/dev/null || fail "missing command: $command"
done
exec 9>/run/lock/qfli-sqlbox-bootstrap.lock
flock -n 9 || fail 'another sqlbox installation is already running'

state=/var/lib/qfli-sqlbox
config=/etc/qfli-sqlbox
disk_image="$state/disk.img"
disk_mount="$state/disk"
datadir="$disk_mount/mysql"
socket_dir=/run/qfli-sqlbox
socket="$socket_dir/mysqld.sock"
unit=qfli-sqlbox.service
container=qfli-sqlbox
random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

step 'checking the root Docker engine'
systemctl is-active --quiet docker.service || systemctl enable --now docker.service
docker info >/dev/null 2>&1 || fail 'the root Docker daemon is not reachable'
[[ "$(docker info --format '{{.CgroupVersion}}')" == 2 ]] || fail 'cgroup v2 is required'
available_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
((available_kib >= 512 * 1024)) ||
  printf 'QFLI sqlbox setup: warning: only %s MiB available; the practice MySQL may use up to 384 MiB\n' \
    "$((available_kib / 1024))" >&2

step "pulling the trusted practice MySQL image ($image)"
if ! timeout 600 docker pull "$image"; then
  [[ "$image" == mysql:8.4 ]] || fail "cannot pull $image"
  image=mirror.gcr.io/library/mysql:8.4
  timeout 600 docker pull "$image" || fail 'Docker Hub and its Google mirror are unreachable; pass --image'
fi
image_id=$(docker image inspect --format '{{.Id}}' "$image")
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'cannot resolve the image ID'
version=$(docker run --rm --network none --entrypoint mysqld "$image_id" --version)
[[ "$version" == *" 8.4."* ]] || fail "expected MySQL 8.4, got: $version"
mysql_uid=$(docker run --rm --network none --entrypoint id "$image_id" -u mysql)
mysql_gid=$(docker run --rm --network none --entrypoint id "$image_id" -g mysql)
[[ "$mysql_uid" =~ ^[1-9][0-9]*$ && "$mysql_gid" =~ ^[1-9][0-9]*$ ]] ||
  fail 'the image mysql account must be non-root'

step "preparing the dedicated $disk_size practice data disk"
install -d -m 0700 -o root -g root "$state" "$config"
install -d -m 0755 -o root -g root "$disk_mount"
mount_unit=$(systemd-escape --path --suffix=mount "$disk_mount")
if [[ ! -e "$disk_image" ]]; then
  mountpoint -q "$disk_mount" && fail "$disk_mount is already a mount point"
  [[ -z "$(ls -A "$disk_mount")" ]] || fail "$disk_mount must be empty before creating the disk"
  truncate -s "$disk_size" "$disk_image"
  chmod 0600 "$disk_image"
  mkfs.ext4 -q -F -L qfli-sqlbox "$disk_image"
fi
[[ -f "$disk_image" && ! -L "$disk_image" ]] || fail "$disk_image must be a regular file"
printf '%s\n' '[Unit]' 'Description=QFLI practice MySQL data disk' \
  '[Mount]' "What=$disk_image" "Where=$disk_mount" 'Type=ext4' \
  'Options=loop,nodev,nosuid,noexec' \
  '[Install]' 'WantedBy=multi-user.target' > "/etc/systemd/system/$mount_unit"
systemctl daemon-reload
systemctl enable --now "$mount_unit"
mountpoint -q "$disk_mount" || fail "$disk_mount is not mounted"
[[ "$(findmnt -n -o SOURCE --target "$disk_mount")" == /dev/loop* ]] ||
  fail "$disk_mount is not the dedicated loop disk"
install -d -m 0750 -o "$mysql_uid" -g "$mysql_gid" "$datadir"

step 'writing the practice MySQL configuration'
cat > "$config/qfli-sqlbox.cnf" <<'CNF'
# Practice-only MySQL for QFLI cloud SQL. It never hosts business data.
[mysqld]
skip-networking
mysqlx=OFF
skip-name-resolve
skip-log-bin
performance_schema=OFF
event_scheduler=OFF
local_infile=OFF
secure_file_priv=NULL
disabled_storage_engines=MyISAM,MEMORY,ARCHIVE,BLACKHOLE,FEDERATED,CSV,MRG_MYISAM
default_storage_engine=InnoDB
character_set_server=utf8mb4
collation_server=utf8mb4_0900_ai_ci
information_schema_stats_expiry=0
max_execution_time=5000
max_connections=32
max_allowed_packet=4M
wait_timeout=60
interactive_timeout=60
lock_wait_timeout=10
innodb_lock_wait_timeout=5
max_prepared_stmt_count=256
open_files_limit=2048
table_open_cache=256
table_definition_cache=400
thread_cache_size=4
innodb_buffer_pool_size=64M
innodb_log_buffer_size=8M
innodb_redo_log_capacity=64M
innodb_io_capacity=100
innodb_flush_log_at_trx_commit=2
innodb_temp_data_file_path=ibtmp1:12M:autoextend:max:256M
key_buffer_size=1M
sort_buffer_size=256K
join_buffer_size=256K
read_buffer_size=128K
read_rnd_buffer_size=256K
tmp_table_size=16M
max_heap_table_size=16M
temptable_max_ram=32M
log_error_verbosity=2
CNF
chmod 0644 "$config/qfli-sqlbox.cnf"

step 'reconciling practice MySQL credentials'
# Last assignment wins, matching Node's --env-file parser.
env_value() {
  awk -v key="$1" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' \
    "$business_env"
}
root_password_file="$config/root.password"
if [[ ! -f "$root_password_file" ]]; then
  [[ ! -e "$datadir/mysql" ]] || fail "existing practice data has no $root_password_file; restore it first"
  (umask 077; random_hex > "$root_password_file")
fi
root_password=$(<"$root_password_file")
[[ "$root_password" =~ ^[0-9a-f]{64}$ ]] || fail "$root_password_file is invalid"
append=()
admin_password=$(env_value QFLI_SQLBOX_ADMIN_PASSWORD)
if [[ -z "$admin_password" ]]; then
  admin_password=$(random_hex)
  append+=("QFLI_SQLBOX_ADMIN_PASSWORD=$admin_password")
fi
[[ "$admin_password" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'QFLI_SQLBOX_ADMIN_PASSWORD in the business env must be 64 lowercase hex characters'
user_secret=$(env_value QFLI_SQLBOX_USER_SECRET)
if [[ -z "$user_secret" ]]; then
  append+=("QFLI_SQLBOX_USER_SECRET=$(random_hex)")
elif [[ ! "$user_secret" =~ ^[0-9a-f]{64}$ ]]; then
  fail 'QFLI_SQLBOX_USER_SECRET in the business env must be 64 lowercase hex characters'
fi
unset user_secret
configured_socket=$(env_value QFLI_SQLBOX_SOCKET)
if [[ -z "$configured_socket" ]]; then
  append+=("QFLI_SQLBOX_SOCKET=$socket")
elif [[ "$configured_socket" != "$socket" ]]; then
  fail "QFLI_SQLBOX_SOCKET must be $socket (the practice server has no TCP listener)"
fi

run_flags=(--network none --read-only --cap-drop ALL --security-opt no-new-privileges
  --user "$mysql_uid:$mysql_gid" --memory 384m --memory-swap 384m --cpus 0.5 --pids-limit 256
  --ulimit nofile=4096:4096 --log-driver json-file --log-opt max-size=5m --log-opt max-file=2
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777
  -v "$datadir:/var/lib/mysql" -v "$config/qfli-sqlbox.cnf:/etc/mysql/conf.d/qfli-sqlbox.cnf:ro")

if [[ ! -d "$datadir/mysql" ]]; then
  [[ -z "$(ls -A "$datadir")" ]] || fail "$datadir contains files but no initialized MySQL data"
  step 'initializing the practice MySQL data directory'
  systemctl stop "$unit" 2>/dev/null || true
  init_dir="$state/init"
  rm -rf -- "$init_dir"
  install -d -m 0700 -o "$mysql_uid" -g "$mysql_gid" "$init_dir"
  (umask 077; printf '%s' "$root_password" > "$init_dir/root.password")
  chown "$mysql_uid:$mysql_gid" "$init_dir/root.password"
  install -d -m 0755 -o "$mysql_uid" -g "$mysql_gid" "$socket_dir"
  docker rm -f qfli-sqlbox-init >/dev/null 2>&1 || true
  docker run -d --name qfli-sqlbox-init "${run_flags[@]}" \
    -v "$init_dir:/run/qfli-init:ro" -v "$socket_dir:/var/run/mysqld" \
    -e MYSQL_ROOT_PASSWORD_FILE=/run/qfli-init/root.password -e MYSQL_ROOT_HOST=localhost \
    "$image_id" >/dev/null
  initialized=0
  for ((attempt = 0; attempt < 240; attempt++)); do
    if docker logs qfli-sqlbox-init 2>&1 | grep -q 'MySQL init process done. Ready for start up.'; then
      initialized=1
      break
    fi
    [[ "$(docker inspect -f '{{.State.Running}}' qfli-sqlbox-init)" == true ]] || break
    sleep 1
  done
  ((initialized)) || docker logs --tail 40 qfli-sqlbox-init >&2 || true
  docker stop -t 30 qfli-sqlbox-init >/dev/null || true
  docker rm -f qfli-sqlbox-init >/dev/null || true
  rm -rf -- "$init_dir"
  ((initialized)) || fail 'practice MySQL initialization failed'
fi

step 'installing the practice MySQL service'
docker_bin=$(command -v docker)
{
  printf '%s\n' '[Unit]' 'Description=QFLI practice MySQL (isolated from business data)' \
    'Requires=docker.service' 'After=docker.service' \
    "Requires=$mount_unit" "After=$mount_unit" "RequiresMountsFor=$disk_mount" '' \
    '[Service]' 'Type=simple' \
    "ExecStartPre=$(command -v mountpoint) -q $disk_mount" \
    "ExecStartPre=$(command -v install) -d -m 0755 -o $mysql_uid -g $mysql_gid $socket_dir" \
    "ExecStartPre=-$docker_bin rm -f $container" \
    "ExecStart=$docker_bin run --rm --name $container ${run_flags[*]} -v $socket_dir:/var/run/mysqld $image_id" \
    "ExecStartPost=$(command -v timeout) 120 /bin/sh -c 'until $docker_bin exec $container mysqladmin --socket=/var/run/mysqld/mysqld.sock ping >/dev/null 2>&1; do sleep 1; done'" \
    "ExecStop=$docker_bin stop -t 50 $container" \
    'Restart=on-failure' 'RestartSec=5' 'TimeoutStartSec=180' 'TimeoutStopSec=70' '' \
    '[Install]' 'WantedBy=multi-user.target'
} > "/etc/systemd/system/$unit"
systemctl daemon-reload
systemctl enable "$unit" >/dev/null
systemctl restart "$unit"
[[ -S "$socket" ]] || fail "the practice MySQL socket is missing: $socket"

# Passwords travel on stdin into a container-private tmpfs file, never argv.
mysql_as() {
  local user=$1 password=$2 status=0
  shift 2
  docker exec -i "$container" sh -c 'umask 077; cat > /tmp/.qfli-client.cnf' <<<"$(printf \
    '[client]\nuser=%s\npassword=%s\nsocket=/var/run/mysqld/mysqld.sock\n' "$user" "$password")"
  docker exec -i "$container" mysql --defaults-extra-file=/tmp/.qfli-client.cnf \
    --batch --skip-column-names "$@" || status=$?
  docker exec "$container" rm -f /tmp/.qfli-client.cnf
  return "$status"
}

step 'provisioning the restricted business provisioner account'
mysql_as root "$root_password" <<<"$(printf '%s\n' \
  "CREATE USER IF NOT EXISTS 'qfli_sqlbox'@'localhost' IDENTIFIED BY '$admin_password';" \
  "ALTER USER 'qfli_sqlbox'@'localhost' IDENTIFIED BY '$admin_password' ACCOUNT UNLOCK;" \
  "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'qfli_sqlbox'@'localhost';" \
  "GRANT CREATE USER, CONNECTION_ADMIN, PROCESS ON *.* TO 'qfli_sqlbox'@'localhost';" \
  "GRANT ALL PRIVILEGES ON \`qs\\_%\`.* TO 'qfli_sqlbox'@'localhost' WITH GRANT OPTION;")" ||
  fail 'cannot provision the business provisioner account'
root_grants=$(mysql_as root "$root_password" <<<"SHOW GRANTS FOR 'root'@'localhost';")
[[ "$root_grants" == *SYSTEM_USER* ]] ||
  fail 'root must hold SYSTEM_USER so the provisioner cannot modify it'

step 'verifying practice MySQL isolation settings'
settings=$(mysql_as qfli_sqlbox "$admin_password" <<<"SELECT CONCAT_WS(' ', @@skip_networking,
  @@local_infile, IFNULL(@@secure_file_priv, 'NULL'), @@event_scheduler, @@performance_schema,
  @@innodb_buffer_pool_size, @@max_execution_time, (SELECT COUNT(*) FROM information_schema.PLUGINS
  WHERE PLUGIN_NAME = 'mysqlx' AND PLUGIN_STATUS = 'ACTIVE'));") ||
  fail 'the provisioner account cannot connect'
[[ "$settings" == '1 0 NULL OFF 0 67108864 5000 0' ]] ||
  fail "practice MySQL settings are not effective: $settings"
mysql_as qfli_sqlbox "$admin_password" <<<"DROP USER IF EXISTS 'qs_probe'@'localhost';
CREATE USER 'qs_probe'@'localhost' IDENTIFIED BY '$(random_hex)' ACCOUNT LOCK;
GRANT SELECT, INSERT, CREATE, DROP ON \`qs\\_probe\\_%\`.* TO 'qs_probe'@'localhost';
REVOKE INSERT, CREATE ON \`qs\\_probe\\_%\`.* FROM 'qs_probe'@'localhost';
DROP USER 'qs_probe'@'localhost';" || fail 'the provisioner cannot delegate per-user schema grants'
if mysql_as qfli_sqlbox "$admin_password" <<<'SELECT 1 FROM mysql.user LIMIT 1;' >/dev/null 2>&1; then
  fail 'the provisioner must not read mysql system tables'
fi

if ((${#append[@]})); then
  step "adding practice MySQL settings to $business_env"
  [[ -z "$(tail -c1 "$business_env")" ]] || printf '\n' >> "$business_env"
  printf '%s\n' '# QFLI practice MySQL (deployment/sqlbox); separate from the business MySQL.' \
    "${append[@]}" >> "$business_env"
fi
unset root_password admin_password append
step "ready: $unit is active; restart the business API so it loads QFLI_SQLBOX_* settings"
