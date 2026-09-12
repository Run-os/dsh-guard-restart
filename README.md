# dsh-guard-restart

DSH 插件：**守护重启（自带守护链，不再依赖 dsh-fuhuobi 复活币）**。

- 在左侧边栏 **「设置」行内**放一个「守护重启」小圆钮（⟳，与设置按钮同一行）。
- 在 **设置 → 插件** 界面新增「守护重启」菜单（卡片）：展示 **自带守护链状态**（boot-guard / guard-cli / 启动清单）、**systemd 配置状态** 与 **回滚快照**，每次打开/刷新实时读取 `/status`。
- 重启走 **插件自带的守护进程**：`systemctl restart dsh-web.service`（systemd 托管时）→ run-dsh-web.sh（清端口）→ boot-guard.sh（两阶段健康检查 → 失败自动回滚重试 → 成功自动存回滚快照）；无 systemd 时由重启执行器直启 boot-guard。
- 启动后 6s 自动自检守护链，**缺什么自动补什么 / 旧版自动升级**（boot-guard.sh / run-dsh-web.sh / guard/guard-cli.mjs / systemd 单元 / enable；无 systemd 时回退 cron `@reboot`）——幂等且不打断当前会话。
- **v0.7.0 起不再提供「侧边栏底部按钮各占一行」（`footerStack`）**：已迁移到 **dsh-eco-fixes**。

> **v0.8.0 变更（2026-09-11）**：不再安装 / 依赖 dsh-fuhuobi（复活币）。原版权
> 归属于 dsh-fuhuobi 的「重启部分」代码已移植进本插件：
> 启动清单（rebuildLaunch/writeLaunchManifest）、boot-guard.sh、guard-cli.js
> （快照/回滚/存回滚快照/事故报告，自包含仅用 node 内置模块）、守护重启代理
> （scheduleGuardedRestart + 客户端 /booted 回执）。整条 "重启 → 守护启动 →
> 失败回滚" 的链路本插件自己闭环。
>
> **v0.9.0 变更（2026-09-11）**：页面卡 "Loading plugins" 的自动/手动处置。
> - **失败态**（"Failed to load plugins" + 报错带插件名）：看门狗上报 → boot-guard
>   Phase 3 自动禁用元凶（`cordis.patch.yml` 追加 `disabled: true`，仅动这一个，
>   快照/回滚不受影响）→ 重启重试一次；仍失败则只提示不连禁。
> - **挂起态**（"Loading plugins…" 永久转圈，无报错）：无法定位元凶，**不自动
>   动作** —— 页面叠出**恢复面板**：全部插件清单 + 逐个「启用/禁用」切换 +
>   底部「重启 DSH」。
> - **存快照时机修正**：原来端口健康就存「良好快照」，升级→挂起会把坏状态抢先
>   登记成良好快照；v0.9.0 推迟到**页面确认可交互**（`/booted` 或确认窗口结束），
>   挂起/失败态不再覆盖回滚快照 → 手动回滚才能真正回到升级前版本。

## 安装

```sh
# 方式 A：本地目录（本机即 /root/deepseek/project/dsh-guard-restart）
dsh plugin --profile web add /root/deepseek/project/dsh-guard-restart

# 方式 B：发布到 npm 后
# dsh plugin --profile web add dsh-guard-restart
```

重启 DSH（`systemctl restart dsh-web`）后生效。

## 侧边栏位置说明 · 按钮在「设置」行内（v0.6.0 起）

- 本插件在 `sidebar.footer.action` 槽挂载 GuardRestartRow（React 生命周期载体，渲染为空）。
- **可见入口**：命令式注入 **`settingsArea`（设置行）内**的绝对定位小圆钮（28px，⟳ 刷新箭头，v0.7.3 由 ↻ 更换），与**设置按钮同一行**；**避让**同行 `[data-nio-rst]`（硬性重启钮）与 `[data-fuhuobi-rst]`（若仍装有 fuhuobi 的存币钮）。
- **保活**：`MutationObserver(document.body)` + head observer + 100ms 防抖 + 4s 心跳；reconcile **严格幂等**（条件不满足不写 DOM，收敛即静默），绝不修改其它插件 DOM。
- 交互：点按弹出锚定圆钮的确认 **Popover**（**确定 / 取消**），点「确定」才守护重启，
  点「取消」/ 点击外部 / Esc 关闭；重启期间全屏遮罩 + 轮询 `/ping` 自动刷新
  （boot id 变化即 reload；60s 未恢复提示手动刷新）。
- **客户端渲染回执**：组件挂载时 POST `/dsh-guard-restart/booted`，宿主据此刷新
  启动清单并存一枚回滚快照（移植自 dsh-fuhuobi 的 `/fuhuobi/api/booted`）。

> ⚠️ 历史教训（v0.5.0 / v0.5.1）：v0.5.0 用同一入口但 reconcile 每次无条件写 DOM 并
> 与页面其余 DOM 活动自激，实测导致 DSH 重启后端前端 splash 一直卡在
> "Loading plugins…"；v0.5.1 曾回退 footArea 行按钮；v0.6.0 回到设置行内圆钮。

## 服务端路由（同源保护）

| 路由 | 说明 |
| --- | --- |
| `GET  /dsh-guard-restart/ping` | 返回 `{boot}`，客户端轮询比对 boot id，变化即刷新 |
| `GET  /dsh-guard-restart/status` | `{ guard: {bootGuard,cli,launch,snapshot}, systemd, setup, restart }`，实时计算 |
| `POST /dsh-guard-restart/booted` | 客户端渲染成功回执 → 刷新启动清单 + 存回滚快照（每进程一次） |
| `POST /dsh-guard-restart/restart` | 守护重启（`?dryRun=1` 只回报计划，用于自检） |
| `POST /dsh-guard-restart/setup` | 自动设置 / 升级守护链（幂等；`?dryRun=1` 只报告不动手） |
| `POST /dsh-guard-restart/ensure-enabled` | `systemctl enable dsh-web.service`（开机自启） |
| `GET  /dsh-guard-restart/plugins` | v0.9.0：全部插件（dependencies+bundles）及启用/禁用/禁删状态 |
| `POST /dsh-guard-restart/plugin-set` | v0.9.0：切换某插件启用/禁用（写 `cordis.patch.yml` + ledger） |
| `POST /dsh-guard-restart/plugin-stuck` | v0.9.0：客户端看门狗上报页面加载报错/挂起（写崩溃标记） |
| `GET  /dsh-guard-restart/loader-entries` | v0.9.0：诊断用，枚举 loader entry（校准 entryId 映射） |

## 自动设置（Setup）

启动后 6s 自动自检一次；缺任何一环就补齐（也提供 `POST /dsh-guard-restart/setup`
手动触发，`?dryRun=1` 只返回报告不写任何文件）：

| 缺失 / 旧版项 | 动作 |
| --- | --- |
| `$DSH_HOME/boot-guard.sh` | 从随包资产 `lib/assets/boot-guard.sh` 写入（chmod 755）；旧版先备份 `.bak-<stamp>` 再替换 |
| `$DSH_HOME/run-dsh-web.sh` | 同上（清端口 → `exec boot-guard`） |
| `$DSH_HOME/guard/guard-cli.mjs` | 从随包资产 `lib/assets/guard-cli.mjs` 写入（自包含 CLI，chmod 755） |
| `/etc/systemd/system/dsh-web.service` | 按模板生成（Type=simple / KillMode=control-group / Restart=always / ExecStart=包装脚本），`daemon-reload` 后 `enable` |
| 无 systemd 的 Linux | 回退写 cron `@reboot` 条目（以 `# dsh-guard-restart` 标记幂等替换） |
| macOS / Windows | 记录为不支持（不在范围内） |

三条铁律：

1. **幂等**：资产带版本标记（`dsh-guard-restart-asset: <file> vN`）即视为最新 → no-op
   （零 systemctl 调用）；旧版（含历史 dsh-fuhuobi 副本）先备份再替换。
2. **不打断当前会话**：插件自身就跑在 dsh web 进程里，因此 setup **只 `enable`、绝不 `start/restart`**。
3. **绝不拖垮 dsh**：guard-cli.mjs 自包含（仅 node 内置模块），不依赖任何 profile 依赖。

## 设置 → 插件：守护重启菜单

宿主在启动时注册 `settings` namespace `dsh-guard-restart`（空 schema，仅用于让
卡片出现在列表），因此在 **设置 → 插件 → 插件配置** 列表中出现「守护重启」状态卡片。
卡片数据来自 `GET /dsh-guard-restart/status`（实时计算，非缓存）：

| 菜单内信息 | 数据来源 | 展示 |
| --- | --- | --- |
| systemd 配置状态 | `/status → systemd` | 单元名 + 已配置/未配置 · 运行中/未运行 · 开机自启/未设自启 |
| 守护链（自带） | `/status → guard` | boot-guard / guard-cli / 启动清单 三态徽章（就绪/待升级/缺失） |
| 回滚快照 | `/status → guard.snapshot` | 份数 + 当前回滚快照 stamp |
| 重启方式 | `/status → restart` | systemd 单元 / boot-guard 直启 |
| 守护链完整性 | `/status → setup.fullyReady` | 完整 ✓ / 有缺件（自动补齐） |

## 守护重启如何工作

1. 浏览器点圆钮，确认 Popover 里点「确定」→ `POST /restart`，宿主 spawn 一个 **detached** 的
   `lib/guard-restart-helper.mjs`（独立于本进程生命周期，存活于被重启进程之外）。
2. helper 等 1.6s（让 200 响应先送达浏览器）。
3. **systemd 托管时**：在**独立临时 scope**（`systemd-run --scope`）里执行
   `systemctl restart dsh-web.service` —— 与本单元 cgroup 隔离，stop 时的
   `KillMode=control-group` 不会打断重启任务；`systemctl restart` 会等整套守护
   启动完成才返回；scope 失败退化为普通 `systemctl restart`。
4. **无 systemd（或 systemd 重启失败）**：移植自 dsh-fuhuobi 的守护重启代理 ——
   杀掉旧进程 → 轮询等端口释放 → `bash $DSH_HOME/boot-guard.sh` 直启新实例
   （快照 → 健康检查 → 失败回滚 → 成功存回滚快照）；boot-guard 缺失时按原命令行
   原样重启（无守护，日志注明）。
5. 浏览器轮询 `/ping`，boot id 变化即 `location.reload()`；60s 未恢复提示手动刷新。
6. 重启过程与每次启动的守护链记录在 `$DSH_HOME/guard/logs/`
   （boot-*.log / server-*.log / restart-helper.log / incident-*.md）。

### boot-guard 三阶段（v0.9.0）

```
启动 DSH → ① 60s 端口健康？
  ├─ 否 → 杀进程 → guard rollback --good → 重启 → ② 30s 再试（不变）
  └─ 是 → ③ 页面确认窗口（PAGE_WAIT_SEC，默认 75s）：
            ├─ 崩溃标记(bootId 匹配)：
            │    ├─ 失败态(带插件名) → 自动禁用元凶 → 重启重试一次
            │    └─ 挂起态(无名字)   → 不自动动作（页面恢复面板人工处置）
            ├─ /booted=true → 页面确认可交互 → 存「良好快照」
            └─ 窗口耗尽（headless） → 按端口信号保底存快照
```

## 页面卡 "Loading plugins" 的自动处置（v0.9.0）

dsh 客户端的规则：任一插件客户端 entry 加载失败（并行 `Promise.all` 一个拒绝即全崩）
→ 页面停在 "Failed to load plugins"（**失败态**，报错带插件名）；若某个 entry 加载
永不返回，则永久转圈（**挂起态**，无任何报错）。两者都意味着应用未挂载、正常 GUI
不可用。处置：

| 状态 | 自动 | 手动 |
| --- | --- | --- |
| 失败态（有名字） | 看门狗上报 → boot-guard 自动禁用元凶（ patch `disabled: true`）→ 重启重试一次 | 恢复面板也可手动禁用/恢复 |
| 挂起态（无名字） | **不自动**（无法定位元凶） | 恢复面板：全部插件逐个启用/禁用 + 底部「重启 DSH」 |
| 端口都不通 | 整体回滚（原有逻辑，不变） | — |

- **看门狗**住在本插件 client（factory 物化即运行）：本插件 chunk 在并行 boot
  期间必然被加载（除非挂起/失败的就是核心包或本插件自己），所以即使页面没起来
  看门狗也活着，能检测 splash 三态、上报（`POST /plugin-stuck`）、并叠恢复面板。
- **禁用机制** = `cordis.patch.yml` 追加 `- id: <entryId>` + `disabled: true`
  （dsh-client-modules 扫描跳过 disabled entry，不进客户端 manifest）。不卸依赖、
  不动锁文件、可一键恢复（面板「启用」/ `guard plugin-enable` / 删行），配置文件
  本就是回滚快照的 5 个成员之一。ledger 在 `$DSH_HOME/guard/disabled-plugins.json`。
- **entryId ≠ 包名**：loader 按插件注册名定位（如 dsh-guard-restart → `guard-restart`、
  dsh-host-webserver → `webserver`），映射见代码 KNOWN_ENTRY_IDS / guard config
  `entryIds`（可用 `GET /loader-entries` 校准）。
- **安全铁律**：禁删名单（核心组件 + 本插件自己）；每次启动最多自动禁用 1 个；
  禁用后仍失败只提示不再连禁；挂起态永不自动禁用；`/plugin-stuck` 只接受存在于
  profile 依赖清单里的插件名。
- **前提**：本功能只依赖 loopback 的 303 cookie 流程（`curl -L` 带 cookie jar），
  不触碰 `healthy()` 的 Host 豁免，也不要求客户端上报鉴权。

**命令行参考**（`node $DSH_HOME/guard/guard-cli.mjs <cmd>`，任何时刻都可用）：

| 命令 | 作用 |
| --- | --- |
| `plugins` | 列出 profile 全部插件及启用状态（entryId 一并显示） |
| `plugin-disable <name> [--entry-id X] [--reason R]` | 禁用插件（自动拍了 pre-disable 快照） |
| `plugin-enable <name> [--entry-id X]` | 恢复插件 |
| `crash-check --boot <bootId>` | 读页面崩溃标记并给处置建议（boot-guard Phase 3 内部用） |

## 启动清单（guard/launch.json）

每次「确认可用」的启动（宿主启动 + 客户端 /booted 回执）都会把当前进程的启动方式
（node 绝对路径 + execArgv + entry + 原样 argv + cwd）写入
`$DSH_HOME/guard/launch.json`。boot-guard.sh 按它**原样**重启 DSH，不猜路径——
这是"重启后 MODULE_NOT_FOUND / tsx 找不到"两个经典根因的修复（移植自
dsh-fuhuobi 的 rebuildLaunch/writeLaunchManifest）。

## 关于“插件能否实现 DSH 的自动启动 / 退出重启”（FAQ）

| 诉求 | 插件能否做到 | 说明 |
| --- | --- | --- |
| 开机自启 | ✅ 可自动设置 | DSH 没运行时插件不存在，无法自己执行——但**守护链可以自动搭建**：`POST /setup` 或启动自检会生成 `dsh-web.service` 并 `enable`，开机拉起交给 systemd（或无 systemd 时的 cron `@reboot`）。前提是宿主有 systemd/cron。 |
| 退出 DSH | ✅ 可发起 | 插件在宿主进程内：`process.exit()` 会触发 systemd `Restart=always` 再次拉起（等效重启）；要**真正停止**需外部 `systemctl stop dsh-web`。 |
| 重启 DSH | ✅ 可发起且推荐守护方式 | 本插件即此：`systemctl restart`（走自带 boot-guard 守护启动，失败自动回滚、成功存回滚快照）；兜底为 boot-guard 直启 / 自拉起。 |
| 修复损坏配置 | ✅ 可 | 守护启动失败自动回滚到最近良好快照；亦可手动 `node $DSH_HOME/guard/guard-cli.mjs rollback --good`。 |

一句话：**自动启动交给 systemd，退出/重启由插件发起，失败自愈由自带守护链完成** —— 三者组合即完整闭环。

## 环境适配

- `DSH_GUARD_PROFILE` / `DSH_PROFILE`（默认 `web`）：快照 / 重启针对的 profile。
- `DSH_GUARD_SYSTEMD_UNIT`（默认 `dsh-web.service`）：守护重启走哪个 systemd 单元。
- `DSH_GUARD_UNIT_DIR`（默认 `/etc/systemd/system`）：setup 把单元写到哪个目录（测试用）。
- `DSH_GUARD_PLATFORM`（默认 `auto`）：强制平台判定（`systemd` / `cron` / `launchd` / `none`，测试用）。
- `DSH_GUARD_PNPM`：回滚时 pnpm install 的启动器覆盖（默认 PATH / harness 本地 .bin）。
- `PAGE_WAIT_SEC`（boot-guard 环境变量，默认 `75`）：Phase 3 页面确认窗口宽度；
  `FIRST_WAIT_SEC` / `RETRY_WAIT_SEC` 同理可调。

## 依赖与 link: 安装（2026-09-11 故障复盘）

本插件唯一外部依赖是 `@deepseek-ai/schemastery`（settings schema，仅用于把
「守护重启」卡片登记进 设置→插件），但**不依赖源目录的 node_modules**：

- 以 `dsh plugin add <本地目录>` 安装时生成的是 `link:` 依赖，**不会**安装
  源目录自己的 dependencies。曾因此故障：顶层 `import z from
  '@deepseek-ai/schemastery'` → link 目录解析不到 → 插件树加载失败 → dsh
  崩溃循环（全站不可用约 7 分钟，2026-09-11 03:29 CST 复盘）。
- **根因修复**：已移除顶层 import，改为运行时用 `createRequire` **以 profile
  目录为解析锚点**同步解析 schemastery。源目录有没有 node_modules 都不再影响
  插件加载；解析失败只降级隐藏「设置-插件」卡片，**绝不拖垮 dsh**。
- **v0.8.0 起运行时代码零顶层依赖**（node 内置模块 + 运行时 createRequire），
  `lib/assets/guard-cli.mjs` 完全自包含，可在 profile 依赖全坏时独立工作。
- 排查入口：宿主日志 `[dsh-guard-restart]` 前缀 + `$DSH_HOME/guard/logs/`。

## 卸载 / 回滚

```sh
dsh plugin --profile web remove dsh-guard-restart
systemctl restart dsh-web
```

无状态：不会改动 profile 配置。v0.8.0 起插件不再安装 / 卸载 dsh-fuhuobi；
若已不再需要 fuhuobi 本身，可另行 `dsh plugin --profile web remove dsh-fuhuobi`
（重启链已由本插件自带，不受影响）。
setup 生成的文件（`$DSH_HOME/boot-guard.sh`、`$DSH_HOME/run-dsh-web.sh`、
`$DSH_HOME/guard/guard-cli.mjs`、`/etc/systemd/system/dsh-web.service` 及 crontab
`# dsh-guard-restart` 行）不在插件卸载范围内，按需自行删除。

## License

MIT