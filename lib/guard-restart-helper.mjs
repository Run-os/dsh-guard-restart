/**
 * Restart helper for dsh-guard-restart.
 *
 * Spawned by the host with `detached: true` so it survives however the server
 * dies. It waits ~1.6s for the HTTP 200 to flush to the browser, then restarts
 * DeepSeek Harness **through the dsh-fuhuobi guarded boot**:
 *
 *   - systemd-managed hosts: `systemctl restart <unit>` is run inside a
 *     transient systemd scope (`systemd-run --scope`). Running it in a scope
 *     keeps the helper (and the systemctl client) OUT of the unit's cgroup, so
 *     the unit's KillMode=control-group stop-kill cannot interrupt the restart
 *     job; `systemctl restart` waits for the whole guarded boot to finish. The
 *     unit's ExecStart is the run-dsh-web.sh -> boot-guard.sh chain, so the
 *     new boot does the two-phase health check, auto-rolls-back on failure and
 *     mints a revival coin on success.
 *   - otherwise: restart-fab-style fallback — kill this process and relaunch
 *     DSH with the exact same command line (no guard; documented).
 *
 * Usage: node guard-restart-helper.mjs <serverPid> <relaunchSpecJson> [unit]
 */
import { spawn, spawnSync } from 'node:child_process';

const [serverPid, specJson, unit] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Give the browser time to receive the 200 response before the host dies.
await sleep(1600);

let usedSystemd = false;
if (unit && unit !== 'none') {
    try {
        const result = spawnSync('systemd-run', [
            '--scope', '--quiet',
            '--unit', `dsh-guard-restart-${process.pid}`,
            'systemctl', 'restart', unit,
        ], { stdio: 'ignore', timeout: 5 * 60 * 1000 });
        // status 0 => the whole restart (incl. guarded boot) completed;
        // non-zero could mean the scope already existed or the restart failed —
        // fall through to the fallback so we never leave the host down.
        usedSystemd = result.status === 0;
    }
    catch {
        usedSystemd = false;
    }
}

if (usedSystemd) {
    process.exit(0);
}

// Fallback: kill this process and relaunch with the same command line.
const spec = JSON.parse(specJson);
try {
    process.kill(Number(serverPid), 'SIGTERM');
    await sleep(1200);
    try {
        process.kill(Number(serverPid), 0);
        process.kill(Number(serverPid), 'SIGKILL');
    }
    catch { /* already gone */ }
}
catch { /* already gone */ }
await sleep(400);
const child = spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
});
child.unref();
setTimeout(() => process.exit(0), 5 * 60 * 1000).unref();