# dsh-guard-restart

DSH 插件：**守护重启 + 复活币自愈**。

- 检测 `dsh-fuhuobi`（复活币）是否安装；缺失时自动执行 `dsh plugin --profile web add dsh-fuhuobi`（每次启动后 4s 自动检测一次，也提供手动按钮）。
- 在左侧边栏 **「设置」上方** 添加一行「守护重启」按钮（独占一行，不与 `dsh-cost-meter` 挤在同一行）。
- 重启走 **dsh-fuhuobi 的守护进程**：`systemctl restart dsh-web.service` → run-dsh-web.sh（清端口）→ boot-guard.sh（两阶段健康检查 → 失败自动回滚重试 → 成功自动铸复活币）。

## 安装

```sh
# 方式 A：本地目录（本机即 `/root/deepseek/project/system/dsh-guard-restart`）
dsh plugin --profile web add /root/deepseek/project/system/dsh-guard-restart

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
| `GET  /dsh-guard-restart/status` | `{ fuhuobi: {dep,bundle,installed}, systemd: {unit,present,active,enabled} }` |
| `POST /dsh-guard-restart/ensure-fuhuobi` | 缺失时后台执行 `dsh plugin --profile web add dsh-fuhuobi` |
| `POST /dsh-guard-restart/restart` | 守护重启（见下） |
| `POST /dsh-guard-restart/ensure-enabled` | `systemctl enable dsh-web.service`（开机自启） |

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
| 开机自启 | ❌ 不能纯靠插件 | DSH 没运行时插件不存在，无人执行它；必须由 systemd（或桌面启动器）拉起。本机 `dsh-web.service` 已 `enable`，开机自启由它负责。插件能做的只是**检查/确保**该 unit 已启用（`POST /ensure-enabled`）。 |
| 退出 DSH | ✅ 可发起 | 插件在宿主进程内：`process.exit()` 会触发 systemd `Restart=always` 再次拉起（等效重启）；要**真正停止**需外部 `systemctl stop dsh-web`（进程内的退出无法让监督者不再拉起）。 |
| 重启 DSH | ✅ 可发起且推荐守护方式 | 本插件即此：`systemctl restart`（走 boot-guard 守护启动，失败自动回滚、成功存复活币）；兜底为自拉起。 |
| 修复损坏配置 | ✅ 可 | 调 `dsh-fuhuobi revive-coin --use` / `rollback`（由 dsh-fuhuobi 提供）。 |

一句话：**自动启动交给 systemd，退出/重启由插件发起，失败自愈由 dsh-fuhuobi 守护完成** —— 三者组合即完整闭环。

## 环境适配

- `DSH_GUARD_PROFILE`（默认 `web`）：检测/安装 fuhuobi 的 profile。
- `DSH_GUARD_SYSTEMD_UNIT`（默认 `dsh-web.service`）：守护重启走哪个 systemd 单元。
- 依赖 `dsh` CLI 在 PATH 上（自动安装 fuhuobi 时用）。

## 卸载 / 回滚

```sh
dsh plugin --profile web remove dsh-guard-restart
systemctl restart dsh-web
```

无状态：不会改动 profile 配置；`ensure-fuhuobi` 只会安装（不会卸载）`dsh-fuhuobi`。
如果不再需要 fuhuobi 本身，另行 `dsh plugin --profile web remove dsh-fuhuobi`。

## License

MIT