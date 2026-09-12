#!/usr/bin/env bash
# boot-guard.sh - 守护启动 DeepSeek Harness（macOS/Linux）。
# dsh-guard-restart-asset: boot-guard.sh v3
#
# 快照所有 profile → 启动 DSH → 两阶段健康检查；失败则杀掉服务、回滚到最近
# 良好快照并重试一次；首次尝试失败还会写事故报告 + 待处理标记。
#
# v3（2026-09-11）：新增 Phase 3 —— 端口健康后不立即存快照，先开一个页面确认
# 窗口（PAGE_WAIT_SEC，默认 75s）：
#   - 页面崩溃标记（$DSH_HOME/guard/plugin-crash.json，bootId 匹配本启动）：
#       失败态(带插件名) → guard plugin-disable 自动禁用元凶 → 重启重试一次；
#       挂起态(无名字)   → 不自动动作，等页面恢复面板人工处置。
#   - /booted=true 到达 → 页面确认可交互 → 此时才 revive-coin --mark。
#   - 窗口耗尽仍无页面确认（headless 等）→ 按端口信号保底存快照。
#   => 修掉"升级插件→挂起→坏状态被当成良好快照"的时序缺陷：挂起/失败态不再
#      覆盖回滚快照，手动回滚才能真正回到升级前版本。
#
# 来源（2026-09-11）：由 dsh-fuhuobi 的 scripts/boot-guard.sh 复制移植到
# dsh-guard-restart，并把 guard CLI 从 dsh-fuhuobi 换成插件自带的
# lib/assets/guard-cli.js（setup 安装到 $DSH_HOME/guard/guard-cli.js）——
# 本脚本因此不再依赖 dsh-fuhuobi。另按 systemd 托管需要做了局部修改
# （裸 wait → 按 PID 轮询，见下部注释）。setup 按版本标记自动替换旧副本。
#
# 用法（通常由 systemd ExecStart 的 run-dsh-web.sh exec 进来）：
#   DSH_HOME="$HOME/.dsh" ./boot-guard.sh
#
# 启动顺序：$DSH_HOME/guard/launch.json 存在（插件在每次"确认可用"启动后刷新）
# 则按清单原样拉起；否则用 PATH 上的 dsh；再否则干净失败并给出提示。
#
# 依赖：node（guard CLI + 启动清单解析）、curl（健康探测）。
set -u

FIRST_WAIT_SEC="${FIRST_WAIT_SEC:-60}"
RETRY_WAIT_SEC="${RETRY_WAIT_SEC:-30}"
PAGE_WAIT_SEC="${PAGE_WAIT_SEC:-75}"
PORT="${PORT:-3080}"
PROFILE="${PROFILE:-web}"
HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Resolve DSH_HOME: honor an explicitly set $DSH_HOME (expanding a leading `~`
# to $HOME), otherwise default to $HOME/.dsh. Never derive it from this
# script's own location.
if [ -n "${DSH_HOME:-}" ]; then
  case "$DSH_HOME" in
    '~') DSH_HOME="$HOME" ;;
    '~/'*) DSH_HOME="$HOME/${DSH_HOME#~/}" ;;
  esac
else
  DSH_HOME="$HOME/.dsh"
fi
export DSH_HOME

# Launch manifest written by the plugin on every confirmed-good boot. When
# present it tells us exactly how to start the server (modern installs launch
# DSH via `node --import tsx/esm <checkout>/apps/cli/src/bin.ts web` — there is
# no `dsh` on PATH), so we never have to guess.
LAUNCH_JSON="$DSH_HOME/guard/launch.json"

# Guard CLI: 首选 setup 安装的 $DSH_HOME/guard/guard-cli.mjs（.mjs 强制 ESM，
# 不会被宿主目录树上的 package.json 误判为 CommonJS；.js 旧副本仅作回退），
# 再回退到 profile 里 dsh-guard-restart 自带的副本。两者都缺失时只记一行日志
# 并跳过 guard 动作，绝不因此让启动失败。
CLI="$DSH_HOME/guard/guard-cli.mjs"
if [ ! -f "$CLI" ]; then
  CLI="$DSH_HOME/guard/guard-cli.js"
fi
if [ ! -f "$CLI" ]; then
  CLI="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-guard-restart/lib/assets/guard-cli.mjs"
fi
if [ ! -f "$CLI" ]; then
  CLI="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-guard-restart/lib/assets/guard-cli.js"
fi
GUARD_MISSING_LOGGED=0

LOG_DIR="$DSH_HOME/guard/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BOOT_LOG="$LOG_DIR/boot-$STAMP.log"
SERVER_OUT="$LOG_DIR/server-$STAMP.out.log"
SERVER_ERR="$LOG_DIR/server-$STAMP.err.log"
STATUS_FILE="$LOG_DIR/last-boot.txt"

log() { echo "[$(date +%H:%M:%S)] $*" >> "$BOOT_LOG"; }
set_status() { echo "$(date '+%F %T') $1 $2 (log: $STAMP)" > "$STATUS_FILE"; }
healthy() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; }

guard() {
  if [ ! -f "$CLI" ]; then
    if [ "$GUARD_MISSING_LOGGED" -eq 0 ]; then
      log "guard-cli missing at $CLI - skipping guard actions"
      GUARD_MISSING_LOGGED=1
    fi
    return 0
  fi
  node "$CLI" "$@" 2>&1 | while IFS= read -r line; do [ -n "$line" ] && log "  [guard] $line"; done
}

wait_healthy() {
  local deadline=$((SECONDS + $1))
  while [ $SECONDS -lt $deadline ]; do
    healthy && return 0
    sleep 0.5
  done
  return 1
}

# 从 stdin 的 JSON 里取一个字段（node 单行；失败输出空串）。
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j[process.argv[1]]??""))}catch{process.stdout.write("")}})' "$1"
}

# 直跑 guard CLI 并原样输出 stdout（guard() 会吞进日志，这里要拿返回值/判定）。
guard_raw() {
  [ -f "$CLI" ] && node "$CLI" "$@"
}

# Phase 3 崩溃判定：curl /ping 拿本启 bootId → crash-check 读标记。
# 输出: disable:<插件名> | manual | none | stale | boot-unknown
crash_verdict() {
  local jar="$1" boot out action plugin
  boot=$(curl -sL -m 3 -c "$jar" -b "$jar" "http://127.0.0.1:$PORT/dsh-guard-restart/ping" 2>/dev/null | json_field boot)
  [ -z "$boot" ] && { echo boot-unknown; return; }
  out=$(guard_raw crash-check --boot "$boot" 2>/dev/null | tail -1)
  action=$(printf '%s' "$out" | json_field action)
  case "$action" in
    disable) plugin=$(printf '%s' "$out" | json_field plugin)
             echo "disable:$plugin" ;;
    manual)  echo manual ;;
    *)       echo "$action" ;;
  esac
}

# 附着等待：进程退出即结束（v2 systemd 补丁的按 PID 轮询版）。
attach_loop() {
  local pid="$1"
  while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  log "server exited; boot guard done"
}

# Reads $LAUNCH_JSON and, via a single `node -e`, either prints a fully-quoted
# shell command line (viaShell: true -> run through `sh -c`) or spawns the
# child detached with stdio redirected to the guard's log files and prints the
# child pid. Node is guaranteed present (DSH itself runs on node), so no jq.
# File/args/cwd paths are passed in via env vars to avoid argv-index ambiguity.
NODE_LAUNCH_CODE="$(cat <<'DSH_NODE_EOF'
const fs = require('fs');
let m;
try { m = JSON.parse(fs.readFileSync(process.env.DSH_LAUNCH_JSON, 'utf8')); }
catch (e) { console.error('manifest parse failed: ' + e.message); process.exit(2); }
const file = m.file, args = (m.args || []), cwd = (m.cwd || process.cwd());
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
if (m.viaShell) {
  let parts = [q(file)].concat(args.map(q));
  let cmd = parts.join(' ');
  if (cwd) cmd = 'cd ' + q(cwd) + ' && ' + cmd;
  process.stdout.write(cmd + '\n');
  process.exit(0);
}
const cp = require('child_process');
const so = fs.openSync(process.env.DSH_SERVER_OUT, 'a');
const se = fs.openSync(process.env.DSH_SERVER_ERR, 'a');
const child = cp.spawn(file, args, { cwd: cwd, detached: true, stdio: ['ignore', so, se] });
if (!child.pid) { console.error('spawn failed for ' + file); process.exit(2); }
child.unref();
process.stdout.write(String(child.pid) + '\n');
process.exit(0);
DSH_NODE_EOF
)"

start_server() {
  local pid=""
  if [ -f "$LAUNCH_JSON" ]; then
    local out
    out="$(DSH_LAUNCH_JSON="$LAUNCH_JSON" DSH_SERVER_OUT="$SERVER_OUT" DSH_SERVER_ERR="$SERVER_ERR" node -e "$NODE_LAUNCH_CODE")" || return 1
    case "$out" in
      '')
        log "launch manifest produced no launch command"
        return 1
        ;;
      *[!0-9]*)
        # viaShell: $out is the full quoted command line for sh -c
        setsid sh -c "$out" >"$SERVER_OUT" 2>"$SERVER_ERR" < /dev/null &
        pid=$!
        ;;
      *)
        # non-viaShell: node spawned the child detached and printed its pid
        pid=$out
        ;;
    esac
  elif command -v dsh >/dev/null 2>&1; then
    setsid dsh web >"$SERVER_OUT" 2>"$SERVER_ERR" < /dev/null &
    pid=$!
  else
    log "no launch manifest and no dsh on PATH - boot DSH once from the CLI so $DSH_HOME/guard/launch.json gets written"
    return 1
  fi
  echo "$pid"
}

stop_server() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  sleep 1
  kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
}

# Phase 3：页面确认窗口（v3）。
# 参数: $1=当前存活服务 pid, $2=嵌套深度(默认 0, 只有 0 才允许自动禁用)。
# 语义: 最多 PAGE_WAIT_SEC 内轮询 ——
#   disable:<插件>  → 自动禁用元凶 → 杀旧进程重启 → 健康后嵌套再确认(不再二次禁用)
#   manual          → 挂起/未知，不自动动作，页面恢复面板人工处置
#   /booted=true    → 客户端确认可交互 → 返回 0(可以存回滚快照)
#   窗口耗尽        → 无页面确认(headless) → 返回 0(按端口信号保底存快照)
# 返回: 0=应存快照(页面确认/headless 保底); 1=已自动处理并自行存过快照; 2=不应存快照。
# 全局 ATTACH_PID 记录最后存活的服务 pid(供外层 attach)。
ATTACH_PID=""
finalize_boot() {
  ATTACH_PID="$1"
  local depth="${2:-0}" jar="$LOG_DIR/guard-status.jar"
  local deadline=$((SECONDS + PAGE_WAIT_SEC))
  while [ $SECONDS -lt $deadline ]; do
    local verdict name pid3 booted
    verdict=$(crash_verdict "$jar")
    case "$verdict" in
      disable:*)
        name="${verdict#disable:}"
        if [ "$depth" -gt 0 ]; then
          log "page failed again ($name) but auto-disable already used this boot; leaving to user"
          set_status WARN page-failed
          return 2
        fi
        log "page failed; auto-disabling culprit plugin: $name"
        guard_raw plugin-disable --profile "$PROFILE" --name "$name" --reason "auto (page failed at boot ${STAMP})" >>"$BOOT_LOG" 2>&1
        set_status AUTO disabled-plugin
        stop_server "$ATTACH_PID"
        pid3=$(start_server) || { log "relaunch after plugin-disable failed"; return 2; }
        ATTACH_PID="$pid3"
        log "restarted server after disabling $name (pgid $pid3)"
        if ! wait_healthy "$RETRY_WAIT_SEC"; then
          stop_server "$pid3"
          set_status FAILED after-disable
          fail_boot
          return 2
        fi
        log "boot ok after disabling $name"
        set_status OK disabled-retry
        if finalize_boot "$pid3" 1; then
          guard revive-coin --mark
        fi
        return 1
        ;;
      manual)
        log "page stuck (no culprit identified); no auto action — page-side recovery panel offered"
        set_status WARN page-stuck
        return 2
        ;;
      none|stale|boot-unknown|"")
        ;;
    esac
    booted=$(curl -sL -m 3 -c "$jar" -b "$jar" "http://127.0.0.1:$PORT/dsh-guard-restart/booted" 2>/dev/null | json_field booted)
    [ "$booted" = "true" ] && { log "page boot confirmed (booted=true)"; return 0; }
    sleep 2
  done
  log "no page confirmation within ${PAGE_WAIT_SEC}s — marking by port signal (headless boot?)"
  return 0
}

fail_boot() {
  guard incident --kind boot-failure
  echo ""
  echo "=================================================="
  echo " [dsh-guard-restart] DSH 守护启动失败"
  echo " 已回滚到最近良好快照；排查请查看："
  echo "   $LOG_DIR/ 下的 boot-*.log 与 incident-*.md"
  echo " 手动恢复：node $CLI rollback --good && node $CLI status"
  echo "=================================================="
  echo ""
}

log "=== boot guard start ==="
if healthy; then
  log "already healthy"
  set_status OK already-running
  exit 0
fi

PID=""
if ! PID=$(start_server) || [ -z "$PID" ]; then
  # Nothing was launched (no manifest + no dsh, or the manifest launcher
  # failed). Go straight to the failure path: no server, no rollback, no
  # half-started state, no crash.
  log "boot cannot proceed: server launch failed"
  set_status FAILED launch-failed
  fail_boot
  exit 1
fi
log "started server (pgid $PID)"
if wait_healthy "$FIRST_WAIT_SEC"; then
  log "boot ok on first attempt"
  set_status OK first-attempt
  # Phase 3（v3）：页面确认窗口 —— 崩溃标记(禁用重试) / /booted 确认 / headless 保底
  if finalize_boot "$PID"; then
    guard revive-coin --mark
  fi
  # Stay attached so launchers that kill the process group on window close
  # keep their close-to-quit semantics.  [local patch: systemd 下 viaShell=false
  # 时子进程非本 shell job，裸 wait 会立即返回；改为按 PID 轮询以保持附着]
  attach_loop "${ATTACH_PID:-$PID}"
  exit 0
fi
log "server unhealthy after ${FIRST_WAIT_SEC}s; stopping and rolling back"
stop_server "$PID"

guard rollback --good

PID2=$(start_server)
log "restarted server (pgid $PID2)"
if wait_healthy "$RETRY_WAIT_SEC"; then
  set_status OK rolled-back-retry
  if finalize_boot "$PID2"; then
    guard revive-coin --mark
  fi
  attach_loop "${ATTACH_PID:-$PID2}"
  exit 0
fi
stop_server "$PID2"
set_status FAILED boot-failed
fail_boot

if healthy; then
  attach_loop "$PID"
  exit 0
fi
exit 1
