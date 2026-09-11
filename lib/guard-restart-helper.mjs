/**
 * dsh-guard-restart 重启执行器（detached，存活于被重启进程之外）。
 *
 * 由宿主 `POST /dsh-guard-restart/restart` 以 detached 方式拉起；等 HTTP 200
 * 刷给浏览器后开始执行，两条路径（移植自 dsh-fuhuobi 的 scheduleGuardedRestart
 * 代理 + 本插件原有的 systemd 作用域方案）：
 *
 *   1. systemd 托管（首选）：在瞬时 systemd scope（`systemd-run --scope`）里跑
 *      `systemctl restart <unit>`。helper 与 systemctl 客户端都在单元 cgroup
 *      之外，单元的 KillMode=control-group 掐不断重启作业；`systemctl restart`
 *      会等到守护启动完成。单元 ExecStart 是 run-dsh-web.sh → boot-guard.sh，
 *      因此新启动自带快照 / 两阶段健康检查 / 失败回滚 / 成功存回滚快照。
 *      作用域方案失败时退化为普通 `systemctl restart`。
 *   2. 无 systemd（或 systemd 重启失败）：自带 boot-guard 直启 —— 杀掉旧进程、
 *      轮询等端口释放，再用 `$DSH_HOME/boot-guard.sh` 拉起新实例；boot-guard
 *      缺失时按原命令行原样重启（无守护，降级并在日志中注明）。
 *
 * 用法：
 *   node guard-restart-helper.mjs <serverPid> <relaunchSpecJson> \
 *        [unit|none] [bootGuardPath|none] [port] [profile] [dshHome]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [serverPid, specJson, unitArg, bootGuardArg, portArg, profileArg, dshHomeArg] =
    process.argv.slice(2);

const unit = unitArg && unitArg !== 'none' ? unitArg : null;
const bootGuard = bootGuardArg && bootGuardArg !== 'none' ? bootGuardArg : null;
const port = Number(portArg) || 3080;
const profile = profileArg || process.env.PROFILE || process.env.DSH_PROFILE || 'web';
const dshHome = dshHomeArg || process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function logLine(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
        const dir = path.join(dshHome, 'guard', 'logs');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'restart-helper.log'), line);
    }
    catch { /* 日志失败不影响重启 */ }
}

/** 端口是否已有进程在监听（新实例起来的判据）。 */
function listening() {
    return new Promise((resolve) => {
        const probe = net.connect({ host: '127.0.0.1', port });
        const done = (v) => {
            probe.destroy();
            resolve(v);
        };
        probe.on('connect', () => done(true));
        probe.on('error', () => done(false));
        setTimeout(() => done(false), 500);
    });
}

function unitActive(name) {
    try {
        return spawnSync('systemctl', ['is-active', '--quiet', name], { stdio: 'ignore' }).status === 0;
    }
    catch {
        return false;
    }
}

/** 首选：瞬时 scope 里重启 systemd 单元；失败退化为普通 restart。 */
async function restartViaSystemd() {
    if (unit === null)
        return false;
    try {
        const scoped = spawnSync('systemd-run', [
            '--scope', '--quiet',
            '--unit', `dsh-guard-restart-${process.pid}`,
            'systemctl', 'restart', unit,
        ], { stdio: 'ignore', timeout: 5 * 60 * 1000 });
        if (scoped.status === 0) {
            logLine(`systemd scope restart ok (unit=${unit})`);
            return true;
        }
        logLine(`systemd-run scope restart exit=${scoped.status} err=${scoped.error ? scoped.error.message : 'none'}; falling back to plain systemctl restart`);
    }
    catch (error) {
        logLine(`systemd-run failed: ${error.message}`);
    }
    try {
        const plain = spawnSync('systemctl', ['restart', unit], { stdio: 'ignore', timeout: 5 * 60 * 1000 });
        if (plain.status === 0 && unitActive(unit)) {
            logLine(`plain systemctl restart ok (unit=${unit})`);
            return true;
        }
        logLine(`plain systemctl restart exit=${plain.status} active=${unitActive(unit)}`);
    }
    catch (error) {
        logLine(`systemctl restart threw: ${error.message}`);
    }
    return false;
}

/** 结束旧服务进程；systemd 托管时先 stop，避免 Restart=always 与新实例打架。 */
async function stopOldServer() {
    if (unit !== null) {
        try {
            spawnSync('systemctl', ['stop', unit], { stdio: 'ignore', timeout: 60000 });
            logLine(`systemctl stop ${unit} (best effort before direct boot-guard)`);
        }
        catch { /* ignore */ }
    }
    const pid = Number(serverPid);
    if (!Number.isFinite(pid) || pid <= 0)
        return;
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch { /* 已经退出 */ }
    await sleep(1200);
    try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
    }
    catch { /* 已经退出 */ }
}

/** 等端口真正释放（最多 30s），避免新实例撞 EADDRINUSE。 */
async function waitPortFree(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await listening()))
            return true;
        await sleep(250);
    }
    return false;
}

/** 备用：boot-guard 直启；缺失时按原命令行重启。 */
async function directBootGuard(spec) {
    await stopOldServer();
    const free = await waitPortFree();
    logLine(`port ${port} ${free ? 'free' : 'still held after timeout'}; starting new instance`);
    await sleep(400);
    try {
        if (bootGuard !== null && fs.existsSync(bootGuard)) {
            const child = spawn('bash', [bootGuard], {
                cwd: path.dirname(bootGuard),
                env: { ...process.env, DSH_HOME: dshHome, PROFILE: profile, PORT: String(port) },
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            logLine(`started boot-guard: ${bootGuard}`);
        }
        else {
            const child = spawn(spec.file, spec.args ?? [], {
                cwd: spec.cwd,
                detached: process.platform !== 'win32',
                stdio: 'ignore',
                shell: spec.viaShell === true,
            });
            child.unref();
            logLine(`boot-guard missing; relaunched raw command ${spec.file} (unguarded fallback)`);
        }
    }
    catch (error) {
        logLine(`failed to start new instance: ${error.message}`);
    }
}

// 给 HTTP 200 一点时间刷到浏览器，再动手。
await sleep(1600);

let ok = false;
if (unit !== null) {
    ok = await restartViaSystemd();
    if (!ok)
        logLine('systemd restart path failed; falling back to boot-guard direct relaunch');
}

if (!ok) {
    let spec = {};
    try {
        spec = JSON.parse(specJson);
    }
    catch { /* 用默认 */ }
    await directBootGuard(spec);
}

setTimeout(() => process.exit(0), 3000).unref();
