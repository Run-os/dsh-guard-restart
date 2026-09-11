# dsh-guard-restart

DSH 插件：**守护重启 + 复活币自愈 + 自动设置守护链**。

- 检测 `dsh-fuhuobi`（复活币）是否安装；缺失时自动执行 `dsh plugin --profile web add dsh-fuhuobi`（每次启动后 4s 自动检测一次，也提供手动按钮）。
- 在左侧边栏 **「设置」行内**放一个「守护重启」小圆钮（与设置按钮同一行，参考 dsh-fuhuobi 的注入方式；不占用脚区独立行，不与其他插件按钮并排冲突）。
- 在 **设置 → 插件** 界面新增「守护重启」菜单（卡片）：展示 **当前 systemd 配置状态** 与 **dsh-fuhuobi 是否已安装**（含守护链完整性），每次打开/刷新实时读取 `/status`。
- 重启走 **dsh-fuhuobi 的守护进程**：`systemctl restart dsh-web.service` → run-dsh-web.sh（清端口）→ boot-guard.sh（两阶段健康检查 → 失败自动回滚重试 → 成功自动铸复活币）。
- **侧边栏底部按钮各占一行**（`footerStack`，**实验性，默认关闭**，可在 设置→插件「守护重启」卡片里开启）：尝试让 `sidebar.footer.action` 槽容器内的插件按钮各自独占一行，规避不同插件（如 `dsh-cost-meter` 徽章与 `dsh-auto-memory` 按钮）并排显示。⚠️ v0.4.0 曾默认开启并把容器改为纵向布局，实测会把位于第二行的 auto-memory 按钮**挤出可视区**（移除该 class 后按钮即恢复），因此改为默认关闭 + `flex-wrap` 温和实现。
- 启动后 4s 自动检测 fuhuobi、6s 自动自检守护链，**缺什么自动补什么**（boot-guard.sh / run-dsh-web.sh / systemd 单元 / enable；无 systemd 时回退 cron `@reboot`）——对齐 `dsh-daemon` 的 `install` 一键设置思路，幂等且不打断当前会话。

## 安装

```sh
# 方式 A：本地目录（本机即 `/root/deepseek/project/dsh-guard-restart`）
dsh plugin --profile web add /root/deepseek/project/dsh-guard-restart

# 方式 B：发布到 npm 后
# dsh plugin --profile web add dsh-guard-restart
```

重启 DSH（`systemctl restart dsh-web`）后生效。

## 侧边栏位置说明 · 按钮在「设置」行内（v0.6.0 起）

- 本插件在 `sidebar.footer.action` 槽只渲染**不可见锚点**（占位 + footerStack 开关需要其父容器引用）。
- **可见入口**：命令式注入 **`settingsArea`（设置行）内**的绝对定位小圆钮（28px，↻），与**设置按钮同一行**（参考 dsh-fuhuobi）；**避让**同行 `[data-nio-rst]`（硬性重启钮）与 `[data-fuhuobi-rst]`（dsh-fuhuobi 存币钮）。
- **保活**：`MutationObserver(document.body)` + head observer + 800ms 一次 + 3s 心跳（参考 dsh-fuhuobi 的 guarded-restart supervisor）；reconcile **严格幂等**（条件不满足不写 DOM，收敛即静默），绝不修改其它插件 DOM。
- 交互：缺 dsh-fuhuobi 时点按 = 自动安装；就绪后第一次点按进入确认态（红色 ✓，5 秒自动解除），再点一次才守护重启；重启期间全屏遮罩 + 轮询 `/ping` 自动刷新。

> ⚠️ 历史教训（v0.5.0 / v0.5.1）：v0.5.0 用同一入口但 reconcile 每次无条件写 DOM 并
> 与页面其余 DOM 活动自激，实测导致 DSH 重启后端前端 splash 一直卡在
> "Loading plugins…"（服务端正常、无报错）；v0.5.1 曾回退 footArea 行按钮。
> v0.6.0 回到设置行内圆钮，改用 fuhuobi 的幂等 supervisor 模式（同机制已在
> dsh-fuhuobi 长期稳定运行）。
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

## 设置 → 插件：守护重启菜单

宿主在启动时注册 `settings` namespace `dsh-guard-restart`（字段 `footerStack`，
机制同 dsh-fuhuobi），因此在 **设置 → 插件 → 插件配置** 列表中出现「守护重启」卡片。
卡片数据来自 `GET /dsh-guard-restart/status`（实时计算，非缓存）+ `footerStack` 开关（可编辑）：

| 菜单内信息 | 数据来源 | 展示 |
| --- | --- | --- |
| systemd 配置状态 | `/status → systemd` | 单元名 + 已配置/未配置 · 运行中/未运行 · 开机自启/未设自启 |
| fuhuobi 是否已安装 | `/status → fuhuobi` | 已安装/未安装 + `dep`/`bundle` 徽章 |
| （附加）守护链完整性 | `/status → setup.fullyReady` | 完整 ✓ / 有缺件（缺失自动补齐） |
| **侧边栏按钮各占一行**（开关） | settings `footerStack` | **默认关闭**（实验性）；开启后 `sidebar.footer.action` 槽容器内各插件按钮换行独占一行 |

卡片每次打开自动拉取一次，也可点「↻ 刷新」手动拉取（对应"自动检测"的可视化）。

### 插件安装 / 启动后会自动检测这两项信息吗？

**会。** 两条路径，双层保障：

1. **服务端自动检测（无需打开界面）**：每次 `dsh web` 启动后
   - **4s**：自动检测 fuhuobi 是否安装（缺失则自动 `dsh plugin add dsh-fuhuobi`）；
   - **6s**：自动检测守护链（systemd 单元等配置状态，缺失自动补齐）。
   - 日志在插件宿主日志（`[dsh-guard-restart]` 前缀）。
2. **界面实时检测**：每次打开/刷新「守护重启」卡片都实时请求 `/status`，
   两项信息均为**当前实时计算值**（`systemctl is-active/is-enabled` + profile 检查），
   不是启动时的缓存快照。

安装（`dsh plugin add`）本身不触发检测——插件进程不存在；检测在插件被加载的
**下一次 DSH 启动**时自动进行，也可通过卡片「↻ 刷新」随时手动触发。

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

## 依赖与 link: 安装（2026-09-11 故障复盘）

本插件唯一外部依赖是 `@deepseek-ai/schemastery`（settings schema，仅用于把
「守护重启」卡片登记进 设置→插件），但**不依赖源目录的 node_modules**：

- 以 `dsh plugin add <本地目录>` 安装时生成的是 `link:` 依赖，**不会**安装
  源目录自己的 dependencies。曾因此故障：顶层 `import z from
  '@deepseek-ai/schemastery'` → link 目录解析不到 → 插件树加载失败 → dsh
  崩溃循环（全站不可用约 7 分钟，2026-09-11 03:29 CST 复盘）。
- **根因修复**：已移除顶层 import，改为运行时用 `createRequire` **以 profile
  目录为解析锚点**同步解析 schemastery（dsh 生态 profile 的 node_modules
  自带该包，本机已验证 `@deepseek-ai/schemastery@3.18.2`）。源目录有没有
  node_modules 都不再影响插件加载；解析失败（低版本 Node 的 require(esm)
  限制等）只降级隐藏「设置-插件」卡片，**绝不拖垮 dsh**。
- `package.json` 仍声明该依赖（npm/registry 安装时由 pnpm 正常装上），
  `pnpm-lock.yaml` 一并提交以固定版本。
- 排查入口：宿主日志 `[dsh-guard-restart]` 前缀——settings 注册成功、
  降级原因、namespace 注册失败都会打日志。

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