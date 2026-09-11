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
    bootGuard: 'dsh-guard-restart-asset: boot-guard.sh v2',
    wrapper: 'dsh-guard-restart-asset: run-dsh-web.sh v2',
    cli: 'dsh-guard-restart-asset: guard-cli.js v2',
};

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
                cwd: path.dirname(abs),
                viaShell: false,
            };
        }
    }
    // 裸 dsh（.cmd shim），Windows 需要 shell 启动
    return { file: 'dsh', args: [], cwd: undefined, viaShell: process.platform === 'win32' };
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
            version: 1,
            file: launch.file,
            args: launch.args,
            cwd: launch.cwd ?? process.cwd(),
            viaShell: launch.viaShell === true,
            dshHome: home,
            profile: PROFILE,
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
            entry: Array.isArray(parsed.args) && parsed.args.length > 0 ? String(parsed.args[0]) : '',
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
    for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === '--port' && /^\d+$/.test(argv[i + 1] ?? ''))
            return Number(argv[i + 1]);
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

/** 守护链状态汇总（自带资产 + systemd + 快照）。 */
function guardState() {
    const bootGuardPath = path.join(DSH_HOME, 'boot-guard.sh');
    const wrapperPath = path.join(DSH_HOME, 'run-dsh-web.sh');
    const cliPath = path.join(DSH_HOME, 'guard', 'guard-cli.js');
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
function resolveSetupCfg() {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return {
        dshHome,
        profile: process.env.DSH_GUARD_PROFILE || PROFILE,
        unit: process.env.DSH_GUARD_SYSTEMD_UNIT || UNIT,
        unitDir: process.env.DSH_GUARD_UNIT_DIR || UNIT_DIR,
        homeDir: os.homedir(),
        platform: (process.env.DSH_GUARD_PLATFORM && process.env.DSH_GUARD_PLATFORM !== 'auto')
            ? process.env.DSH_GUARD_PLATFORM
            : detectPlatform(),
        bootGuardPath: path.join(dshHome, 'boot-guard.sh'),
        wrapperPath: path.join(dshHome, 'run-dsh-web.sh'),
        cliPath: path.join(dshHome, 'guard', 'guard-cli.js'),
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
Description=DeepSeek Harness Web GUI (dsh --profile ${cfg.profile})
Documentation=http://127.0.0.1:3080/
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
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 包装脚本：先释放 3080（清掉包括孤儿在内的残留占用者），再 exec 启动 dsh。
# exec 保证 systemd 的 MainPID 就是真正的服务进程（PID 不分裂）；boot-guard
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
        { key: 'cli', file: cfg.cliPath, asset: 'guard-cli.js', marker: ASSET_MARKERS.cli, mode: 0o755 },
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
    present.unit = fs.existsSync(path.join(cfg.unitDir, cfg.unit));
    outdated.unit = false;
    const fullyReady = cfg.platform === 'systemd'
        ? (present.bootGuard && present.wrapper && present.cli && present.unit)
        : (present.bootGuard && present.wrapper && present.cli);
    return { platform: cfg.platform, unitDir: cfg.unitDir, unit: cfg.unit, present, outdated, fullyReady };
}

/** cron @reboot 回退（无 systemd 的 Linux）：以唯一标记幂等替换 crontab 行。 */
function cronSetup(cfg, dryRun) {
    const marker = '# dsh-guard-restart';
    const line = `@reboot env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=${cfg.homeDir} DSH_HOME=${cfg.dshHome} ${cfg.wrapperPath}`;
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
        if (!report.plan.present.unit) {
            if (dryRun) {
                record('unit', 'would-write');
            }
            else {
                try {
                    fs.mkdirSync(cfg.unitDir, { recursive: true });
                    fs.writeFileSync(path.join(cfg.unitDir, cfg.unit), renderUnit(cfg), { mode: 0o644 });
                    const r = spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
                    record('unit', `written (daemon-reload ${r.status})`);
                    log(`[dsh-guard-restart] setup wrote ${path.join(cfg.unitDir, cfg.unit)}`);
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
        if (isEnabled && report.plan.present.unit) {
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
                    const cli = path.join(DSH_HOME, 'guard', 'guard-cli.js');
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
