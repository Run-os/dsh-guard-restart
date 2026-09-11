#!/bin/bash
# DSH Web GUI 启动包装脚本 —— systemd ExecStart / cron @reboot 统一入口。
# dsh-guard-restart-asset: run-dsh-web.sh v2
# 由 dsh-guard-restart 插件的 POST /dsh-guard-restart/setup 自动生成；
# 以本机人工验证过的版本为蓝本，仅将硬编码路径改为 $DSH_HOME 解析。
#
# 作用：
#   1) 启动前释放监听端口 —— 清掉包括"孤儿进程"在内的任何残留占用者，
#      杜绝 EADDRINUSE -> 无限重启 的崩溃循环；
#   2) 用 exec 启动本插件自带的 boot-guard（$DSH_HOME/boot-guard.sh）——
#      快照、两阶段健康检查、失败自动回滚重试、成功后自动存回滚快照。
#      整条守护链由 dsh-guard-restart 自带，不再需要 dsh-fuhuobi。
#
# 配置：端口默认 3080，可用 DSH_WEB_PORT 覆盖；DSH_HOME 默认 $HOME/.dsh
#       （systemd 单元已注入 DSH_HOME，cron 环境由 @reboot 行注入 HOME）。
set -u

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PORT="${DSH_WEB_PORT:-3080}"
LOG="$DSH_HOME/logs/run-dsh-web.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
mkdir -p "$DSH_HOME/guard/logs" 2>/dev/null || true

log() { printf '[%s] [run-dsh-web] %s\n' "$(date -Is)" "$*" >>"$LOG" 2>/dev/null || true; }

# 只匹配本端口（锚定结尾，避免 :3080 误配 :30801 之类）
port_pids() {
  ss -ltnp 2>/dev/null \
    | awk -v p=":$PORT" '$4 ~ (p "$")' \
    | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

kill_holders() {
  local sig="$1" pid
  for pid in $(port_pids); do
    [ "$pid" = "$$" ] && continue
    log "$sig -> pid $pid : $(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"
    kill "-$sig" "$pid" 2>/dev/null || true
  done
}

kill_holders TERM

# 等端口真正释放（最多 10 秒）
for _ in $(seq 1 20); do
  [ -z "$(port_pids)" ] && break
  sleep 0.5
done

# 还不放手就强杀，再观察 2 秒
if [ -n "$(port_pids)" ]; then
  log "port $PORT still held; escalating to SIGKILL"
  kill_holders KILL
  for _ in $(seq 1 8); do
    [ -z "$(port_pids)" ] && break
    sleep 0.25
  done
fi

if [ -n "$(port_pids)" ]; then
  log "WARNING: port $PORT still held by [$(port_pids | tr '\n' ' ')]; starting anyway"
else
  log "port $PORT free; exec boot-guard (this shell is replaced, PID preserved)"
fi

exec bash "$DSH_HOME/boot-guard.sh"