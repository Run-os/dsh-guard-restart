/**
 * dsh-guard-restart host entry —— 自带守护链的"一键守护重启"。
 *
 * 2026-09-11 起本插件不再安装 / 依赖 dsh-fuhuobi（复活币）。原先"重启要经
 * dsh-fuhuobi 的 boot-guard + guard-cli"的那部分代码已按需移植进本插件，
 * 现在整条链都是自带的：
 *
 *   1. 启动清单（移植自 dsh-fuhuobi 的 rebuildLaunch/writeLaunchManifest）：
 *      $DSH_HOME/guard/launch.json 记录"当前这个进程是怎么被拉起来的"
 *      （node + execArgv + entry 绝对路径 + 原样 argv + cwd）。boot-guard.sh
 *      按它原样重启，不猜路径 —— 这是"重启后 MODULE_NOT_FOUND / tsx 找不到"
 *      两个经典根因的修复。
 *   2. 自带守护链资产（setup 幂等安装到 $DSH_HOME，按版本标记自动升级）：
 *        $DSH_HOME/boot-guard.sh          守护启动：快照→启动→健康检查→失败回滚
 *        $DSH_HOME/run-dsh-web.sh         端口清理 + exec boot-guard
 *        $DSH_HOME/guard/guard-cli.js     自包含快照/回滚/存回滚快照 CLI
 *   3. HTTP 路由（同源校验）：
 *        GET  /dsh-guard-restart/ping     本次进程 boot id（客户端轮询刷新用）
 *        GET  /dsh-guard-restart/status   守护链 + systemd + 快照状态
 *        POST /dsh-guard-restart/booted   客户端渲染成功回执 → 刷新启动清单 + 存快照
 *        POST /dsh-guard-restart/restart  守护重启（?dryRun=1 只回报计划）
 *        POST /dsh-guard-restart/setup    幂等补齐/升级守护链
 *        POST /dsh-guard-restart/ensure-enabled  确保 systemd 单元开机自启
 *   4. 重启执行器（lib/guard-restart-helper.mjs，detached 存活于本进程之外）：
 *        systemd 托管 → systemd-run --scope 里跑 systemctl restart <unit>，
 *        helper 与 systemctl 都在单元 cgroup 之外，KillMode=control-group
 *        不会掐断重启作业；
 *        否则 → 杀掉本进程、等端口释放，再用 $DSH_HOME/boot-guard.sh 直启
 *        （移植自 dsh-fuhuobi 的 scheduleGuardedRestart 代理逻辑）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-guard-restart';

/** 本进程标识；boot id 变化 = 重启完成，客户端据此刷新页面。 */
const BOOT = `${process.pid}-${Date.now()}`;
const HELPER = fileURLToPath(new URL('./guard-restart-helper.mjs', import.meta.url));

/** Profile 检测支持 env 覆盖，插件可工作在本机之外的部署。 */
const PROFILE = process.env.DSH_GUARD_PROFILE || process.env.DSH_PROFILE || 'web';
const UNIT = process.env.DSH_GUARD_SYSTEMD_UNIT || 'dsh-web.service';
const UNIT_DIR = process.env.DSH_GUARD_UNIT_DIR || '/etc/systemd/system';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const PKG_JSON = path.join(PROFILE_DIR, 'package.json');

/** 守护链资产版本标记：文件里带上当前标记即视为最新，setup 不再改写。 */
const ASSET_MARKERS = {
    bootGuard: 'dsh-guard-restart-asset: boot-guard.sh v3',
    wrapper: 'dsh-guard-restart-asset: run-dsh-web.sh v2',
    cli: 'dsh-guard-restart-asset: guard-cli.mjs v4',
};
/** systemd 单元版本标记：文件带当前标记才视为最新，setup 才会跳过重写。 */
const UNIT_MARKER = 'dsh-guard-restart-unit: v1';

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}

function sameOrigin(request) {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin === undefined || host === undefined)
        return false;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// 启动清单（移植自 dsh-fuhuobi src/index.js：rebuildLaunch / writeLaunchManifest
// / dshHomeSafe）—— boot-guard.sh 靠它原样重启 DSH。
// ---------------------------------------------------------------------------

/** 环境变量里的 DSH_HOME，展开开头的 ~（与 boot-guard.sh 保持一致）。 */
function dshHomeSafe() {
    const base = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const raw = process.env.DSH_HOME;
    if (typeof raw === 'string' && raw.trim() !== '') {
        const h = raw.trim();
        if (h === '~')
            return base;
        if (h.startsWith('~/') || h.startsWith('~\\'))
            return base ? path.join(base, h.slice(2)) : '';
        return h;
    }
    return base ? path.join(base, '.dsh') : '';
}

/** 由当前进程的 argv/execArgv 还原"怎么再拉起一个我"：绝对入口 + 原样参数。 */
export function rebuildLaunch() {
    const entry = process.argv[1];
    if (typeof entry === 'string' && entry !== '' && !entry.startsWith('-')) {
        const abs = path.resolve(entry);
        if (fs.existsSync(abs)) {
            return {
                file: process.execPath,
                args: [...process.execArgv, abs, ...process.argv.slice(2)],
                entry: abs,
                cwd: process.cwd(),
                viaShell: false,
            };
        }
    }
    // 裸 dsh（.cmd shim），Windows 需要 shell 启动；默认进入 web 服务。
    return { file: 'dsh', args: ['web'], cwd: undefined, viaShell: process.platform === 'win32' };
}

/** 持久化启动清单：每次"确认可用"的启动都会覆盖刷新。 */
export function writeLaunchManifest(log) {
    try {
        const launch = rebuildLaunch();
        const home = dshHomeSafe();
        if (home === '')
            return null;
        const dir = path.join(home, 'guard');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'launch.json');
        const payload = {
            version: 2,
            file: launch.file,
            args: launch.args,
            entry: launch.entry ?? '',
            cwd: launch.cwd ?? process.cwd(),
            viaShell: launch.viaShell === true,
            dshHome: home,
            profile: PROFILE,
            port: PORT,
            writtenAt: new Date().toISOString(),
        };
        fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        log?.(`[dsh-guard-restart] launch manifest written: ${file}`);
        return payload;
    }
    catch (error) {
        log?.(`[dsh-guard-restart] launch manifest write failed: ${error?.message ?? error}`);
        return null;
    }
}

function readLaunchManifest() {
    const manifestPath = path.join(dshHomeSafe(), 'guard', 'launch.json');
    try {
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        return {
            path: manifestPath,
            present: true,
            entry: typeof parsed.entry === 'string' && parsed.entry !== ''
                ? parsed.entry
                : (Array.isArray(parsed.args)
                    ? parsed.args.find((a) => typeof a === 'string' && path.isAbsolute(a) && fs.existsSync(a)) ?? ''
                    : ''),
            writtenAt: typeof parsed.writtenAt === 'string' ? parsed.writtenAt : '',
            profile: typeof parsed.profile === 'string' ? parsed.profile : '',
        };
    }
    catch {
        return { path: manifestPath, present: false, entry: '', writtenAt: '', profile: '' };
    }
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

/** 端口：显式 --port argv > env > 3080（与 launch.json / 单元一致）。 */
function resolvePort() {
    const argv = process.argv;
    for (let i = 0; i < argv.length; i++) {
        let num = null;
        const eq = /^--port=(\d+)$/.exec(argv[i]);
        if (eq) {
            num = Number(eq[1]);
        }
        else if (argv[i] === '--port' && /^\d+$/.test(argv[i + 1] ?? '')) {
            num = Number(argv[i + 1]);
        }
        if (num !== null && num >= 1 && num <= 65535)
            return num;
    }
    const envPort = Number(process.env.DSH_GUARD_PORT || process.env.DSH_WEB_PORT || '');
    if (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535)
        return envPort;
    return 3080;
}

const PORT = resolvePort();

/** 文件是否已是最新版本资产（带当前版本标记）。 */
function assetUpToDate(file, marker) {
    try {
        return fs.readFileSync(file, 'utf8').includes(marker);
    }
    catch {
        return false;
    }
}

function snapshotState() {
    const root = path.join(DSH_HOME, 'rollbacks', PROFILE);
    let count = 0;
    let latest = null;
    let latestTime = '';
    try {
        const dirs = fs.readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort((a, b) => b.localeCompare(a));
        count = dirs.length;
        latest = dirs[0] ?? null;
        if (latest) {
            try {
                const m = JSON.parse(fs.readFileSync(path.join(root, latest, 'manifest.json'), 'utf8'));
                latestTime = typeof m.time === 'string' ? m.time : '';
            }
            catch { /* manifest 缺失时留空 */ }
        }
    }
    catch { /* 还没快照过 */ }
    let current = null;
    let previous = null;
    try {
        const coin = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'guard', 'revive-coin.json'), 'utf8'));
        current = typeof coin.current === 'string' && coin.current !== '' ? coin.current : null;
        previous = typeof coin.previous === 'string' && coin.previous !== '' ? coin.previous : null;
    }
    catch { /* 无回滚快照 */ }
    return { count, latest, latestTime, current, previous };
}

/** guard CLI 路径：优先 .mjs（强制 ESM），旧安装回退 .js。 */
function cliPaths() {
    return [
        path.join(DSH_HOME, 'guard', 'guard-cli.mjs'),
        path.join(DSH_HOME, 'guard', 'guard-cli.js'),
    ];
}
function resolveCliPath() {
    return cliPaths().find((p) => fs.existsSync(p)) ?? cliPaths()[0];
}

/** 守护链状态汇总（自带资产 + systemd + 快照）。 */
function guardState() {
    const bootGuardPath = path.join(DSH_HOME, 'boot-guard.sh');
    const wrapperPath = path.join(DSH_HOME, 'run-dsh-web.sh');
    const cliPath = resolveCliPath();
    const launch = readLaunchManifest();
    return {
        profile: PROFILE,
        bootGuard: {
            path: bootGuardPath,
            present: fs.existsSync(bootGuardPath),
            upToDate: assetUpToDate(bootGuardPath, ASSET_MARKERS.bootGuard),
        },
        wrapper: {
            path: wrapperPath,
            present: fs.existsSync(wrapperPath),
            upToDate: assetUpToDate(wrapperPath, ASSET_MARKERS.wrapper),
        },
        cli: {
            path: cliPath,
            present: fs.existsSync(cliPath),
            upToDate: assetUpToDate(cliPath, ASSET_MARKERS.cli),
        },
        launch: {
            path: launch.path,
            present: launch.present === true,
            writtenAt: launch.writtenAt,
            entry: launch.entry,
        },
        snapshot: snapshotState(),
    };
}

/** systemd 托管状态（开机自启 + 运行中）。 */
function systemdState() {
    const present = fs.existsSync(`/etc/systemd/system/${UNIT}`) || fs.existsSync('/run/systemd/system');
    let active = false;
    let enabled = false;
    try {
        active = spawnSync('systemctl', ['is-active', '--quiet', UNIT], { stdio: 'ignore' }).status === 0;
        enabled = spawnSync('systemctl', ['is-enabled', '--quiet', UNIT], { stdio: 'ignore' }).status === 0;
    }
    catch { /* leave booleans false */ }
    return { unit: UNIT, present, active, enabled };
}

/** 确保 systemd 单元开机自启（只 enable，绝不 start —— 本插件就跑在 web 进程里）。 */
function ensureEnabled(log) {
    const state = systemdState();
    if (!state.active && !state.present) {
        log(`[dsh-guard-restart] no systemd unit '${UNIT}' on this host; nothing to enable (boot-guard direct restart is used instead)`);
        return { state, action: 'none-human-run' };
    }
    try {
        const result = spawnSync('systemctl', ['enable', '--quiet', UNIT], { stdio: 'ignore' });
        if (result.status === 0)
            log(`[dsh-guard-restart] 'systemctl enable ${UNIT}' ok`);
        else
            log(`[dsh-guard-restart] 'systemctl enable ${UNIT}' exit=${result.status}`);
        return { state, action: 'enabled' };
    }
    catch (error) {
        log(`[dsh-guard-restart] 'systemctl enable ${UNIT}' failed: ${error.message}`);
        return { state, action: 'failed' };
    }
}

// ---------------------------------------------------------------------------
// 重启：detached helper（systemd 单元 或 自带 boot-guard 直启）
// ---------------------------------------------------------------------------

function relaunchSpec() {
    return rebuildLaunch();
}

function restartPlan() {
    const state = systemdState();
    const bootGuardPath = path.join(DSH_HOME, 'boot-guard.sh');
    const useSystemd = state.active && fs.existsSync(`/etc/systemd/system/${UNIT}`);
    return {
        mode: useSystemd ? 'systemd' : 'boot-guard',
        unit: useSystemd ? UNIT : null,
        bootGuard: fs.existsSync(bootGuardPath) ? bootGuardPath : null,
        port: PORT,
        relaunch: relaunchSpec(),
        systemd: state,
    };
}

/** 拉起 detached helper；本进程随后由 helper 杀掉 / 由 systemd 重启。 */
function spawnGuardRestart(log) {
    const plan = restartPlan();
    const helper = spawn(process.execPath, [
        HELPER,
        String(process.pid),
        JSON.stringify(plan.relaunch),
        plan.unit ?? 'none',
        plan.bootGuard ?? 'none',
        String(PORT),
        PROFILE,
        DSH_HOME,
    ], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
    });
    helper.unref();
    log(`[dsh-guard-restart] restart helper scheduled (mode=${plan.mode}, unit=${plan.unit ?? 'none'}, bootGuard=${plan.bootGuard ?? 'none'}, pid=${process.pid})`);
    return plan;
}

// ---------------------------------------------------------------------------
// 自动设置（Setup）：自带守护链的幂等安装 + 版本升级。
// 原则：
//   - 幂等：文件带当前版本标记 → no-op；旧版（含历史 dsh-fuhuobi 副本）先备份
//     .bak-<stamp> 再替换；绝不改动与本插件无关的文件；
//   - 不打断当前会话：setup 永远不 `systemctl start/restart`，只 enable；
//   - 无 systemd 的 Linux 回退 cron @reboot；macOS/Windows 记录为不支持。
// ---------------------------------------------------------------------------

/** 读取随包发布的资产。 */
function readAsset(asset) {
    return fs.readFileSync(fileURLToPath(new URL(`./assets/${asset}`, import.meta.url)), 'utf8');
}

/** 每次调用从环境读取配置（供子进程/测试以不同 env 做验证）。 */
function resolveSetupPort() {
    // 当前进程的端口已在模块加载时由 resolvePort() 解析，setup 必须与之一致。
    return PORT;
}

function resolveSetupCfg() {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return {
        dshHome,
        profile: process.env.DSH_GUARD_PROFILE || PROFILE,
        unit: process.env.DSH_GUARD_SYSTEMD_UNIT || UNIT,
        unitDir: process.env.DSH_GUARD_UNIT_DIR || UNIT_DIR,
        homeDir: os.homedir(),
        port: resolveSetupPort(),
        platform: (process.env.DSH_GUARD_PLATFORM && process.env.DSH_GUARD_PLATFORM !== 'auto')
            ? process.env.DSH_GUARD_PLATFORM
            : detectPlatform(),
        bootGuardPath: path.join(dshHome, 'boot-guard.sh'),
        wrapperPath: path.join(dshHome, 'run-dsh-web.sh'),
        cliPath: path.join(dshHome, 'guard', 'guard-cli.mjs'),
    };
}

function detectPlatform() {
    if (process.platform === 'linux' && (fs.existsSync('/run/systemd/system') || fs.existsSync('/etc/systemd/system')))
        return 'systemd';
    if (process.platform === 'linux')
        return 'cron';
    if (process.platform === 'darwin')
        return 'launchd';
    return 'none';
}

function unitUser() {
    try {
        if (typeof process.getuid === 'function' && process.getuid() === 0)
            return 'root';
        const user = os.userInfo().username;
        return user || 'root';
    }
    catch {
        return 'root';
    }
}

/** 渲染 systemd 单元（对齐本机已验证的 dsh-web.service 写法，路径参数化）。 */
export function renderUnit(cfg) {
    const user = unitUser();
    return `[Unit]
# ${UNIT_MARKER}
Description=DeepSeek Harness Web GUI (dsh --profile ${cfg.profile})
Documentation=http://127.0.0.1:${cfg.port ?? 3080}/
After=network-online.target
Wants=network-online.target
# 连续失败保护：包装脚本每次启动都会先清端口，正常不会连撞
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${path.dirname(cfg.dshHome)}
Environment=HOME=${cfg.homeDir}
Environment=DSH_HOME=${cfg.dshHome}
Environment=PROFILE=${cfg.profile}
Environment=DSH_PROFILE=${cfg.profile}
Environment=PORT=${cfg.port ?? 3080}
Environment=DSH_WEB_PORT=${cfg.port ?? 3080}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 包装脚本：先释放监听端口（默认 3080，可用 DSH_WEB_PORT 覆盖），再 exec 启动
# dsh。exec 保证 systemd 的 MainPID 就是真正的服务进程（PID 不分裂）；boot-guard
# 做快照 + 两阶段健康检查，失败自动回滚重试、成功自动存回滚快照。
ExecStart=${cfg.wrapperPath}

# systemd 按 cgroup 收尸：stop/restart 会杀掉本单元 cgroup 内所有进程，
# 因此自拉起的子进程也会被一并清掉 —— 这是 pm2 做不到、导致 EADDRINUSE
# 崩溃循环的地方。
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=20

Restart=always
RestartSec=3

StandardOutput=append:${cfg.dshHome}/logs/dsh-web.out.log
StandardError=append:${cfg.dshHome}/logs/dsh-web.err.log

[Install]
WantedBy=multi-user.target
`;
}

/** setup 需要落地的资产：{ key, path, asset, marker, mode }。 */
function setupAssets(cfg) {
    return [
        { key: 'bootGuard', file: cfg.bootGuardPath, asset: 'boot-guard.sh', marker: ASSET_MARKERS.bootGuard, mode: 0o755 },
        { key: 'wrapper', file: cfg.wrapperPath, asset: 'run-dsh-web.sh', marker: ASSET_MARKERS.wrapper, mode: 0o755 },
        { key: 'cli', file: cfg.cliPath, asset: 'guard-cli.mjs', marker: ASSET_MARKERS.cli, mode: 0o755 },
    ];
}

/** 纯状态汇总：守护链哪些部分已就绪（带版本标记才算就绪）。 */
export function setupPlan(cfg) {
    const present = {};
    const outdated = {};
    for (const a of setupAssets(cfg)) {
        const exists = fs.existsSync(a.file);
        const fresh = exists && assetUpToDate(a.file, a.marker);
        present[a.key] = fresh;
        outdated[a.key] = exists && !fresh;
    }
    const unitPath = path.join(cfg.unitDir, cfg.unit);
    const unitExists = fs.existsSync(unitPath);
    const unitFresh = unitExists && assetUpToDate(unitPath, UNIT_MARKER);
    present.unit = unitFresh;
    outdated.unit = unitExists && !unitFresh;
    const fullyReady = cfg.platform === 'systemd'
        ? (present.bootGuard && present.wrapper && present.cli && present.unit)
        : (present.bootGuard && present.wrapper && present.cli);
    return { platform: cfg.platform, unitDir: cfg.unitDir, unit: cfg.unit, present, outdated, fullyReady };
}

/** cron @reboot 回退（无 systemd 的 Linux）：以唯一标记幂等替换 crontab 行。 */
function cronSetup(cfg, dryRun) {
    const marker = '# dsh-guard-restart';
    const line = `@reboot env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=${cfg.homeDir} DSH_HOME=${cfg.dshHome} PROFILE=${cfg.profile} DSH_PROFILE=${cfg.profile} PORT=${cfg.port} DSH_WEB_PORT=${cfg.port} ${cfg.wrapperPath}`;
    try {
        const cur = spawnSync('crontab', ['-l'], { stdio: ['ignore', 'pipe', 'pipe'] });
        if (cur.error)
            return `unavailable: ${cur.error.message}`;
        const existing = cur.status === 0 ? cur.stdout.toString() : '';
        const kept = existing.split('\n').filter((l) => {
            const t = l.trim();
            return t !== marker && t !== line.trim();
        });
        const next = `\n${marker}\n${line}\n`;
        if (dryRun)
            return 'would-install';
        const r = spawnSync('crontab', ['-'], { input: `${kept.join('\n')}${next}`, stdio: ['pipe', 'ignore', 'pipe'] });
        if (r.error)
            return `unavailable: ${r.error.message}`;
        return r.status === 0 ? 'installed' : `failed(${r.status})`;
    }
    catch (error) {
        return `unavailable: ${error.message}`;
    }
}

/** 写一个资产：旧版先备份再替换；返回 'present' | 'written' | 'updated' | 'would-*'。 */
function provisionAsset(a, dryRun, log) {
    const exists = fs.existsSync(a.file);
    if (exists && assetUpToDate(a.file, a.marker))
        return 'present';
    if (dryRun)
        return exists ? 'would-update' : 'would-write';
    try {
        if (exists) {
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
            fs.copyFileSync(a.file, `${a.file}.bak-${stamp}`);
        }
        fs.mkdirSync(path.dirname(a.file), { recursive: true });
        fs.writeFileSync(a.file, readAsset(a.asset), { mode: a.mode });
        // writeFileSync 的 mode 只对新文件生效；覆盖旧文件后必须显式 chmod。
        fs.chmodSync(a.file, a.mode);
        log(`[dsh-guard-restart] setup ${exists ? 'updated' : 'wrote'} ${a.file}`);
        return exists ? 'updated' : 'written';
    }
    catch (error) {
        return `failed: ${error.message}`;
    }
}

/**
 * 自动设置守护链，返回结构化报告（也让 /status 与客户端直接展示）。
 * opts: { dryRun?: boolean } —— dryRun 只报告将要做什么，不写任何文件。
 */
export function runSetup(log, opts = {}) {
    const dryRun = opts.dryRun === true;
    const cfg = resolveSetupCfg();
    const report = { ok: false, dryRun, plan: setupPlan(cfg), actions: [], errors: [] };
    const record = (key, action) => report.actions.push({ key, action });

    // 1) 自带守护链资产（boot-guard.sh / run-dsh-web.sh / guard-cli.js）。
    for (const a of setupAssets(cfg)) {
        const action = provisionAsset(a, dryRun, log);
        record(a.key, action);
        if (typeof action === 'string' && action.startsWith('failed:'))
            report.errors.push(`${a.key}: ${action.slice(8)}`);
    }

    // 2) 平台注册。
    if (cfg.platform === 'systemd') {
        const unitPath = path.join(cfg.unitDir, cfg.unit);
        if (!report.plan.present.unit) {
            if (dryRun) {
                record('unit', report.plan.outdated.unit ? 'would-update' : 'would-write');
            }
            else {
                try {
                    if (report.plan.outdated.unit) {
                        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
                        fs.copyFileSync(unitPath, `${unitPath}.bak-${stamp}`);
                    }
                    // systemd 的 append: 重定向要求目录已存在。
                    fs.mkdirSync(path.join(cfg.dshHome, 'logs'), { recursive: true });
                    fs.mkdirSync(cfg.unitDir, { recursive: true });
                    fs.writeFileSync(unitPath, renderUnit(cfg), { mode: 0o644 });
                    const r = spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
                    const action = report.plan.outdated.unit ? 'updated' : 'written';
                    record('unit', `${action} (daemon-reload ${r.status})`);
                    log(`[dsh-guard-restart] setup ${action} ${unitPath}`);
                }
                catch (error) {
                    record('unit', `failed: ${error.message}`);
                    report.errors.push(`unit: ${error.message}`);
                }
            }
        }
        else {
            record('unit', 'present');
        }
        // enable —— 绝不 start：插件自身就运行在 web 进程里，start 会杀掉当前会话。
        const isEnabled = spawnSync('systemctl', ['is-enabled', '--quiet', cfg.unit], { stdio: 'ignore' }).status === 0;
        if (isEnabled) {
            record('enable', 'already');
        }
        else if (dryRun) {
            record('enable', 'would-enable');
        }
        else {
            const r = spawnSync('systemctl', ['enable', '--quiet', cfg.unit], { stdio: 'ignore' });
            if (r.error) {
                record('enable', `unavailable: ${r.error.message}`);
                report.errors.push(`enable: ${r.error.message}`);
            }
            else {
                record('enable', r.status === 0 ? 'enabled' : `failed(${r.status})`);
                log(`[dsh-guard-restart] setup 'systemctl enable ${cfg.unit}' exit=${r.status}`);
            }
        }
    }
    else if (cfg.platform === 'cron') {
        record('cron', dryRun ? cronSetup(cfg, true) : cronSetup(cfg, false));
    }
    else {
        record('platform', cfg.platform === 'launchd' ? 'unsupported (macOS launchd out of scope)' : cfg.platform);
    }

    report.plan = setupPlan(cfg); // 写完后重读
    report.ok = report.errors.length === 0 && report.plan.fullyReady;
    return report;
}

// ---------------------------------------------------------------------------
// v0.9.0 插件恢复面板的服务端支撑：清单 / 启用·禁用（cordis.patch.yml 层）
// 崩溃标记（client 看门狗 → boot-guard Phase 3）。与 guard-cli.js 保持同逻辑
// （host 是主要写入方；CLI 是 boot-guard 的独立写入方，bootId 校验在 CLI）。
// ---------------------------------------------------------------------------

/** 核心组件禁删名单（与 guard-cli 一致）：禁用会导致 dsh 本身起不来。 */
const BLOCKED_PLUGINS = new Set([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-client-modules',
    '@deepseek-ai/dsh-host-webserver',
    'dsh-guard-restart',
]);

/** 已实测确认 entryId（包名 → loader 注册名；patch 用注册名定位）。 */
const KNOWN_ENTRY_IDS = {
    '@deepseek-ai/dsh-host-webserver': 'webserver',
    '@deepseek-ai/dsh-web-app': 'web-app',
    'dsh-guard-restart': 'guard-restart',
};

const crashMarkerPath = () => path.join(DSH_HOME, 'guard', 'plugin-crash.json');
const enabledLedgerPath = () => path.join(DSH_HOME, 'guard', 'disabled-plugins.json');

/** 解析 profile 的 cordis.patch.yml：行数组 + `- id:` 块列表（含 disabled 状态）。 */
function parsePatchBlocks() {
    const file = path.join(PROFILE_DIR, 'cordis.patch.yml');
    if (!fs.existsSync(file))
        return { file, lines: [], blocks: [] };
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const blocks = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
        const m = /^-\s+id:\s*(\S+)/.exec(lines[i]);
        if (m) {
            if (cur)
                blocks.push(cur);
            cur = { id: m[1], start: i, end: i, disabled: false };
            continue;
        }
        if (cur) {
            cur.end = i;
            if (/^\s*disabled:\s*true/.test(lines[i]))
                cur.disabled = true;
        }
    }
    if (cur)
        blocks.push(cur);
    return { file, lines, blocks };
}

function resolveEntryIdHint(name) {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'guard', 'config.json'), 'utf8'));
        if (cfg.entryIds && typeof cfg.entryIds[name] === 'string')
            return cfg.entryIds[name];
    }
    catch { /* 无映射配置 */ }
    return KNOWN_ENTRY_IDS[name] ?? null;
}

/** 全部插件（dependencies + bundles）+ 启用状态 + 禁删标记。 */
function listPlugins() {
    let pkg = null;
    try {
        pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
    }
    catch {
        return { ok: false, error: `profile ${PROFILE} 没有可读 package.json`, plugins: [] };
    }
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const deps = Object.keys(pkg?.dependencies ?? {});
    const names = [...new Set([...bundles, ...deps])];
    const patch = parsePatchBlocks();
    const plugins = names.map((name) => {
        const entryId = resolveEntryIdHint(name) ?? name;
        const block = patch.blocks.find((b) => b.id === entryId);
        return {
            name,
            entryId,
            enabled: !(block && block.disabled),
            bundle: bundles.includes(name),
            blocked: BLOCKED_PLUGINS.has(name),
        };
    });
    return { ok: true, plugins };
}

/** 写 patch：启用/禁用一个插件（同名块处理 + 保留全部注释）。 */
function setPluginEnabled(name, enabled, reason) {
    if (BLOCKED_PLUGINS.has(name))
        return { ok: false, error: `${name} 是核心组件，拒绝禁用` };
    const entryId = resolveEntryIdHint(name) ?? name;
    const patch = parsePatchBlocks();
    const hit = patch.blocks.find((b) => b.id === entryId);
    const currentlyDisabled = Boolean(hit && hit.disabled);
    if (currentlyDisabled === !enabled)
        return { ok: true, already: true, entryId, enabled };
    let next = patch.lines.slice();
    if (enabled) {
        // 恢复：删除块内第一个 disabled: true 行
        for (let i = hit.start; i <= hit.end && i < next.length; i++) {
            if (/^\s*disabled:\s*true/.test(next[i])) {
                next.splice(i, 1);
                break;
            }
        }
    }
    else if (hit) {
        next.splice(hit.start + 1, 0, '  disabled: true');
    }
    else {
        if (next.length > 0 && next[next.length - 1] !== '')
            next.push('');
        next.push(`- id: ${entryId}`, '  disabled: true');
    }
    try {
        fs.mkdirSync(path.dirname(patch.file), { recursive: true });
        fs.writeFileSync(patch.file, next.join('\n').replace(/\n*$/, '\n'), 'utf8');
        // ledger（恢复 = 移除记录）
        let ledger = [];
        try {
            ledger = JSON.parse(fs.readFileSync(enabledLedgerPath(), 'utf8'));
            if (!Array.isArray(ledger))
                ledger = [];
        }
        catch { /* 首次 */ }
        ledger = enabled
            ? ledger.filter((l) => l.plugin !== name)
            : [...ledger, { plugin: name, entryId, at: new Date().toISOString(), reason: reason || 'manual' }];
        fs.mkdirSync(path.dirname(enabledLedgerPath()), { recursive: true });
        fs.writeFileSync(enabledLedgerPath(), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
        return { ok: true, entryId, enabled, action: enabled ? 'enabled' : 'disabled' };
    }
    catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
}

/** 尽力枚举 loader entry（诊断/校准 entryId 用；拿不到返回 null）。 */
function loaderEntryNames(hostCtx) {
    try {
        const loader = hostCtx.get('loader');
        const entries = typeof loader?.entries === 'function' ? loader.entries() : null;
        if (!entries)
            return null;
        const out = [];
        for (const e of entries)
            out.push({ name: e?.options?.name ?? '', disabled: Boolean(e?.disabled) });
        return out;
    }
    catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// 宿主插件
// ---------------------------------------------------------------------------

/**
 * 运行时解析 @deepseek-ai/schemastery（settings schema 用）。
 *
 * 2026-09-11 故障复盘根因修复：本插件常以 `link:` 方式安装（dsh plugin add
 * <本地目录>），而 link: 不会安装源目录自己的 dependencies。此前顶层
 * `import z from '@deepseek-ai/schemastery'` 导致 Node 从插件源码真实路径
 * 解析不到该包 → 插件树加载失败 → dsh 崩溃循环（全站不可用约 7 分钟）。
 *
 * 修复：不顶层 import，改为运行时用 createRequire 以 **profile 目录**为解析
 * 锚点同步解析；失败只降级为隐藏「设置-插件」卡片，其余功能一切照常。
 */
function resolveSchemastery() {
    try {
        const requireFromProfile = createRequire(path.join(PROFILE_DIR, 'package.json'));
        const mod = requireFromProfile('@deepseek-ai/schemastery');
        return (mod && mod.default) || mod || null;
    }
    catch (error) {
        console.log(`[dsh-guard-restart] schemastery 不可用，设置-插件卡片将隐藏: ${error?.message ?? error}`);
        return null;
    }
}

export function apply(ctx, config) {
    // 设置 > 插件：注册一个空 schema 的 settings namespace，让「守护重启」卡片
    // 出现在插件配置列表（机制同 dsh-fuhuobi：settings.register 建 namespace
    // → 设置-插件 tab 枚举 → client settings.plugin.item 卡片）。卡片内容
    // 只剩守护链 / systemd / 快照状态，均来自 /status 实时计算。
    ctx.inject(['settings'], (sctx) => {
        try {
            const z = resolveSchemastery();
            if (!z) {
                console.log('[dsh-guard-restart] settings 卡片降级（schemastery 解析失败），仅设置-插件菜单不可见');
                return;
            }
            sctx.settings.register(name, z.object({}), { base: {} });
            const llm = ctx.get('llm');
            if (llm !== undefined) {
                try {
                    // LlmConfigurableProvider 必填 provider/displayName/settingsNs/settingsPath。
                    llm.registerConfigurableProviders([{
                        provider: name,
                        displayName: '守护重启（dsh-guard-restart）',
                        settingsNs: name,
                        settingsPath: [],
                    }]);
                }
                catch (error) {
                    console.log(`[dsh-guard-restart] registerConfigurableProviders 失败（best effort）: ${error?.message ?? error}`);
                }
            }
            console.log(`[dsh-guard-restart] settings namespace '${name}' registered`);
        }
        catch (error) {
            console.log(`[dsh-guard-restart] settings namespace 注册失败（卡片隐藏，其余功能正常）: ${error?.message ?? error}`);
        }
    });

    ctx.inject(['webServer'], (hostCtx) => {
        const host = hostCtx;
        host.effect(() => {
            const log = (message) => {
                try { host.logger?.info?.(message); } catch { /* ignore */ }
                console.log(message);
            };
            // 本次进程已确认可用（客户端 root 槽渲染成功）→ 存回滚快照只做一次。
            let bootedOnce = false;
            const markBooted = (reason) => {
                // 启动清单每次回执都刷新（重启后命令可能变了）
                writeLaunchManifest(log);
                if (bootedOnce)
                    return;
                bootedOnce = true;
                try {
                    const cli = resolveCliPath();
                    if (!fs.existsSync(cli))
                        return;
                    const child = spawn(process.execPath, [cli, 'revive-coin', '--mark', '--profile', PROFILE], {
                        env: { ...process.env, DSH_HOME },
                        stdio: 'ignore',
                        detached: false,
                    });
                    child.on('error', (error) => log(`[dsh-guard-restart] revive-coin spawn failed: ${error.message}`));
                    child.on('exit', (code) => log(`[dsh-guard-restart] revive-coin (${reason}) exit=${code}`));
                    child.unref();
                }
                catch (error) {
                    log(`[dsh-guard-restart] revive-coin failed: ${error?.message ?? error}`);
                }
            };

            const disposers = [
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/ping',
                    handler: (request, response) => {
                        if (request.method !== 'GET') {
                            response.writeHead(405, { allow: 'GET' });
                            response.end();
                            return;
                        }
                        sendJson(response, 200, { ok: true, boot: BOOT });
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/status',
                    handler: (request, response) => {
                        if (request.method !== 'GET') {
                            response.writeHead(405, { allow: 'GET' });
                            response.end();
                            return;
                        }
                        const plan = setupPlan(resolveSetupCfg());
                        sendJson(response, 200, {
                            boot: BOOT,
                            guard: guardState(),
                            systemd: systemdState(),
                            setup: {
                                platform: plan.platform,
                                present: plan.present,
                                outdated: plan.outdated,
                                fullyReady: plan.fullyReady,
                            },
                            restart: restartPlan(),
                            guardedBoot: true,
                            restartVia: 'systemd 单元 / 自带 boot-guard（快照 → 健康检查 → 失败回滚）',
                        });
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/booted',
                    handler: (request, response) => {
                        if (request.method === 'POST') {
                            if (!sameOrigin(request)) {
                                sendJson(response, 403, { error: 'untrusted origin' });
                                return;
                            }
                            markBooted('client-booted');
                            sendJson(response, 200, { ok: true, booted: true, boot: BOOT });
                            return;
                        }
                        if (request.method === 'GET') {
                            sendJson(response, 200, { ok: true, booted: bootedOnce, boot: BOOT });
                            return;
                        }
                        response.writeHead(405, { allow: 'GET, POST' });
                        response.end();
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/ensure-enabled',
                    handler: (request, response) => {
                        if (request.method !== 'POST') {
                            response.writeHead(405, { allow: 'POST' });
                            response.end();
                            return;
                        }
                        if (!sameOrigin(request)) {
                            sendJson(response, 403, { error: 'untrusted origin' });
                            return;
                        }
                        sendJson(response, 200, { ...ensureEnabled(log), boot: BOOT });
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/plugins',
                    handler: (request, response) => {
                        if (request.method !== 'GET') {
                            response.writeHead(405, { allow: 'GET' });
                            response.end();
                            return;
                        }
                        sendJson(response, 200, { boot: BOOT, ...listPlugins() });
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/plugin-set',
                    handler: (request, response) => {
                        if (request.method !== 'POST') {
                            response.writeHead(405, { allow: 'POST' });
                            response.end();
                            return;
                        }
                        if (!sameOrigin(request)) {
                            sendJson(response, 403, { error: 'untrusted origin' });
                            return;
                        }
                        let body = {};
                        try {
                            body = JSON.parse(request.body ?? '{}');
                        }
                        catch { /* 空 body */ }
                        const name = typeof body.name === 'string' ? body.name : '';
                        const enabled = body.enabled === true;
                        if (!name) {
                            sendJson(response, 400, { error: 'missing plugin name' });
                            return;
                        }
                        const result = setPluginEnabled(name, enabled, 'panel');
                        if (!result.ok) {
                            sendJson(response, 200, { ok: false, error: result.error, boot: BOOT });
                            return;
                        }
                        log(`[dsh-guard-restart] plugin ${enabled ? 'enabled' : 'disabled'}: ${name} (entry ${result.entryId}) ${result.already ? '(already)' : ''}`);
                        sendJson(response, 200, { ok: true, boot: BOOT, ...result, plugins: listPlugins().plugins });
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/plugin-stuck',
                    handler: (request, response) => {
                        if (request.method !== 'POST') {
                            response.writeHead(405, { allow: 'POST' });
                            response.end();
                            return;
                        }
                        if (!sameOrigin(request)) {
                            sendJson(response, 403, { error: 'untrusted origin' });
                            return;
                        }
                        let body = {};
                        try {
                            body = JSON.parse(request.body ?? '{}');
                        }
                        catch { /* 空 body */ }
                        const phase = typeof body.phase === 'string' ? body.phase.slice(0, 16) : 'unknown';
                        const message = typeof body.message === 'string' ? body.message.slice(0, 4000) : '';
                        // 名字必须在 profile 依赖/bundle 清单里才有意义（防伪造/误判）
                        const knownNames = new Set(listPlugins().plugins.map((p) => p.name));
                        const names = (Array.isArray(body.names) ? body.names : [])
                            .filter((n) => typeof n === 'string' && knownNames.has(n))
                            .slice(0, 20);
                        // bootId 由宿主盖章（=本次进程），boot-guard 据此判断是否消费。
                        const marker = { bootId: BOOT, phase, names, message, ts: new Date().toISOString() };
                        try {
                            fs.mkdirSync(path.join(DSH_HOME, 'guard'), { recursive: true });
                            fs.writeFileSync(crashMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
                        }
                        catch (error) {
                            sendJson(response, 500, { error: `marker write failed: ${error?.message ?? error}` });
                            return;
                        }
                        log(`[dsh-guard-restart] page stuck reported: phase=${phase} names=${JSON.stringify(names)}`);
                        sendJson(response, 200, { ok: true, boot: BOOT, phase });
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/loader-entries',
                    handler: (request, response) => {
                        if (request.method !== 'GET') {
                            response.writeHead(405, { allow: 'GET' });
                            response.end();
                            return;
                        }
                        // 诊断用：校准 entryId 映射（KNOWN_ENTRY_IDS）的观察入口。
                        sendJson(response, 200, { boot: BOOT, entries: loaderEntryNames(hostCtx) });
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/setup',
                    handler: (request, response) => {
                        if (request.method !== 'POST') {
                            response.writeHead(405, { allow: 'POST' });
                            response.end();
                            return;
                        }
                        if (!sameOrigin(request)) {
                            sendJson(response, 403, { error: 'untrusted origin' });
                            return;
                        }
                        const dryRun = new URL(request.url, 'http://local').searchParams.get('dryRun') === '1';
                        sendJson(response, 200, runSetup(log, { dryRun }));
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/restart',
                    handler: (request, response) => {
                        if (request.method !== 'POST') {
                            response.writeHead(405, { allow: 'POST' });
                            response.end();
                            return;
                        }
                        if (!sameOrigin(request)) {
                            sendJson(response, 403, { error: 'untrusted origin' });
                            return;
                        }
                        // ?dryRun=1：只回报将要执行的守护重启计划，不真的重启（自检用）。
                        if (new URL(request.url, 'http://local').searchParams.get('dryRun') === '1') {
                            sendJson(response, 200, { ok: true, dryRun: true, plan: restartPlan(), boot: BOOT });
                            return;
                        }
                        try {
                            const plan = spawnGuardRestart(log);
                            sendJson(response, 200, { ok: true, mode: plan.mode, unit: plan.unit, boot: BOOT });
                        }
                        catch (error) {
                            log(`[dsh-guard-restart] failed to schedule guarded restart: ${error instanceof Error ? error.message : String(error)}`);
                            sendJson(response, 500, { error: 'failed to schedule restart' });
                        }
                    },
                }),
            ];

            // 启动清单：本进程已在运行 → 立刻落盘一份（重启链的前提）。
            writeLaunchManifest(log);

            // 自动补齐 / 升级守护链（幂等；全部就绪即 no-op）。
            const setupTimer = setTimeout(() => {
                const plan = setupPlan(resolveSetupCfg());
                if (plan.fullyReady)
                    return;
                const missing = Object.entries(plan.present).filter(([, v]) => !v).map(([k]) => k);
                log(`[dsh-guard-restart] auto-setup: not ready (${missing.join(', ') || 'enable'})`);
                const report = runSetup(log, {});
                log(`[dsh-guard-restart] auto-setup result ok=${report.ok} actions=${JSON.stringify(report.actions)}`);
            }, 6000);

            return () => {
                clearTimeout(setupTimer);
                for (const dispose of disposers)
                    dispose();
            };
        }, 'dsh-guard-restart: http routes + launch manifest');
    });
}

export { PORT as guardPort };
