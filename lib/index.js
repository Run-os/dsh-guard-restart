/**
 * dsh-guard-restart host entry.
 *
 * Responsibilities:
 *   1. Detect whether `dsh-fuhuobi` (复活币) is installed in the running
 *      profile; if missing, install it via `dsh plugin --profile web add
 *      dsh-fuhuobi` (once per process, shortly after boot + on demand).
 *   2. Expose small same-origin HTTP routes:
 *        GET  /dsh-guard-restart/ping     boot-id for the client's reload poll
 *        GET  /dsh-guard-restart/status   fuhuobi + systemd supervision state
 *        POST /dsh-guard-restart/ensure-fuhuobi   install on demand
 *        POST /dsh-guard-restart/restart  restart through the fuhuobi guard
 *        POST /dsh-guard-restart/ensure-enabled  make sure systemd unit is enabled
 *   3. `restart` spawns a detached helper (lib/guard-restart-helper.mjs) that
 *      waits for the HTTP 200 to flush, then runs `systemctl restart
 *      dsh-web.service` inside a transient systemd scope — the systemd unit
 *      boots through dsh-fuhuobi's boot-guard.sh (health check, auto rollback,
 *      revival-coin minting). When no systemd unit is present, it falls back
 *      to a restart-fab-style self-relaunch with the exact same command line.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-guard-restart';

/** Identifies this host process; the browser reloads when this changes. */
const BOOT = `${process.pid}-${Date.now()}`;
const HELPER = fileURLToPath(new URL('./guard-restart-helper.mjs', import.meta.url));
const FUHUOBI = 'dsh-fuhuobi';

/** Profile detection honours env overrides so the plugin works outside this box, too. */
const PROFILE = process.env.DSH_GUARD_PROFILE || 'web';
const UNIT = process.env.DSH_GUARD_SYSTEMD_UNIT || 'dsh-web.service';
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

export function apply(ctx, config) {
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

            return () => {
                clearTimeout(timer);
                for (const dispose of disposers)
                    dispose();
            };
        }, 'dsh-guard-restart: http routes + fuhuobi ensure');
    });
}