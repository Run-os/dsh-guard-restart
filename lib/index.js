/**
 * dsh-guard-restart host entry.
 *
 * Responsibilities:
 *   1. Detect whether `dsh-fuhuobi` (复活币) is installed in the running
 *      profile; if missing, install it via `dsh plugin --profile web add
 *      dsh-fuhuobi` (once per process, shortly after boot + on demand).
 *   2. Expose small same-origin HTTP routes:
 *        GET  /dsh-guard-restart/ping     boot-id for the client's reload poll
 *        GET  /dsh-guard-restart/status   fuhuobi + systemd + setup state
 *        POST /dsh-guard-restart/setup    auto-provision the guard chain
 *        POST /dsh-guard-restart/ensure-fuhuobi   install on demand
 *        POST /dsh-guard-restart/restart  restart through the fuhuobi guard
 *        POST /dsh-guard-restart/ensure-enabled  make sure systemd unit is enabled
 *   3. `restart` spawns a detached helper (lib/guard-restart-helper.mjs) that
 *      waits for the HTTP 200 to flush, then runs `systemctl restart
 *      dsh-web.service` inside a transient systemd scope — the systemd unit
 *      boots through dsh-fuhuobi's boot-guard.sh (health check, auto rollback,
 *      revival-coin minting). When no systemd unit is present, it falls back
 *      to a restart-fab-style self-relaunch with the exact same command line.
 *   4. Auto-setup (POST /setup + boot self-heal): whenever a piece of the
 *      guard chain is missing (boot-guard.sh / run-dsh-web.sh / systemd unit),
 *      provision it from the bundled assets and enable the unit; on hosts
 *      without systemd, fall back to a cron @reboot entry. Idempotent, and
 *      never starts/stops the running session (enable-only).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-guard-restart';

/** Identifies this host process; the browser reloads when this changes. */
const BOOT = `${process.pid}-${Date.now()}`;
const HELPER = fileURLToPath(new URL('./guard-restart-helper.mjs', import.meta.url));
const FUHUOBI = 'dsh-fuhuobi';

/** Profile detection honours env overrides so the plugin works outside this box, too. */
const PROFILE = process.env.DSH_GUARD_PROFILE || 'web';
const UNIT = process.env.DSH_GUARD_SYSTEMD_UNIT || 'dsh-web.service';
const UNIT_DIR = process.env.DSH_GUARD_UNIT_DIR || '/etc/systemd/system';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const PKG_JSON = path.join(PROFILE_DIR, 'package.json');

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

/** True when dsh-fuhuobi is declared in package.json AND present in node_modules. */
function fuhuobiState() {
    try {
        const raw = fs.readFileSync(PKG_JSON, 'utf8');
        const pkg = JSON.parse(raw);
        const deps = Object.keys(pkg.dependencies || {});
        const bundles = (pkg.dsh?.profile?.bundles || []);
        const dep = deps.includes(FUHUOBI);
        const bundle = bundles.includes(FUHUOBI);
        const installed = fs.existsSync(path.join(PROFILE_DIR, 'node_modules', FUHUOBI));
        return { dep, bundle, installed };
    }
    catch (error) {
        return { dep: false, bundle: false, installed: false, error: String(error?.message ?? error) };
    }
}

/** systemd supervision state for the unit that boots DSH through boot-guard. */
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

/** One-shot install guard so concurrent requests never double-install. */
let installLock = false;
function ensureFuhuobi(log) {
    const state = fuhuobiState();
    if (state.installed && state.dep) {
        if (!state.bundle) log(`[dsh-guard-restart] ${FUHUOBI} installed but missing from dsh.profile.bundles; run 'dsh plugin --profile ${PROFILE} add ${FUHUOBI}' to repair`);
        return { state, action: 'none' };
    }
    if (installLock)
        return { state, action: 'already-running' };
    installLock = true;
    log(`[dsh-guard-restart] ${FUHUOBI} missing (dep=${state.dep} bundle=${state.bundle} installed=${state.installed}); installing`);
    const child = spawn('dsh', ['plugin', '--profile', PROFILE, 'add', FUHUOBI], {
        env: { ...process.env, DSH_HOME, PROFILE },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sink = [];
    child.stdout.on('data', (chunk) => sink.push(String(chunk)));
    child.stderr.on('data', (chunk) => sink.push(String(chunk)));
    child.on('error', (error) => {
        installLock = false;
        log(`[dsh-guard-restart] failed to spawn 'dsh plugin add ${FUHUOBI}': ${error.message}`);
    });
    child.on('exit', (code) => {
        installLock = false;
        log(`[dsh-guard-restart] 'dsh plugin add ${FUHUOBI}' exit=${code}\n${sink.join('').slice(0, 1500)}`);
    });
    return { state, action: 'started' };
}

/** Relaunch spec for the no-systemd fallback: replay this process's command line. */
function relaunchSpec() {
    return {
        file: process.execPath,
        args: [...process.execArgv, ...process.argv.slice(1)],
        cwd: process.cwd(),
    };
}

/** Spawn the detached restart helper; it survives however this process dies. */
function spawnGuardRestart(log) {
    const helper = spawn(process.execPath, [
        HELPER,
        String(process.pid),
        JSON.stringify(relaunchSpec()),
        UNIT,
    ], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
    });
    helper.unref();
    log(`[dsh-guard-restart] restart helper scheduled (unit=${UNIT}, pid=${process.pid})`);
}

/** Ensure the systemd unit that supervises DSH is enabled (开机自启). */
function ensureEnabled(log) {
    const state = systemdState();
    if (!state.active && !state.present) {
        log(`[dsh-guard-restart] no systemd unit '${UNIT}' on this host; nothing to enable (run DSH via boot-guard for guarded restarts)`);
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
// 自动设置（Setup）：对齐 dsh-daemon install 的"一键自动搭建守护链"。
// 原则：
//   - 幂等：只补缺失项，全部就绪即 no-op；
//   - 不打断当前会话：本插件运行在 dsh web 进程内，因此 setup 永远不会
//     `systemctl start/restart` —— 只 `enable`；正在手动运行的 web 保持原样，
//     下次重启 / 开机即进入守护链（或点一次"守护重启"按钮完成切换）；
//   - 无 systemd 的 Linux 回退 cron @reboot；macOS/Windows 记录为不支持。
// ---------------------------------------------------------------------------

/** 读取随包发布的资产（package.json files 含 lib，lib/assets 一并发布）。 */
function readAsset(name) {
    return fs.readFileSync(fileURLToPath(new URL(`./assets/${name}`, import.meta.url)), 'utf8');
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
# 做快照 + 两阶段健康检查，失败自动回滚重试、成功自动铸复活币。
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

/** 纯状态汇总：哪些守护链资产已就绪。 */
export function setupPlan(cfg) {
    const present = {
        bootGuard: fs.existsSync(cfg.bootGuardPath),
        wrapper: fs.existsSync(cfg.wrapperPath),
        unit: fs.existsSync(path.join(cfg.unitDir, cfg.unit)),
    };
    const fullyReady = cfg.platform === 'systemd'
        ? (present.bootGuard && present.wrapper && present.unit)
        : (present.bootGuard && present.wrapper);
    return { platform: cfg.platform, unitDir: cfg.unitDir, unit: cfg.unit, present, fullyReady };
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

/**
 * 自动设置守护链，返回结构化报告（也让 /status 与客户端直接展示）。
 * opts: { dryRun?: boolean } —— dryRun 只报告将要做什么，不写任何文件。
 */
export function runSetup(log, opts = {}) {
    const dryRun = opts.dryRun === true;
    const cfg = resolveSetupCfg();
    const report = { ok: false, dryRun, plan: setupPlan(cfg), actions: [], errors: [] };
    const record = (key, action) => report.actions.push({ key, action });

    // 1) 守护前提：确保 dsh-fuhuobi（复活币）可用（已有逻辑，安装锁防并发）。
    record('fuhuobi', ensureFuhuobi(log).action);

    // 2) 补齐 boot-guard / run-dsh-web.sh —— 只写缺失项，绝不覆盖在用的脚本。
    for (const [key, file, asset] of [
        ['bootGuard', cfg.bootGuardPath, 'boot-guard.sh'],
        ['wrapper', cfg.wrapperPath, 'run-dsh-web.sh'],
    ]) {
        if (report.plan.present[key]) {
            record(key, 'present');
            continue;
        }
        if (dryRun) {
            record(key, 'would-write');
            continue;
        }
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, readAsset(asset), { mode: 0o755 });
            record(key, 'written');
            log(`[dsh-guard-restart] setup wrote ${file}`);
        }
        catch (error) {
            record(key, `failed: ${error.message}`);
            report.errors.push(`${key}: ${error.message}`);
        }
    }

    // 3) 平台注册。
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

export function apply(ctx, config) {
    // 设置 > 插件 界面：注册一个 settings namespace，让「守护重启」卡片
    // 出现在插件配置列表（机制同 dsh-fuhuobi：settings.register 建 namespace
    // → 设置-插件 tab 枚举 namespace → client 侧 settings.plugin.item 卡片）。
    // 本插件不持久化任何配置字段，namespace 仅用于进入"可配置插件"名单；
    // 卡片内容（systemd / fuhuobi 状态）来自 /status 路由，实时计算。
    ctx.inject(['settings'], (sctx) => {
        try {
            sctx.settings.register(name, z.object({}), { base: {} });
            const llm = ctx.get('llm');
            if (llm !== undefined) {
                try {
                    llm.registerConfigurableProviders([{ provider: name, displayName: '守护重启（dsh-guard-restart）' }]);
                }
                catch { /* best effort */ }
            }
        }
        catch {
            // settings 服务不可用 —— 卡片不显示，守护重启功能不受影响
        }
    });

    ctx.inject(['webServer'], (hostCtx) => {
        const host = hostCtx;
        host.effect(() => {
            const log = (message) => {
                try { host.logger?.info?.(message); } catch { /* ignore */ }
                console.log(message);
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
                        sendJson(response, 200, {
                            boot: BOOT,
                            fuhuobi: fuhuobiState(),
                            systemd: systemdState(),
                            setup: (() => {
                                const s = setupPlan(resolveSetupCfg());
                                return { platform: s.platform, present: s.present, fullyReady: s.fullyReady };
                            })(),
                            guardedBoot: true,
                            restartVia: 'systemd + dsh-fuhuobi boot-guard',
                        });
                    },
                }),
                host.webServer.register({
                    kind: 'exact',
                    path: '/dsh-guard-restart/ensure-fuhuobi',
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
                        sendJson(response, 200, { ...ensureFuhuobi(log), boot: BOOT });
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
                        const report = runSetup(log, { dryRun });
                        sendJson(response, 200, report);
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
                        try {
                            spawnGuardRestart(log);
                            sendJson(response, 200, { ok: true, boot: BOOT });
                        }
                        catch (error) {
                            log(`[dsh-guard-restart] failed to schedule guarded restart: ${error instanceof Error ? error.message : String(error)}`);
                            sendJson(response, 500, { error: 'failed to schedule restart' });
                        }
                    },
                }),
            ];

            // Requirement 1: ensure fuhuobi once shortly after every boot.
            const timer = setTimeout(() => ensureFuhuobi(log), 4000);

            // Requirement 4: auto-setup the guard chain when pieces are missing
            // (idempotent; all-present => no-op, no systemctl calls).
            const setupTimer = setTimeout(() => {
                const plan = setupPlan(resolveSetupCfg());
                if (plan.fullyReady)
                    return;
                log(`[dsh-guard-restart] auto-setup: missing ${Object.entries(plan.present).filter(([, v]) => !v).map(([k]) => k).join(', ')}`);
                const report = runSetup(log, {});
                log(`[dsh-guard-restart] auto-setup result ok=${report.ok} actions=${JSON.stringify(report.actions)}`);
            }, 6000);

            return () => {
                clearTimeout(timer);
                clearTimeout(setupTimer);
                for (const dispose of disposers)
                    dispose();
            };
        }, 'dsh-guard-restart: http routes + fuhuobi ensure');
    });
}