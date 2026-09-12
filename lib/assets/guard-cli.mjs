#!/usr/bin/env node
// dsh-guard-restart — 守护启动配套 CLI（自包含：只依赖 node 内置模块）。
// dsh-guard-restart-asset: guard-cli.mjs v4
//
// 注意：扩展名必须是 .mjs —— ESM 语法不被宿主目录树上的任意 package.json
// 干扰（例如 DSH_HOME 落在有 package.json 的目录下时，.js 会被当 CommonJS，
// import 直接 SyntaxError；实测 /tmp/package.json 即可触发）。
//
// 由 $DSH_HOME/boot-guard.sh 在每次守护启动时调用，也供人工排查：
//   revive-coin --mark              启动成功 → 存一枚回滚快照（三级旋转，最多 2 枚）
//   rollback --good                 启动失败 → 回滚到最近"良好"快照
//   incident --kind boot-failure    写事故报告 + 待处理标记
//   plugin-disable <name>           禁用插件（cordis.patch.yml 加 disabled:true）
//   plugin-enable  <name>           恢复插件（去掉对应 disabled:true）
//   plugins                         列出 profile 全部插件 + 启用状态
//   crash-check --boot <id>         读页面崩溃标记并给出处置建议（boot-guard 用）
//   snapshot / list / health / status / profiles / keep
//
// 代码来源（2026-09-11）：由 dsh-fuhuobi 的快照/回滚/存币引擎（src/engine.js +
// src/incident.js + scripts/guard-cli.js）按"只为守护重启服务"裁剪移植，去掉
// 复活币桌面快捷方式/图标/插件隔离（quarantine，依赖 js-yaml）等与重启无关的
// 部分，保证在 link: 安装、profile 依赖缺失时也能独立运行。
//
// 状态目录（与插件进程共享）：
//   $DSH_HOME/rollbacks/<profile>/<stamp>/  快照（SNAPSHOT_FILES + manifest.json）
//   $DSH_HOME/guard/revive-coin.json        当前/前次回滚快照 stamp
//   $DSH_HOME/guard/config.json             保留份数 / 端口
//   $DSH_HOME/guard/logs/                   启动/服务日志、事故报告
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const DEFAULT_PORT = 3080;
const DEFAULT_KEEP_SNAPSHOTS = 10;
const MIN_KEEP_SNAPSHOTS = 2;
const MAX_KEEP_SNAPSHOTS = 100;
const DEFAULT_KEEP_LOGS = 30;

/** 每个快照捕获的安装状态元数据（与 dsh-fuhuobi 保持同一集合）。 */
const SNAPSHOT_FILES = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'cordis.yml',
    'cordis.patch.yml',
];

const isWin = () => process.platform === 'win32';

// ── layout ─────────────────────────────────────────────────────────────────
function dshHome() {
    const env = process.env.DSH_HOME;
    if (typeof env === 'string' && env.trim() !== '') {
        let h = env.trim();
        if (h === '~')
            return os.homedir();
        if (h.startsWith('~/') || h.startsWith('~\\'))
            h = path.join(os.homedir(), h.slice(2));
        return path.resolve(h);
    }
    return path.join(os.homedir(), '.dsh');
}
const profilesDir = () => path.join(dshHome(), 'profiles');
const profileDir = (profile) => path.join(profilesDir(), profile);
const rollbacksRoot = (profile) => path.join(dshHome(), 'rollbacks', profile);
const guardDir = () => path.join(dshHome(), 'guard');
const guardLogsDir = () => path.join(guardDir(), 'logs');
const guardConfigPath = () => path.join(guardDir(), 'config.json');
const reviveCoinPath = () => path.join(guardDir(), 'revive-coin.json');
const pendingMarkerPath = () => path.join(guardDir(), 'pending-incident.json');

// ── config ─────────────────────────────────────────────────────────────────
function readGuardConfig() {
    let raw = null;
    try {
        raw = JSON.parse(fs.readFileSync(guardConfigPath(), 'utf8'));
    }
    catch { /* defaults */ }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        raw = {};
    const out = { ...raw, keepSnapshots: DEFAULT_KEEP_SNAPSHOTS, port: DEFAULT_PORT };
    const n = Math.floor(Number(raw.keepSnapshots));
    if (Number.isFinite(n) && n >= MIN_KEEP_SNAPSHOTS && n <= MAX_KEEP_SNAPSHOTS)
        out.keepSnapshots = n;
    const p = Math.floor(Number(raw.port));
    if (Number.isFinite(p) && p >= 1 && p <= 65535)
        out.port = p;
    return out;
}
const resolveGuardPort = () => readGuardConfig().port;
const resolveKeepSnapshots = () => readGuardConfig().keepSnapshots;

function writeGuardConfig(cfg) {
    fs.mkdirSync(guardDir(), { recursive: true });
    fs.writeFileSync(guardConfigPath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}
function setKeepSnapshots(n) {
    const num = Math.max(MIN_KEEP_SNAPSHOTS, Math.min(MAX_KEEP_SNAPSHOTS, Math.floor(Number(n) || DEFAULT_KEEP_SNAPSHOTS)));
    writeGuardConfig({ ...readGuardConfig(), keepSnapshots: num });
    return num;
}

// ── helpers ────────────────────────────────────────────────────────────────
function harnessVersion() {
    const root = path.dirname(dshHome());
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
        if (typeof pkg.version === 'string' && pkg.version !== '')
            return pkg.version;
    }
    catch { /* fall through */ }
    try {
        const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const spec = rootPkg?.dependencies?.['@deepseek-ai/dsh'];
        if (typeof spec === 'string' && spec !== '')
            return `spec:${spec}`;
    }
    catch { /* unresolvable */ }
    return '';
}

function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listProfiles() {
    const dir = profilesDir();
    if (!fs.existsSync(dir))
        return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('_'))
        .map((e) => e.name)
        .sort();
}

function readManifest(dir) {
    try {
        let raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
        if (raw.charCodeAt(0) === 0xfeff)
            raw = raw.slice(1);
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}

/** pnpm 启动器解析：env 覆盖 → PATH → harness 本地 .bin。 */
function resolvePnpmCommand() {
    const candidates = [
        process.env.DSH_GUARD_PNPM ?? '',
        'pnpm',
        path.join(path.dirname(dshHome()), 'node_modules', '.bin', isWin() ? 'pnpm.cmd' : 'pnpm'),
        path.join(dshHome(), 'node_modules', '.bin', isWin() ? 'pnpm.cmd' : 'pnpm'),
    ];
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        if (candidate === 'pnpm') {
            const probe = isWin()
                ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], { encoding: 'utf8' })
                : spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
            if (probe.status === 0)
                return candidate;
            continue;
        }
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}

function cmdToken(s) {
    return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
}

function runPnpm(args, cwd, pnpmCommand) {
    const command = pnpmCommand ?? resolvePnpmCommand();
    if (!command)
        return { ok: false, status: null, output: 'pnpm not found (PATH, DSH_GUARD_PNPM, or a local node_modules/.bin)' };
    const result = isWin()
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', [cmdToken(command), ...args.map(cmdToken)].join(' ')], { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000 })
        : spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000 });
    return {
        ok: result.status === 0,
        status: result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    };
}

// ── snapshot / rollback ────────────────────────────────────────────────────
function snapshotMatches(aDir, bDir, files) {
    for (const f of files) {
        const a = path.join(aDir, f);
        const b = path.join(bDir, f);
        if (fs.existsSync(a) !== fs.existsSync(b))
            return false;
        if (fs.existsSync(a) && sha256File(a) !== sha256File(b))
            return false;
    }
    return true;
}

function writeManifest(dir, profile, tag, reason, files, pnpm) {
    const m = {
        profile,
        time: new Date().toISOString(),
        tag,
        reason,
        files,
        harness: harnessVersion(),
    };
    if (pnpm)
        m.pnpm = pnpm;
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
}

function pruneSnapshots(profile, keep) {
    const root = rollbacksRoot(profile);
    if (!fs.existsSync(root))
        return;
    const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name));
    for (const d of dirs.slice(keep))
        fs.rmSync(path.join(root, d.name), { recursive: true, force: true });
}

/** 日志/事故报告保留上限（last-boot.txt 与 pending-incident.json 永不删）。 */
function pruneGuardArtifacts(keep = DEFAULT_KEEP_LOGS) {
    const n = Math.max(1, Math.floor(Number(keep) || DEFAULT_KEEP_LOGS));
    const groups = [
        { dir: guardLogsDir(), re: /^boot-.*\.log$/ },
        { dir: guardLogsDir(), re: /^server-.*\.out\.log$/ },
        { dir: guardLogsDir(), re: /^server-.*\.err\.log$/ },
        { dir: guardLogsDir(), re: /^incident-.*\.md$/ },
        { dir: guardDir(), re: /^resolved-incident-.*\.json$/ },
    ];
    let removed = 0;
    for (const { dir, re } of groups) {
        if (!fs.existsSync(dir))
            continue;
        let files;
        try {
            files = fs.readdirSync(dir);
        }
        catch {
            continue;
        }
        const matched = files.filter((f) => re.test(f)).sort();
        for (const f of matched.slice(0, Math.max(0, matched.length - n))) {
            try {
                fs.rmSync(path.join(dir, f), { force: true });
                removed++;
            }
            catch { /* best effort */ }
        }
    }
    return removed;
}

function snapshotProfile(profile, { tag = '', reason = '', force = false } = {}) {
    const dir = profileDir(profile);
    if (!fs.existsSync(path.join(dir, 'package.json')))
        return { profile, error: `profile "${profile}" has no package.json` };
    const newStamp = stamp();
    const snapDir = path.join(rollbacksRoot(profile), newStamp);
    fs.mkdirSync(snapDir, { recursive: true });

    const saved = [];
    for (const f of SNAPSHOT_FILES) {
        const src = path.join(dir, f);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(snapDir, f));
            saved.push(f);
        }
    }

    if (!force) {
        const root = rollbacksRoot(profile);
        const entries = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
        const prev = entries
            .filter((e) => e.isDirectory() && e.name !== newStamp)
            .sort((a, b) => a.name.localeCompare(b.name))
            .at(-1);
        if (prev && snapshotMatches(snapDir, path.join(root, prev.name), saved)) {
            fs.rmSync(snapDir, { recursive: true, force: true });
            return { profile, skipped: true };
        }
    }

    writeManifest(snapDir, profile, tag, reason, saved, resolvePnpmCommand());
    pruneSnapshots(profile, resolveKeepSnapshots());
    pruneGuardArtifacts();
    return { profile, stamp: newStamp };
}

function listSnapshots(profile) {
    const root = rollbacksRoot(profile);
    if (!fs.existsSync(root))
        return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name))
        .map((e) => {
            const manifest = readManifest(path.join(root, e.name));
            return {
                stamp: e.name,
                tag: manifest?.tag ?? '',
                time: manifest?.time ?? '',
                reason: manifest?.reason ?? '',
                pnpm: manifest?.pnpm ?? '',
            };
        });
}

function resolveSnapshotDir(profile, { id = '', good = false } = {}) {
    const root = rollbacksRoot(profile);
    if (!fs.existsSync(root))
        return null;
    const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name));
    if (dirs.length === 0)
        return null;
    if (id) {
        const hit = dirs.find((e) => e.name === id || e.name.startsWith(id));
        return hit ? path.join(root, hit.name) : null;
    }
    if (good) {
        for (const e of dirs) {
            const manifest = readManifest(path.join(root, e.name));
            const tag = manifest?.tag ?? '';
            if (tag !== 'pre-boot' && tag !== 'pre-rollback')
                return path.join(root, e.name);
        }
    }
    return path.join(root, dirs[0].name);
}

/** 回滚前先给当前状态拍照（pre-rollback），所以回滚本身也可逆。 */
function restoreSnapshot(profile, snapshotDir, { skipInstall = false } = {}) {
    snapshotProfile(profile, { tag: 'pre-rollback', reason: `rollback to ${snapshotDir}` });
    const dir = profileDir(profile);
    for (const f of SNAPSHOT_FILES) {
        const src = path.join(snapshotDir, f);
        const dst = path.join(dir, f);
        if (fs.existsSync(src))
            fs.copyFileSync(src, dst);
        else if (fs.existsSync(dst))
            fs.rmSync(dst, { force: true });
    }
    let pnpm = null;
    if (!skipInstall) {
        const manifest = readManifest(snapshotDir);
        const command = manifest?.pnpm && fs.existsSync(manifest.pnpm) ? manifest.pnpm : null;
        pnpm = runPnpm(['install', '--frozen-lockfile'], dir, command);
    }
    const removedLinks = cleanupStaleBundleLinks(profile);
    return { restored: SNAPSHOT_FILES, pnpm, removedLinks };
}

function validLinkNames(pkg) {
    const names = new Set();
    const deps = pkg?.dependencies ?? {};
    for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === 'string' && spec.trim().toLowerCase().startsWith('link:'))
            names.add(name);
    }
    const bundles = pkg?.dsh?.profile?.bundles;
    if (Array.isArray(bundles))
        for (const b of bundles)
            names.add(b);
    return names;
}

/** 清理回滚后残留的 bundle 插件软链（指向 node_modules 之外、已不在清单里）。 */
function cleanupStaleBundleLinks(profile) {
    const dir = profileDir(profile);
    const nm = path.join(dir, 'node_modules');
    if (!fs.existsSync(nm))
        return [];
    let pkg = null;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    }
    catch { /* broken package.json -> treat every external link as stale */ }
    const valid = validLinkNames(pkg);
    const removed = [];
    const scan = (base, prefix) => {
        let entries = [];
        try {
            entries = fs.readdirSync(base, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const p = path.join(base, e.name);
            let st;
            try {
                st = fs.lstatSync(p);
            }
            catch {
                continue;
            }
            if (st.isDirectory() && !st.isSymbolicLink() && e.name.startsWith('@')) {
                scan(p, e.name);
                continue;
            }
            if (!st.isSymbolicLink())
                continue;
            let target = '';
            try {
                target = fs.readlinkSync(p);
            }
            catch {
                continue;
            }
            const abs = path.resolve(path.dirname(p), target);
            if (abs === nm || abs.startsWith(nm + path.sep))
                continue;
            const name = prefix ? `${prefix}/${e.name}` : e.name;
            if (valid.has(name))
                continue;
            try {
                fs.rmSync(p, { recursive: true, force: true });
                removed.push(name);
            }
            catch { /* best effort */ }
        }
    };
    scan(nm, '');
    return removed;
}

// ── 回滚快照（"复活币"位）────────────────────────────────────────────────
// 三级旋转：新快照 → current，旧 current → previous，旧 previous → 删除。
function readReviveCoin() {
    try {
        const raw = JSON.parse(fs.readFileSync(reviveCoinPath(), 'utf8'));
        return {
            current: typeof raw.current === 'string' && raw.current !== '' ? raw.current : null,
            previous: typeof raw.previous === 'string' && raw.previous !== '' ? raw.previous : null,
        };
    }
    catch {
        return { current: null, previous: null };
    }
}

function markReviveCoin(profile) {
    const snap = snapshotProfile(profile, { tag: 'revive-coin', reason: '守护启动成功自动存回滚快照', force: true });
    if (snap.error)
        return { ok: false, error: snap.error };
    const prev = readReviveCoin();
    if (prev.previous) {
        try {
            fs.rmSync(path.join(rollbacksRoot(profile), prev.previous), { recursive: true, force: true });
        }
        catch { /* best effort */ }
    }
    const coin = { current: snap.stamp, previous: prev.current };
    fs.mkdirSync(guardDir(), { recursive: true });
    fs.writeFileSync(reviveCoinPath(), `${JSON.stringify(coin, null, 2)}\n`, 'utf8');
    return { ok: true, stamp: snap.stamp, previous: coin.previous };
}

// ── 插件禁用/恢复（cordis.patch.yml 层，v3）─────────────────────────────
// 禁用 = 在 profile 的 cordis.patch.yml 追加 `- id: <entryId>` + `disabled: true`
// 恢复 = 去掉对应 `disabled: true` 行。文件注释全部保留，只做行级增删。
// entryId ≠ 包名（本插件是 guard-restart，webserver 是 webserver）：
//   优先取 --entry-id；其次 guard/config.json 的 entryIds 映射；
//   再其次内建已知表；最后退化为包名本身（会在日志中警告"可能不匹配"）。

/** 核心组件禁删名单：这些禁用会导致 dsh 本身起不来，一律拒绝。 */
const BLOCKED_PLUGINS = new Set([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-client-modules',
    '@deepseek-ai/dsh-host-webserver',
    'dsh-guard-restart', // 禁用自己 = 看门狗/恢复面板消失
]);

/** 已实测确认的 entryId（包名 → loader 注册名）。 */
const KNOWN_ENTRY_IDS = {
    '@deepseek-ai/dsh-host-webserver': 'webserver',
    '@deepseek-ai/dsh-web-app': 'web-app',
    'dsh-guard-restart': 'guard-restart',
};

const crashMarkerPath = () => path.join(guardDir(), 'plugin-crash.json');

function patchPath(profile) {
    return path.join(profileDir(profile), 'cordis.patch.yml');
}

/** 解析 patch 文件为行数组 + 块列表（块 = `- id:` 开头到下一个块前）。 */
function parsePatch(profile) {
    const file = patchPath(profile);
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
    return { file, lines, blocks, exists: true };
}

function resolveEntryIdHint(profile, name) {
    const cfg = readGuardConfig();
    if (cfg.entryIds && typeof cfg.entryIds === 'object' && typeof cfg.entryIds[name] === 'string')
        return cfg.entryIds[name];
    if (KNOWN_ENTRY_IDS[name])
        return KNOWN_ENTRY_IDS[name];
    return null;
}
function resolveEntryId(profile, name) {
    return resolveEntryIdHint(profile, name) ?? name;
}

function readDisabledLedger() {
    const file = path.join(guardDir(), 'disabled-plugins.json');
    if (!fs.existsSync(file))
        return [];
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(raw) ? raw : [];
    }
    catch {
        return [];
    }
}
function writeDisabledLedger(items) {
    fs.mkdirSync(guardDir(), { recursive: true });
    fs.writeFileSync(path.join(guardDir(), 'disabled-plugins.json'), `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function listProfilePlugins(profile) {
    const dir = profileDir(profile);
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath))
        return [];
    let pkg = null;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    }
    catch {
        return [];
    }
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const deps = Object.keys(pkg?.dependencies ?? {});
    const names = [...new Set([...bundles, ...deps])];
    const patch = parsePatch(profile);
    return names.map((name) => {
        const entryId = resolveEntryIdHint(profile, name) ?? name;
        const block = patch.blocks.find((b) => b.id === entryId);
        return {
            name,
            entryId,
            enabled: !(block && block.disabled),
            bundle: bundles.includes(name),
            blocked: BLOCKED_PLUGINS.has(name),
        };
    });
}

function pluginDisable(profile, name, { entryId = '', reason = '', dryRun = false } = {}) {
    const pkgPath = path.join(profileDir(profile), 'package.json');
    if (!fs.existsSync(pkgPath))
        return { ok: false, error: `profile "${profile}" has no package.json` };
    if (BLOCKED_PLUGINS.has(name))
        return { ok: false, error: `refusing to disable ${name} (blocked: core component or this very plugin)` };
    const id = entryId || resolveEntryId(profile, name);
    const patch = parsePatch(profile);
    const hit = patch.blocks.find((b) => b.id === id);
    if (hit && hit.disabled)
        return { ok: true, already: true, entryId: id, plugin: name };
    if (dryRun)
        return { ok: true, dryRun: true, entryId: id, plugin: name, action: 'would-disable' };
    // 动作前先拍一枚快照（pre-disable），随时可整体回滚。
    snapshotProfile(profile, { tag: 'pre-disable', reason: `disable ${name}`, force: true });
    const file = patch.file;
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# disabled by dsh-guard-restart (plugin-disable)\n- id: ${id}\n  disabled: true\n`, 'utf8');
    }
    else {
        let next;
        if (hit) {
            // 已有 `- id:` 行（未禁用）：在其后插一行 disabled: true
            next = patch.lines.slice();
            next.splice(hit.start + 1, 0, '  disabled: true');
        }
        else {
            next = patch.lines.slice();
            if (next.length > 0 && next[next.length - 1] !== '')
                next.push('');
            next.push(`- id: ${id}`, '  disabled: true');
        }
        fs.writeFileSync(file, next.join('\n').replace(/\n*$/, '\n'), 'utf8');
    }
    const ledger = readDisabledLedger();
    ledger.push({ plugin: name, entryId: id, at: new Date().toISOString(), reason: reason || 'manual' });
    writeDisabledLedger(ledger);
    return { ok: true, entryId: id, plugin: name, action: 'disabled' };
}

function pluginEnable(profile, name, { entryId = '' } = {}) {
    const id = entryId || resolveEntryId(profile, name);
    const patch = parsePatch(profile);
    const hit = patch.blocks.find((b) => b.id === id && b.disabled);
    if (!hit)
        return { ok: true, already: true, entryId: id, plugin: name };
    const next = patch.lines.slice();
    for (let i = hit.start; i <= hit.end; i++) {
        if (/^\s*disabled:\s*true/.test(next[i])) {
            next.splice(i, 1);
            break;
        }
    }
    fs.writeFileSync(patch.file, next.join('\n').replace(/\n*$/, '\n'), 'utf8');
    writeDisabledLedger(readDisabledLedger().filter((l) => l.plugin !== name));
    return { ok: true, entryId: id, plugin: name, action: 'enabled' };
}

// ── 页面崩溃标记（client 看门狗 → 宿主 → 本 CLI，boot-guard Phase 3 消费）──
function readCrashMarker() {
    const p = crashMarkerPath();
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}

/** crash-check：bootId 匹配当前启动 → 给出处置建议并消费标记。 */
function crashCheck(profile, bootId) {
    const marker = readCrashMarker();
    if (!marker)
        return { action: 'none' };
    if (bootId !== '' && typeof marker.bootId === 'string' && marker.bootId !== '' && marker.bootId !== bootId)
        return { action: 'stale' }; // 上一次进程的标记，留给它的 owner/人工
    const consumed = path.join(guardDir(), `resolved-crash-${Date.now()}.json`);
    try {
        fs.renameSync(crashMarkerPath(), consumed);
        fs.appendFileSync(consumed, `\n# consumed by crash-check (boot ${bootId})\n`, 'utf8');
    }
    catch { /* best effort */ }
    if (marker.phase === 'failed' && Array.isArray(marker.names) && marker.names.length > 0)
        return { action: 'disable', phase: 'failed', plugin: marker.names[0], bootId: marker.bootId };
    return { action: 'manual', phase: marker.phase || 'hang', bootId: marker.bootId };
}

// ── health / incident ──────────────────────────────────────────────────────
function health(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

function latestLogTail(dir, pattern, tail) {
    try {
        const files = fs.readdirSync(dir).filter((f) => f.includes(pattern)).sort();
        if (files.length === 0)
            return '';
        const lines = fs.readFileSync(path.join(dir, files.at(-1)), 'utf8').split(/\r?\n/);
        return lines.slice(-tail).join('\n');
    }
    catch {
        return '';
    }
}

function readPending() {
    try {
        const p = pendingMarkerPath();
        if (!fs.existsSync(p))
            return null;
        let raw = fs.readFileSync(p, 'utf8');
        if (raw.charCodeAt(0) === 0xfeff)
            raw = raw.slice(1);
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}

function writePending(kind, report) {
    fs.mkdirSync(guardDir(), { recursive: true });
    fs.writeFileSync(pendingMarkerPath(), `${JSON.stringify({ kind, time: new Date().toISOString(), report }, null, 2)}\n`, 'utf8');
}

function resolveIncidentMarker() {
    if (!fs.existsSync(pendingMarkerPath()))
        return { result: '没有待处理的事故' };
    const resolved = path.join(guardDir(), `resolved-incident-${Date.now()}.json`);
    fs.renameSync(pendingMarkerPath(), resolved);
    return { result: '事故已标记为已处理', report: resolved };
}

async function buildIncidentReport(kind, { port = resolveGuardPort(), noMarker = false } = {}) {
    const logsDir = guardLogsDir();
    fs.mkdirSync(logsDir, { recursive: true });
    const healthy = await health(port);
    const reportPath = path.join(logsDir, `incident-${Date.now()}.md`);
    const lines = [];
    lines.push('# DSH 守护启动事故报告', '');
    lines.push(`- 类型: ${kind}`);
    lines.push(`- 时间: ${new Date().toISOString()}`);
    lines.push(`- node: ${process.version}`);
    lines.push(`- dsh 版本: ${harnessVersion() || '(未知)'}`);
    lines.push(`- DSH_HOME: ${dshHome()}`);
    lines.push(`- 健康状态: http://127.0.0.1:${port}/ -> ${healthy ? '正常' : '异常'}`);
    try {
        lines.push(`- 上次启动: ${fs.readFileSync(path.join(logsDir, 'last-boot.txt'), 'utf8').trim() || '(unknown)'}`);
    }
    catch {
        lines.push('- 上次启动: (unknown)');
    }
    lines.push('', '## 启动日志(最近)');
    const boot = latestLogTail(logsDir, 'boot-', 40);
    lines.push(boot ? `\`\`\`\n${boot}\n\`\`\`` : '_(无)_', '');
    lines.push('## 服务端 stderr(最近)');
    const err = latestLogTail(logsDir, 'server-', 80);
    lines.push(err ? `\`\`\`\n${err}\n\`\`\`` : '_(无)_', '');
    lines.push('## 快照');
    for (const s of listSnapshots(process.env.PROFILE || process.env.DSH_PROFILE || 'web').slice(0, 6))
        lines.push(`- ${s.stamp} [${s.tag}] ${s.reason}`);
    lines.push('');
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
    if (!noMarker)
        writePending(kind, reportPath);
    pruneGuardArtifacts();
    return reportPath;
}

// ── argv ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const opts = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--profile')
            opts.profile = argv[++i];
        else if (a === '--tag')
            opts.tag = argv[++i];
        else if (a === '--reason')
            opts.reason = argv[++i];
        else if (a === '--id')
            opts.id = argv[++i];
        else if (a === '--kind')
            opts.kind = argv[++i];
        else if (a === '--port')
            opts.port = Number(argv[++i]);
        else if (a === '--force')
            opts.force = true;
        else if (a === '--dry-run')
            opts.dryRun = true;
        else if (a === '--good')
            opts.good = true;
        else if (a === '--entry-id')
            opts.entryId = argv[++i];
        else if (a === '--boot')
            opts.boot = argv[++i];
        else if (a === '--name')
            opts.name = argv[++i];
        else if (a === '--skip-install')
            opts.skipInstall = true;
        else if (a === '--no-marker')
            opts.noMarker = true;
        else if (a === '--mark')
            opts.mark = true;
        else if (a === '--json')
            opts.json = true;
        else if (a === '-h' || a === '--help')
            opts.help = true;
        else
            opts._.push(a);
    }
    return opts;
}

const USAGE = `dsh-guard-restart guard-cli: 守护启动的快照/回滚工具
  snapshot [--profile X] [--tag T] [--reason R] [--force]   手动快照
  list     [--profile X]                                     列出快照
  rollback [--profile X] [--id I | --good] [--skip-install]  回滚到指定/最近良好快照
  keep     [N]                                               查看或设置保留快照数(最少 2)
  health   [--port N]                                        检查后端健康状态
  incident [--kind K] [--no-marker]                          生成事故报告
  resolve                                                    标记待处理事故为已解决
  revive-coin [--profile X] [--mark]                         查看/存一枚回滚快照
  plugins  [--profile X]                                     列出全部插件及启用状态
  plugin-disable [--profile X] <name> [--entry-id ID] [--reason R] [--dry-run]
                                                             禁用插件(patch 层)
  plugin-enable  [--profile X] <name> [--entry-id ID]        恢复插件
  crash-check [--boot <bootId>]                              读页面崩溃标记并给处置建议
  profiles                                                   列出所有 profile`;

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0] ?? 'help';
    const opts = parseArgs(argv.slice(1));
    if (opts.help || cmd === 'help') {
        console.log(USAGE);
        return 0;
    }
    const profile = opts.profile ?? process.env.PROFILE ?? process.env.DSH_PROFILE ?? 'web';

    switch (cmd) {
        case 'profiles': {
            console.log(`当前 profile 列表: ${listProfiles().join(', ') || '(无)'}`);
            return 0;
        }
        case 'snapshot': {
            const tag = opts.tag ?? '';
            const reason = opts.reason ?? '';
            const results = opts.profile
                ? [snapshotProfile(opts.profile, { tag, reason, force: opts.force === true })]
                : listProfiles().map((p) => snapshotProfile(p, { tag, reason, force: opts.force === true }));
            for (const r of results) {
                if (r.error)
                    console.log(`快照 ${r.profile} 失败: ${r.error}`);
                else if (r.skipped)
                    console.log(`快照 ${r.profile} -> 跳过(与上一份内容完全相同)`);
                else
                    console.log(`快照 ${r.profile} -> ${r.stamp}`);
            }
            return 0;
        }
        case 'list': {
            const profiles = opts.profile ? [opts.profile] : listProfiles();
            for (const p of profiles) {
                console.log(`profile '${p}' 的快照:`);
                const snaps = listSnapshots(p);
                if (snaps.length === 0)
                    console.log('  (无)');
                for (const s of snaps) {
                    console.log(`  ${s.stamp}  [${s.tag}]  ${s.time}`);
                    if (s.reason)
                        console.log(`      原因: ${s.reason}`);
                }
            }
            return 0;
        }
        case 'rollback': {
            const profiles = opts.profile ? [opts.profile] : listProfiles();
            let failed = false;
            for (const p of profiles) {
                const good = opts.id === undefined && opts.good !== false;
                const dir = resolveSnapshotDir(p, { id: opts.id ?? '', good });
                if (!dir) {
                    console.error(`profile '${p}' 没有可用快照`);
                    failed = true;
                    continue;
                }
                console.log(`回滚 ${p} -> 快照 ${dir.split(/[\\/]/).at(-1)}`);
                try {
                    const { pnpm, removedLinks } = restoreSnapshot(p, dir, { skipInstall: opts.skipInstall === true });
                    if (pnpm !== null && !pnpm.ok) {
                        console.error(`pnpm 失败(退出码 ${pnpm.status}): ${pnpm.output}`);
                        console.error('配置文件已还原; 待 pnpm/网络可用后请手动运行 pnpm install --frozen-lockfile。');
                        failed = true;
                    }
                    else {
                        console.log('回滚完成。重启 dsh web 使 bundle 插件的改动生效。');
                        if (removedLinks && removedLinks.length > 0)
                            console.log(`已清理残留的 bundle 链接: ${removedLinks.join(', ')}`);
                    }
                }
                catch (error) {
                    console.error(`回滚 ${p} 失败: ${error.message}`);
                    failed = true;
                }
            }
            return failed ? 1 : 0;
        }
        case 'keep': {
            const arg = opts._[0];
            if (arg === undefined) {
                console.log(`每个 profile 保留快照数: ${resolveKeepSnapshots()} (最少 2)`);
                return 0;
            }
            const n = Number(arg);
            if (!Number.isFinite(n)) {
                console.error('用法: guard-cli.js keep <N>');
                return 2;
            }
            console.log(`每个 profile 保留快照数: ${setKeepSnapshots(n)}`);
            return 0;
        }
        case 'health': {
            const port = opts.port ?? resolveGuardPort();
            const ok = await health(port);
            console.log(`http://127.0.0.1:${port}/ -> ${ok ? '正常' : '异常'}`);
            return ok ? 0 : 1;
        }
        case 'incident': {
            const kind = opts.kind ?? 'manual';
            const report = await buildIncidentReport(kind, { port: opts.port ?? resolveGuardPort(), noMarker: opts.noMarker === true });
            console.log(`事故报告: ${report}`);
            if (!opts.noMarker)
                console.log('已设置待处理标记。');
            return 0;
        }
        case 'resolve': {
            console.log(resolveIncidentMarker().result);
            return 0;
        }
        case 'revive-coin': {
            if (opts.mark === true) {
                const r = markReviveCoin(profile);
                if (!r.ok) {
                    console.error(`存回滚快照失败: ${r.error}`);
                    return 1;
                }
                console.log(`回滚快照已存入: ${r.stamp} (前次: ${r.previous ?? '无'})`);
                return 0;
            }
            const coin = readReviveCoin();
            const snap = coin.current ? resolveSnapshotDir(profile, { id: coin.current }) : null;
            console.log(`回滚快照状态 (profile ${profile}):`);
            console.log(`  当前:   ${coin.current ?? '(无)'}`);
            console.log(`  前次:   ${coin.previous ?? '(无)'}`);
            console.log(`  可恢复: ${snap ?? '(无)'}`);
            return 0;
        }
        case 'status': {
            const port = opts.port ?? resolveGuardPort();
            const ok = await health(port);
            const coin = readReviveCoin();
            console.log(`健康状态: ${ok ? '正常' : '异常'}`);
            console.log(`待处理事故: ${readPending() ? '有' : '无'}`);
            console.log(`回滚快照: 当前 ${coin.current ?? '(无)'} / 前次 ${coin.previous ?? '(无)'}`);
            console.log(`快照数(${profile}): ${listSnapshots(profile).length}`);
            return 0;
        }
        case 'plugins': {
            const items = listProfilePlugins(profile);
            if (items.length === 0) {
                console.log(`profile '${profile}' 没有可枚举的插件`);
                return 0;
            }
            for (const it of items) {
                const flag = it.enabled ? '启用' : '禁用';
                const note = it.blocked ? ' [核心组件,禁删]' : '';
                console.log(`${flag.padEnd(3)} ${it.bundle ? '[bundle] ' : ''}${it.name} (entry ${it.entryId})${note}`);
            }
            return 0;
        }
        case 'plugin-disable': {
            const name = opts.name ?? opts._[0];
            if (!name) {
                console.error('用法: guard-cli.js plugin-disable <name> [--entry-id ID] [--reason R]');
                return 2;
            }
            const r = pluginDisable(profile, name, {
                entryId: opts.entryId ?? '',
                reason: opts.reason ?? '',
                dryRun: opts.dryRun === true,
            });
            if (!r.ok) {
                console.error(`禁用 ${name} 失败: ${r.error}`);
                return 1;
            }
            if (r.dryRun)
                console.log(`计划禁用 ${name} (entry ${r.entryId})`);
            else if (r.already)
                console.log(`${name} (entry ${r.entryId}) 已是禁用状态`);
            else
                console.log(`已禁用 ${name} (entry ${r.entryId})；重启 dsh 后生效。`);
            return 0;
        }
        case 'plugin-enable': {
            const name = opts.name ?? opts._[0];
            if (!name) {
                console.error('用法: guard-cli.js plugin-enable <name> [--entry-id ID]');
                return 2;
            }
            const r = pluginEnable(profile, name, { entryId: opts.entryId ?? '' });
            if (!r.ok) {
                console.error(`恢复 ${name} 失败: ${r.error}`);
                return 1;
            }
            console.log(r.already ? `${name} (entry ${r.entryId}) 本就处于启用状态` : `已恢复 ${name} (entry ${r.entryId})；重启 dsh 后生效。`);
            return 0;
        }
        case 'crash-check': {
            const v = crashCheck(profile, opts.boot ?? '');
            console.log(JSON.stringify(v));
            return 0;
        }
        default: {
            console.log(USAGE);
            return 2;
        }
    }
}

main().then((code) => {
    process.exitCode = code;
}).catch((error) => {
    console.error(`guard-cli 执行失败: ${error.message}`);
    process.exitCode = 1;
});
