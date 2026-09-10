# dsh-guard-restart

DSH 插件：**守护重启 + 复活币自愈 + 自动设置守护链**。

- 检测 `dsh-fuhuobi`（复活币）是否安装；缺失时自动执行 `dsh plugin --profile web add dsh-fuhuobi`（每次启动后 4s 自动检测一次，也提供手动按钮）。
- 在左侧边栏 **「设置」上方** 添加一行「守护重启」按钮（独占一行，不与 `dsh-cost-meter` 挤在同一行）。
- 重启走 **dsh-fuhuobi 的守护进程**：`systemctl restart dsh-web.service` → run-dsh-web.sh（清端口）→ boot-guard.sh（两阶段健康检查 → 失败自动回滚重试 → 成功自动铸复活币）。
- 启动后 6s 自检，**守护链缺什么自动补什么**（boot-guard.sh / run-dsh-web.sh / systemd 单元 / enable；无 systemd 时回退 cron `@reboot`）——对齐 `dsh-daemon` 的 `install` 一键设置思路，幂等且不打断当前会话。

## 安装

```sh
# 方式 A：本地目录（本机即 `/root/deepseek/project/dsh-guard-restart`）
dsh plugin --profile web add /root/deepseek/project/dsh-guard-restart

# 方式 B：发布到 npm 后
# dsh plugin --profile web add dsh-guard-restart
```

重启 DSH（`systemctl restart dsh-web`）后生效。

## 侧边栏位置说明

DSH 侧边栏底部（foot）是纵向布局：`sidebar.footer.action`（操作行，cost-meter 徽章所在）→ `sidebar.settings`（设置行）。
本插件先注册进 `sidebar.footer.action`（获得渲染生命周期），但在客户端只用它渲染一个**不可见锚点**，真正可见的按钮行
由命令式 DOM 创建并**插到脚区最前**（`footArea` 的第一个子元素）——因此最终行序为
**「守护重启行 → cost-meter 行 → 设置行」**：按钮独占 `dsh-cost-meter` 上方的一行，且完全不进入
footer-actions 容器（避免与 cost-meter 徽章争抢同一行，也避免与其内部的 MutationObserver 自排序逻辑相互干扰）。
折叠（rail）模式下显示为 ↻ 小圆钮。

## 服务端路由（同源保护）

| 路由 | 说明 |
| --- | --- |
| `GET  /dsh-guard-restart/ping` | 返回 `{boot}`，客户端轮询比对 boot id，变化即刷新 |
| `GET  /dsh-guard-restart/status` | `{ fuhuobi: {dep,bundle,installed}, systemd: {unit,present,active,enabled}, setup: {platform,present,fullyReady} }` |
| `POST /dsh-guard-restart/setup` | 自动设置守护链（幂等；`?dryRun=1` 只报告不动手，见下） |
| `POST /dsh-guard-restart/ensure-fuhuobi` | 缺失时后台执行 `dsh plugin --profile web add dsh-fuhuobi` |
| `POST /dsh-guard-restart/restart` | 守护重启（见下） |
| `POST /dsh-guard-restart/ensure-enabled` | `systemctl enable dsh-web.service`（开机自启） |

## 自动设置（Setup）——对齐 dsh-daemon 的 install

启动后 6s 自动自检一次；缺任何一环就补齐（也提供 `POST /dsh-guard-restart/setup`
手动触发，`?dryRun=1` 只返回报告不写任何文件）：

| 缺失项 | 动作 |
| --- | --- |
| `$DSH_HOME/boot-guard.sh` | 从随包资产 `lib/assets/boot-guard.sh` 补齐（systemd PID 轮询补丁版，chmod 755） |
| `$DSH_HOME/run-dsh-web.sh` | 从随包资产补齐（清端口 → `exec boot-guard`，chmod 755） |
| `/etc/systemd/system/dsh-web.service` | 按模板生成（Type=simple / KillMode=control-group / Restart=always / ExecStart=包装脚本），`systemctl daemon-reload` 后 `systemctl enable` |
| 无 systemd 的 Linux | 回退写 cron `@reboot` 条目（以 `# dsh-guard-restart` 标记幂等替换） |
| macOS / Windows | 记录为不支持（不在范围内） |

三条铁律：

1. **幂等**：全就绪即 no-op（零 systemctl 调用）；只补缺失项，绝不覆盖在用的脚本。
2. **不打断当前会话**：插件自身就跑在 dsh web 进程里，因此 setup **只 `enable`、绝不 `start/restart`**。
   正在手动运行的 web 保持原样；点一次「守护重启」按钮（或下次开机/重启）即进入守护链。
3. **先补复活币**：守护链的前提是 `dsh-fuhuobi` 可用（调用现有的 ensure-fuhuobi）。

单元未 enable 而已启用时只补上 enable；`/status` 的 `setup.fullyReady` 反映整条链是否完整。

## 守护重启如何工作

1. 浏览器点两次按钮确认 → `POST /restart`，宿主 spawn 一个 **detached** 的
   `lib/guard-restart-helper.mjs`（独立于本进程生命周期）。
2. helper 等 1.6s（让 200 响应先送达浏览器）。
3. 走 systemd 时：在**独立临时 scope**（`systemd-run --scope`）里执行
   `systemctl restart dsh-web.service` —— 与本单元 cgroup 隔离，stop 时的
   `KillMode=control-group` 不会打断重启任务；`systemctl restart` 会等整套守护启动完成才返回。
4. 非 systemd 环境（无该 unit）：退化为 restart-fab 式“自杀 + 相同命令行重拉”兜底（无守护/无回滚）。
5. 浏览器轮询 `/ping`，boot id 变化即 `location.reload()`；60s 未恢复提示手动刷新。

## 关于“插件能否实现 DSH 的自动启动 / 退出重启”（FAQ）

| 诉求 | 插件能否做到 | 说明 |
| --- | --- | --- |
| 开机自启 | ✅ 可自动设置 | DSH 没运行时插件不存在，无法自己执行——但**守护链可以自动搭建**：`POST /setup` 或启动自检会生成 `dsh-web.service` 并 `enable`，开机拉起交给 systemd（或无 systemd 时的 cron `@reboot`）。前提是宿主有 systemd/cron。 |
| 退出 DSH | ✅ 可发起 | 插件在宿主进程内：`process.exit()` 会触发 systemd `Restart=always` 再次拉起（等效重启）；要**真正停止**需外部 `systemctl stop dsh-web`（进程内的退出无法让监督者不再拉起）。 |
| 重启 DSH | ✅ 可发起且推荐守护方式 | 本插件即此：`systemctl restart`（走 boot-guard 守护启动，失败自动回滚、成功存复活币）；兜底为自拉起。 |
| 修复损坏配置 | ✅ 可 | 调 `dsh-fuhuobi revive-coin --use` / `rollback`（由 dsh-fuhuobi 提供）。 |

一句话：**自动启动交给 systemd，退出/重启由插件发起，失败自愈由 dsh-fuhuobi 守护完成** —— 三者组合即完整闭环。

## 环境适配

- `DSH_GUARD_PROFILE`（默认 `web`）：检测/安装 fuhuobi 的 profile。
- `DSH_GUARD_SYSTEMD_UNIT`（默认 `dsh-web.service`）：守护重启走哪个 systemd 单元。
- `DSH_GUARD_UNIT_DIR`（默认 `/etc/systemd/system`）：setup 把单元写到哪个目录（测试用）。
- `DSH_GUARD_PLATFORM`（默认 `auto`）：强制平台判定（`systemd` / `cron` / `launchd` / `none`，测试用）。
- 依赖 `dsh` CLI 在 PATH 上（自动安装 fuhuobi 时用）。

## 卸载 / 回滚

```sh
dsh plugin --profile web remove dsh-guard-restart
systemctl restart dsh-web
```

无状态：不会改动 profile 配置；`ensure-fuhuobi` 只会安装（不会卸载）`dsh-fuhuobi`。
如果不再需要 fuhuobi 本身，另行 `dsh plugin --profile web remove dsh-fuhuobi`。
setup 生成的文件（`$DSH_HOME/boot-guard.sh`、`$DSH_HOME/run-dsh-web.sh`、
`/etc/systemd/system/dsh-web.service` 及 crontab `# dsh-guard-restart` 行）不在插件卸载
范围内，按需自行删除。

## License

MIT