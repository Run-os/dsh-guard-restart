# dsh-guard-restart（DSH 守护重启）

这是一个给 **DeepSeek Harness（DSH）** 使用的小插件。

它的作用是：**帮你安全地重启 DSH**。
如果重启后 DSH 没能正常起来，它会自动把配置恢复成上一次“能正常使用”的样子，尽量不让服务卡死或彻底打不开。

> 如果你完全不懂代码也没关系，按下面的说明操作即可。

---

## 1. 这个插件能帮你做什么？

- 在页面左侧边栏的 **「设置」那一行**，多出一个 **⟳ 小圆钮**。
- 点这个圆钮，再点“确定”，就能安全重启 DSH。
- 重启前会自动备份当前配置（我们叫它 **快照**，你可以理解成“还原点”）。
- 如果重启后启动失败，会自动把配置**还原到最近一次能用的状态**，然后再试一次。
- 如果页面加载插件时卡住或报错，会弹出 **恢复面板**，你可以手动停用“出问题的插件”再重启。
- 每次 DSH 启动后会自动检查保护工具是否齐全，缺了会自动补上，不需要你手动安装脚本。
- 如果你用的是 Linux + systemd，它还可以帮你设置**开机自启**。

---

## 2. 安装

在 DSH 所在机器的终端里执行：

```sh
# 方式 A：安装本机目录里的插件（适合目前这个项目）
dsh plugin --profile web add /root/deepseek/project/dsh-guard-restart

# 方式 B：以后发布到 npm 后，直接用包名安装
# dsh plugin --profile web add dsh-guard-restart
```

简单解释：

- `dsh plugin` 是 DSH 自带的“安装插件”命令。
- `--profile web` 表示装到名为 `web` 的配置环境里（一般默认就是它）。
- 安装完成后，需要重启 DSH 才会生效：

```sh
systemctl restart dsh-web
```

> 如果你没有使用 systemd，请参考后面的“常见问题”里的说明。

---

## 3. 怎么使用

1. 打开 DSH 网页。
2. 在左侧边栏找到 **设置** 那一行。
3. 在设置按钮旁边，有一个 **⟳ 小圆钮**。
4. 点击它，会弹出确认框，点 **确定**。
5. 页面会显示“正在重启”，等它自动刷新回来即可。

### 重启时会自动发生什么？

可以简单理解成：

1. 先记录“当前 DSH 是怎么启动的”和“当前配置备份”。
2. 开始重启 DSH。
3. 等服务起来后，检查页面能不能正常打开。
4. 如果一切正常，就把这次状态保存为新的“好状态”。
5. 如果启动失败，就自动把配置还原到上一次的好状态，再重启一次。
6. 如果还是失败，会在日志里留下原因，方便排查。

---

## 4. 页面卡住或报错时怎么办？

DSH 的页面加载插件时，偶尔会卡在 “Loading plugins…” 或显示 “Failed to load plugins”。

本插件会自动帮你处理一部分情况：

| 页面表现 | 插件会怎么做 |
| --- | --- |
| 显示“Failed to load plugins”，并且有报错信息 | 自动找出最可能是“罪魁祸首”的插件，先禁用它，再重启一次 |
| 一直转圈 “Loading plugins…”，没有任何报错 | 无法自动判断是谁的问题，会弹出恢复面板，让你手动选择禁用哪个插件，再点“重启 DSH” |
| 页面完全打不开，后台端口也不通 | 说明启动失败，自动回滚到最近一次能用的配置 |

**恢复面板怎么用？**

- 面板里会列出所有插件。
- 旁边有“启用 / 禁用”按钮。
- 你可以先禁用最近安装或升级过的插件，然后点“重启 DSH”。
- 如果禁用错了，重新打开面板再点“启用”即可。

---

## 5. 开机自启说明

- **systemd**：是 Linux 系统里负责“服务启动 / 崩溃后自动拉起”的常用工具。
- 本插件会自动生成一个叫 `dsh-web.service` 的服务文件，并设置开机自启。
- 如果你的 Linux 没有 systemd，本插件会尝试用 **cron**（定时任务）来实现开机运行。
- **macOS / Windows 暂不支持自动开机自启**，这不影响你手动使用重启按钮。

---

## 6. 常见问题（FAQ）

### 我安装后没看到那颗小圆钮？

先确认是否已经重启 DSH：

```sh
systemctl restart dsh-web
```

如果还是没有，可以到 **设置 → 插件 → 插件配置** 里看是否有“守护重启”卡片。

### “快照 / 回滚”是什么意思？

- **快照**：把当前配置文件复制一份保存起来，相当于“还原点”。
- **回滚**：出事之后，把配置文件恢复成某个还原点。

### 卸载这个插件会删掉我的配置吗？

不会。卸载插件不会改动你自己的 DSH 配置。
但插件生成的一些辅助文件不会自动删除，需要手动清理，见本文末尾。

### 卸载命令是什么？

```sh
dsh plugin --profile web remove dsh-guard-restart
systemctl restart dsh-web
```

---

## 7. 给想多了解一点的人

### 几个关键词的简单解释

| 名词 | 通俗解释 |
| --- | --- |
| **守护重启** | 不是直接“杀掉重启”，而是先备份、再启动、失败就自动还原 |
| **boot-guard** | 插件自带的安全启动脚本，负责“看着 DSH 启动，不行就还原” |
| **guard-cli** | 一个命令行小工具，负责备份、还原、启用/禁用插件 |
| **launch.json（启动清单）** | 记录“这次 DSH 是用什么命令启动的”，重启时照着原样拉起 |
| **systemd** | Linux 的“服务管家”，负责开机启动、崩溃后重新拉起 |
| **cron** | Linux 的“定时任务工具”，这里用来做开机运行 |
| **profile** | DSH 的一套独立配置环境，一般叫 `web` |
| **端口** | 程序对外提供网页服务的“门牌号”，默认是 `3080` |
| **同源保护** | 只有 DSH 自己的页面才能调用这些功能，防止外部网页乱操作 |

### 本插件主要包含哪些文件？

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 服务端入口：提供重启、状态查询、自动设置等接口 |
| `client/client.js` | 前端：小圆钮、看门狗、恢复面板 |
| `lib/guard-restart-helper.mjs` | 重启执行器：真正在后台执行重启动作 |
| `lib/assets/boot-guard.sh` | 安全启动脚本 |
| `lib/assets/run-dsh-web.sh` | 启动前清理端口，再进入安全启动 |
| `lib/assets/guard-cli.mjs` | 命令行工具：备份、还原、插件开关 |

### 环境变量（一般不用管，需要调整时再看）

| 环境变量 | 作用 |
| --- | --- |
| `DSH_GUARD_PROFILE` / `DSH_PROFILE` | 指定操作哪个 profile（默认 `web`） |
| `DSH_GUARD_PORT` / `DSH_WEB_PORT` | 指定 DSH 网页端口（默认 `3080`） |
| `DSH_GUARD_SYSTEMD_UNIT` | 指定 systemd 服务名（默认 `dsh-web.service`） |
| `DSH_GUARD_UNIT_DIR` | 指定 systemd 服务文件写入目录（一般测试才用） |
| `DSH_GUARD_PLATFORM` | 强制指定运行平台（systemd / cron / launchd / none） |
| `DSH_GUARD_PNPM` | 回滚时使用的 pnpm 命令（一般不用管） |
| `PAGE_WAIT_SEC` | 页面确认等待时间，默认 75 秒 |
| `FIRST_WAIT_SEC` / `RETRY_WAIT_SEC` | 启动健康检查等待时间，一般不用调 |

### 常用接口（给会调试的人）

| 接口 | 作用 |
| --- | --- |
| `GET /dsh-guard-restart/ping` | 查询当前是否已经重启完成 |
| `GET /dsh-guard-restart/status` | 查看当前保护状态 |
| `POST /dsh-guard-restart/restart` | 执行守护重启 |
| `POST /dsh-guard-restart/setup` | 手动补齐/升级保护文件 |
| `GET /dsh-guard-restart/plugins` | 查看插件列表 |
| `POST /dsh-guard-restart/plugin-set` | 启用/禁用插件 |
| `POST /dsh-guard-restart/plugin-stuck` | 页面卡住时上报 |
| `GET /dsh-guard-restart/loader-entries` | 查看插件注册名（调试用） |

### 日志在哪里？

- 启动和重启日志：`$DSH_HOME/guard/logs/`
- 里面主要有 `boot-*.log`、`server-*.log`、`restart-helper.log`、`incident-*.md`

### 一个常见故障修复记录（可跳过）

以前这个插件曾依赖另一个叫 `dsh-fuhuobi`（“复活币”）的插件。
从 v0.8.0 开始，重启相关的保护能力已经全部内置，不再需要装它。

---

## 8. 卸载后需要手动清理的文件

插件卸载时不会自动删除它生成的一些辅助文件。如果你确定不再需要，可以手动删除：

```sh
# 请把 $DSH_HOME 替换成你的实际目录，一般默认是 ~/.dsh
$DSH_HOME/boot-guard.sh
$DSH_HOME/run-dsh-web.sh
$DSH_HOME/guard/guard-cli.mjs
/etc/systemd/system/dsh-web.service
```

以及 crontab 里带 `# dsh-guard-restart` 标记的那一行。

> 注意：删除前请确认 DSH 已经不需要这些文件，否则可能影响以后的重启保护。

---

## License

MIT
