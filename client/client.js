window.__ModuleLoader__.load({ id: "dsh-guard-restart", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-guard-restart client: a guarded-restart button in the left sidebar,
 * displayed on its own row directly ABOVE the Settings row.
 *
 * v0.5.1（2026-09-11 故障回退）：
 *   v0.5.0 把按钮改为命令式注入「设置」行（settingsArea 绝对定位圆钮），并
 *   用 `MutationObserver(document.body, { childList, subtree })` + 3s 心跳来
 *   保活。实测（多轮冷启动）服务端一切正常，但**前端 splash 一直卡在
 *   "Loading plugins…"**：全页面的 DOM 变更都会触发 reconcile，而 reconcile
 *   内部又 remove/appendChild/改 style，与页面其它插件的 DOM 活动（聊天、
 *   动画等）形成自激，主线程被占死，前端 `loader.await()` 永不完成。
 *   经 probe（electron 实测）确认为 0.5.0 引入（0.4.x 同一 inject 与 apply
 *   结构、仅观察 footArea 局部 DOM 时前端正常）。
 *   修复：回退为 0.4.1 的 footArea 实现（局部 MutationObserver，只重排自身
 *   按钮行），按钮仍在「设置」上方独立一行（用户实测正常）。
 */
 *
 * Mounting strategy (imperative portal):
 *   - The slot renderer mounts this component inside the `sidebar.footer.action`
 *     container. We render only an invisible anchor there (React-owned), then
 *     imperatively create the REAL visible row and seat it in the sidebar foot
 *     right before the settings area. The shell foot is a column of exactly two
 *     element children: [footer-actions, settings-area].
 *   - Because React never owns the visible node, React re-renders cannot yank
 *     it back into the footer-actions container — and dsh-cost-meter's badge
 *     keeps living undisturbed inside that container (it actively re-orders
 *     itself there via MutationObserver, which previously collided with a
 *     React-managed sibling and blanked it).
 *
 * Flow: first click arms a confirmation; the second click POSTs
 * /dsh-guard-restart/restart (host schedules a guarded restart through
 * dsh-fuhuobi's boot-guard / systemd) and shows a full-screen overlay; the
 * page polls /dsh-guard-restart/ping until the boot id changes, then reloads.
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useRef, useCallback } = React

const NS = 'dsh-guard-restart'
const POLL_MS = 1000
const STUCK_AFTER_MS = 60000

const zh = {
  btn: '守护重启',
  armed: '再点一次确认',
  installing: '安装中…',
  install: '装复活币',
  failedInstall: '安装失败',
  restarting: '正在守护重启 DeepSeek Harness',
  pleaseWait: '将经 dsh-fuhuobi 守护启动重启；失败会自动回滚，完成后页面自动刷新',
  stuck: '重启耗时有点久，服务可能未正常启动。点下方按钮手动刷新，或检查服务日志。',
  refresh: '手动刷新',
  hint: '守护重启：systemctl restart 走 dsh-fuhuobi boot-guard（健康检查→失败回滚→成功存复活币）',
  missing: '缺少 dsh-fuhuobi（复活币）',
  cardTitle: '守护重启',
  cardLoading: '检测中…',
  cardFailed: '读取状态失败',
  cardRefresh: '刷新',
  sysd: 'systemd 配置',
  sysdUnit: '单元',
  sysdPresent: '已配置',
  sysdAbsent: '未配置',
  sysdActive: '运行中',
  sysdInactive: '未运行',
  sysdEnabled: '开机自启',
  sysdDisabled: '未设自启',
  fuhuobi: 'dsh-fuhuobi（复活币）',
  fuhuobiInstalled: '已安装',
  fuhuobiMissing: '未安装',
  setupReady: '守护链完整：boot-guard → run-dsh-web.sh → systemd 单元',
  setupMissing: '守护链有缺件，缺失时会在启动后自动补齐',
  autoNote: '自动检测：每次 DSH 启动后 4 秒检查复活币、6 秒检查守护链（systemd 配置）；本卡片每次打开 / 刷新都会实时读取最新状态。',
  footerStack: '侧边栏底部按钮各占一行',
  footerStackOn: '开启（每个插件按钮独占一行）',
  footerStackOff: '关闭（与其他插件并排）',
}

const en = {
  btn: 'Guard restart',
  armed: 'Click again to confirm',
  installing: 'Installing…',
  install: 'Install fuhuobi',
  failedInstall: 'Install failed',
  restarting: 'Guard-restarting DeepSeek Harness',
  pleaseWait: 'Restarting via dsh-fuhuobi guarded boot; auto-rollback on failure. The page reloads when it is back.',
  stuck: 'This is taking a while; the service may not have come back. Refresh manually or check the service logs.',
  refresh: 'Refresh now',
  hint: 'Guarded restart: systemctl restart via dsh-fuhuobi boot-guard (health check, auto rollback, revival coin).',
  missing: 'dsh-fuhuobi (revival coin) is missing',
  cardTitle: 'Guard restart',
  cardLoading: 'Checking…',
  cardFailed: 'Failed to read status',
  cardRefresh: 'Refresh',
  sysd: 'systemd config',
  sysdUnit: 'Unit',
  sysdPresent: 'Present',
  sysdAbsent: 'Absent',
  sysdActive: 'Active',
  sysdInactive: 'Inactive',
  sysdEnabled: 'Enabled',
  sysdDisabled: 'Disabled',
  fuhuobi: 'dsh-fuhuobi (revival coin)',
  fuhuobiInstalled: 'Installed',
  fuhuobiMissing: 'Missing',
  setupReady: 'Guard chain complete: boot-guard → run-dsh-web.sh → systemd unit',
  setupMissing: 'Guard chain has gaps; they are auto-provisioned after startup',
  autoNote: 'Auto-check: after every DSH start, fuhuobi is checked at 4s and the guard chain (systemd config) at 6s; opening / refreshing this card always reads the latest state.',
  footerStack: 'Sidebar footer buttons one per row',
  footerStackOn: 'On (each plugin button gets its own row)',
  footerStackOff: 'Off (side-by-side with other plugins)',
}

const CSS = `
.dgr-seat{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;min-width:0;padding:4px 6px}
.dgr-seat-rail{display:flex;justify-content:center;align-items:center;width:36px;padding:2px 0;box-sizing:border-box}
.dgr-btn{flex:1;min-width:0;height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f8fafc);color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;line-height:1;font-weight:600;cursor:pointer;font-family:inherit;padding:0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;justify-content:center;gap:4px;transition:all .12s ease}
.dgr-btn:hover{border-color:var(--dsw-alias-border-l2,#d0d5dd);background:var(--dsw-alias-interactive-bg-hover)}
.dgr-btn.armed{background:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626);color:#fff}
.dgr-btn:disabled{cursor:default;opacity:.6}
.dgr-mini{flex:none;height:30px;min-width:0;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:1;font-weight:600;cursor:pointer;font-family:inherit;padding:0 8px;white-space:nowrap}
.dgr-mini:hover{color:var(--dsw-alias-state-warn-primary,#b45309);border-color:var(--dsw-alias-state-warn-primary,#b45309)}
.dgr-btn-rail{width:36px;height:36px;border-radius:50%;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:18px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
.dgr-btn-rail:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary,#1f2328)}
.dgr-mask{position:fixed;inset:0;z-index:9000;background:rgba(10,12,18,.55);display:flex;align-items:center;justify-content:center;pointer-events:auto}
.dgr-card{width:min(360px,86vw);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:16px;padding:28px 24px;box-shadow:0 24px 70px rgba(0,0,0,.3);display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;color:var(--dsw-alias-label-primary,#1f2328)}
.dgr-spin{width:34px;height:34px;border:3px solid var(--dsw-alias-border-l1,#e5e7eb);border-top-color:var(--dsw-alias-brand-primary,#4f6ef7);border-radius:99px;animation:dgr-sp .8s linear infinite}
@keyframes dgr-sp{to{transform:rotate(360deg)}}
.dgr-title{font-size:15px;font-weight:700;margin:0}
.dgr-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);margin:0;line-height:1.6}
.dgr-elapsed{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#6b7280)}
.dgr-stuck{font-size:12px;color:var(--dsw-alias-state-warn-primary,#b45309);line-height:1.6;margin:0}
.dgr-refresh{border:none;border-radius:8px;padding:8px 18px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:var(--dsw-alias-button-primary-fill,#4f6ef7);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dgs-card{list-style:none;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
.dgs-head{display:flex;width:100%;align-items:baseline;gap:12px;padding:12px 14px;background:none;border:none;cursor:pointer;font:inherit;text-align:left;color:inherit}
.dgs-title{font-size:14px;font-weight:700;flex:none}
.dgs-desc{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dgs-body{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px}
.dgs-row{display:flex;align-items:flex-start;gap:8px;font-size:13px}
.dgs-label{flex:none;min-width:128px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;padding-top:2px}
.dgs-value{color:var(--dsw-alias-label-primary,#1f2328);word-break:break-all;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dgs-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:12px;line-height:18px;white-space:nowrap}
.dgs-ok{background:rgba(22,163,74,.12);color:#16a34a}
.dgs-bad{background:rgba(220,38,38,.12);color:#dc2626}
.dgs-warn{background:rgba(180,83,9,.12);color:#b45309}
.dgs-neutral{background:rgba(107,114,128,.12);color:#6b7280}
.dgs-hint{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#6b7280);margin:0}
.dgs-refresh{border:1px solid var(--dsw-alias-border-l2,#d0d5dd);background:var(--dsw-alias-bg-layer-2,#f8fafc);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;align-self:flex-start;display:inline-flex;align-items:center;gap:6px}
.dgs-refresh:disabled{opacity:.6;cursor:default}
.dgs-mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
/* 脚区按钮独占一行（实验性，默认关闭）：加在 sidebar.footer.action 槽容器上。
   注意不做 flex-direction:column —— v0.4.0 实测 column 会把第二行的
   auto-memory 按钮挤出可视区；这里改用 flex-wrap + 每子项整行宽。 */
.dgr-footer-stack{flex-wrap:wrap;row-gap:2px;overflow:visible}
.dgr-footer-stack>*{flex:0 0 100%;box-sizing:border-box}
`

function injectStyles() {
  if (document.querySelector('style[data-plugin-css="dsh-guard-restart"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-guard-restart'
  tag.dataset.pluginCss = 'dsh-guard-restart'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

function GuardRestartRow({ t, wide, scope }) {
  // Logic state (React-owned).
  const [armed, setArmed] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [fuhuobiOk, setFuhuobiOk] = useState(null)
  const [ensureBusy, setEnsureBusy] = useState(false)
  const [ensureError, setEnsureError] = useState(false)
  const oldBoot = useRef(null)
  // footerStack 开关：是否让 sidebar.footer.action 槽容器换行堆叠（各插件
  // 独占一行）。读取 settingsScope（默认 false，实验性）；无 settings
  // 服务时保持默认关闭。
  const stackRef = useRef(false)

  // Imperative node + anchor: the anchor is React-owned (inside the slot
  // container where the shell expects us); the real node is not.
  const anchorRef = useRef(null)
  const nodeRef = useRef(null)
  const mountedRef = useRef(false)

  // Keep latest handlers reachable from imperative DOM nodes.
  const ensureRef = useRef(() => {})
  const restartRef = useRef(() => {})

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/dsh-guard-restart/status', { cache: 'no-store' })
      if (!res.ok) return
      const body = await res.json()
      setFuhuobiOk(!!(body.fuhuobi && body.fuhuobi.installed))
    } catch { /* host unreachable mid-restart */ }
  }, [])

  const ensureFuhuobi = useCallback(async () => {
    if (ensureBusy) return
    setEnsureBusy(true)
    setEnsureError(false)
    try {
      const res = await fetch('/dsh-guard-restart/ensure-fuhuobi', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) throw new Error(String(res.status))
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await loadStatus()
    } catch {
      setEnsureError(true)
    } finally {
      setEnsureBusy(false)
    }
  }, [ensureBusy, loadStatus])

  const onRestart = useCallback(async () => {
    if (restarting) return
    if (!armed) { setArmed(true); return }
    setArmed(false)
    setStuck(false)
    setElapsed(0)
    try {
      const res = await fetch('/dsh-guard-restart/ping', { cache: 'no-store' })
      if (res.ok) oldBoot.current = (await res.json()).boot
    } catch { /* old server unreachable — poll with null oldBoot */ }
    setRestarting(true)
    try {
      await fetch('/dsh-guard-restart/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    } catch { /* the response may be lost when the host dies right after */ }
  }, [armed, restarting])

  useEffect(() => { ensureRef.current = ensureFuhuobi }, [ensureFuhuobi])
  useEffect(() => { restartRef.current = onRestart }, [onRestart])

  // 订阅 settingsScope 的 footerStack 字段并应用到槽容器布局；
  // 设置-插件卡片里改开关时这里会即时生效（无需刷新）。
  useEffect(() => {
    if (!scope) return
    let alive = true
    const apply = () => {
      if (!alive) return
      try {
        const snap = scope.getSnapshot ? scope.getSnapshot() : null
        const v = snap && snap.value && typeof snap.value.footerStack === 'boolean' ? snap.value.footerStack : false
        stackRef.current = v
        const anchor = anchorRef.current
        if (anchor && anchor.parentElement) anchor.parentElement.classList.toggle('dgr-footer-stack', v)
      } catch { /* keep current */ }
    }
    apply()
    const unsub = scope.subscribe ? scope.subscribe(apply) : null
    return () => { alive = false; if (unsub) unsub() }
  }, [scope])

  // Create the visible node and seat it above the footer-actions row.
  useEffect(() => {
    injectStyles()
    const anchor = anchorRef.current
    if (!anchor) return
    mountedRef.current = true

    const node = document.createElement('div')
    node.className = 'dgr-seat'
    nodeRef.current = node

    const clsOf = (el) => {
      const c = el.className
      return (typeof c === 'string' ? c : (c && c.baseVal)) || ''
    }
    const seat = () => {
      if (!mountedRef.current) return
      // footerStack：让 anchor 所在槽容器（sidebar.footer.action）竖排，
      // 各插件的按钮/徽章各自独占一行；开关在设置-插件卡片里。
      if (anchor.parentElement) {
        anchor.parentElement.classList.toggle('dgr-footer-stack', !!stackRef.current)
      }
      // 槽渲染器可能包裹一层，往祖先链上找到真正的脚区（class 含 footArea）。
      let foot = anchor.parentElement
      while (foot && !clsOf(foot).includes('footArea')) {
        foot = foot.parentElement
      }
      if (!foot) return
      // 目标行序（脚区是列布局）：[本行] → [cost-meter 等 footer-actions 行] → [设置行]
      // 按钮放在脚区最前 = cost-meter 行的上方。
      if (foot.firstElementChild !== node) {
        foot.insertBefore(node, foot.firstElementChild)
      }
    }
    seat()
    const observer = new MutationObserver(seat)
    let foot = anchor.parentElement
    while (foot && !clsOf(foot).includes('footArea')) foot = foot.parentElement
    if (foot) observer.observe(foot, { childList: true })

    return () => {
      mountedRef.current = false
      observer.disconnect()
      if (node.parentElement) node.parentElement.removeChild(node)
      nodeRef.current = null
    }
  }, [])

  // Rebuild the imperative node whenever state/locale changes.
  useEffect(() => {
    const node = nodeRef.current
    if (!node) return
    while (node.firstChild) node.removeChild(node.firstChild)
    if (!wide) {
      node.className = 'dgr-seat-rail'
    } else {
      node.className = 'dgr-seat'
    }
    if (!wide) {
      const btn = document.createElement('button')
      btn.className = 'dgr-btn-rail'
      btn.title = t('hint')
      btn.textContent = armed ? '✓' : '↻'
      btn.onclick = () => restartRef.current()
      node.appendChild(btn)
      return
    }
    const btn = document.createElement('button')
    btn.className = 'dgr-btn' + (armed ? ' armed' : '')
    btn.title = t('hint')
    btn.textContent = armed ? t('armed') : ('↻ ' + t('btn'))
    btn.onclick = () => restartRef.current()
    node.appendChild(btn)
    if (fuhuobiOk === false) {
      const mini = document.createElement('button')
      mini.className = 'dgr-mini'
      mini.disabled = ensureBusy
      mini.title = t('missing')
      mini.textContent = ensureBusy ? t('installing') : (ensureError ? t('failedInstall') : t('install'))
      mini.onclick = () => ensureRef.current()
      node.appendChild(mini)
    }
  }, [t, wide, armed, fuhuobiOk, ensureBusy, ensureError])

  // Initial status probe.
  useEffect(() => { loadStatus() }, [loadStatus])

  // Auto-disarm the confirmation after a few seconds.
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(timer)
  }, [armed])

  // Restarting overlay (imperative) + boot-id poll.
  useEffect(() => {
    if (!restarting) return
    const mask = document.createElement('div')
    mask.className = 'dgr-mask'
    const card = document.createElement('div')
    card.className = 'dgr-card'
    const spin = document.createElement('span')
    spin.className = 'dgr-spin'
    const title = document.createElement('p')
    title.className = 'dgr-title'
    title.textContent = t('restarting') + '…'
    const sub = document.createElement('p')
    sub.className = 'dgr-sub'
    sub.textContent = t('pleaseWait')
    const el = document.createElement('div')
    el.className = 'dgr-elapsed'
    const stuckEl = document.createElement('p')
    stuckEl.className = 'dgr-stuck'
    const refresh = document.createElement('button')
    refresh.className = 'dgr-refresh'
    refresh.textContent = t('refresh')
    refresh.onclick = () => location.reload()
    refresh.style.display = 'none'
    card.appendChild(spin)
    card.appendChild(title)
    card.appendChild(sub)
    card.appendChild(el)
    card.appendChild(stuckEl)
    card.appendChild(refresh)
    mask.appendChild(card)
    document.body.appendChild(mask)

    let alive = true
    const startedAt = Date.now()
    const clock = setInterval(() => {
      if (!alive) return
      el.textContent = Math.round((Date.now() - startedAt) / 1000) + ' s'
    }, 1000)
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/dsh-guard-restart/ping', { cache: 'no-store' })
        if (!res.ok) return
        const body = await res.json()
        if (typeof body.boot === 'string' && body.boot !== oldBoot.current) {
          alive = false
          clearInterval(clock)
          clearInterval(poll)
          location.reload()
        }
      } catch { /* host is down mid-restart — keep polling */ }
    }, POLL_MS)
    const deadline = setTimeout(() => {
      if (!alive) return
      stuckEl.textContent = t('stuck')
      refresh.style.display = ''
    }, STUCK_AFTER_MS)

    return () => {
      alive = false
      clearInterval(clock)
      clearInterval(poll)
      clearTimeout(deadline)
      if (mask.parentElement) mask.parentElement.removeChild(mask)
    }
  }, [restarting, t])

  // React renders nothing visible: only the invisible anchor.
  return h('span', { ref: anchorRef, style: { display: 'none' } })
}

function GuardStatusCard({ scope, t }) {
  // 设置 > 插件 > 插件配置：「守护重启」状态卡片。
  // 展示 systemd 配置状态、fuhuobi 是否已安装，并可切换 footerStack 开关
  // （侧边栏底部按钮各占一行）；其余信息只读、不编辑配置：
  // 数据来自宿主 /dsh-guard-restart/status（每次请求实时计算，非缓存）。
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [fsSaving, setFsSaving] = useState(false)

  // footerStack 开关：读 settingsScope（namespace 由宿主注册）。
  const subscribe = React.useMemo(
    () => (scope && scope.subscribe ? scope.subscribe.bind(scope) : (() => () => {})),
    [scope],
  )
  const getSnapshot = React.useMemo(
    () => (scope && scope.getSnapshot ? scope.getSnapshot.bind(scope) : (() => null)),
    [scope],
  )
  let snap = null
  try { snap = React.useSyncExternalStore(subscribe, getSnapshot) } catch { snap = null }
  const cfgReady = !!(snap && snap.status === 'ready')
  const footerStack = cfgReady && snap.value && typeof snap.value.footerStack === 'boolean' ? snap.value.footerStack : false
  const toggleFooterStack = async () => {
    if (!cfgReady || fsSaving || !scope) return
    setFsSaving(true)
    try { await scope.set('footerStack', !footerStack) } catch { /* best effort */ }
    setFsSaving(false)
  }

  const load = useCallback(async () => {
    setBusy(true)
    setFailed(false)
    try {
      const res = await fetch('/dsh-guard-restart/status', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      setStatus(await res.json())
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const s = status || {}
  const sysd = s.systemd || {}
  const fuhuobi = s.fuhuobi || {}
  const setup = s.setup || {}

  const badge = (ok, good, bad) => h('span', { className: 'dgs-badge ' + (ok ? 'dgs-ok' : 'dgs-bad') }, ok ? good : bad)
  const fuhuobiOk = fuhuobi.installed === true
  const sysdOk = !!(sysd.present && sysd.active && sysd.enabled)

  const summary = status === null
    ? (failed ? t('cardFailed') : t('cardLoading'))
    : (fuhuobiOk ? '✓ ' + t('fuhuobiInstalled') : '✗ ' + t('fuhuobiMissing')) + ' · ' + (sysdOk ? '✓ systemd' : '· systemd')

  return h('li', { className: 'dgs-card' + (open ? ' dgs-open' : '') },
    h('button', {
      type: 'button',
      className: 'dgs-head',
      'aria-expanded': open,
      onClick: () => setOpen(!open),
    },
      h('span', { className: 'dgs-title' }, t('cardTitle')),
      h('span', { className: 'dgs-desc' }, summary),
    ),
    open ? h('div', { className: 'dgs-body' },
      h('div', { className: 'dgs-row' },
        h('span', { className: 'dgs-label' }, t('sysd')),
        h('span', { className: 'dgs-value' },
          h('span', { className: 'dgs-mono' }, sysd.unit || '-'),
          badge(!!sysd.present, t('sysdPresent'), t('sysdAbsent')),
          badge(!!sysd.active, t('sysdActive'), t('sysdInactive')),
          badge(!!sysd.enabled, t('sysdEnabled'), t('sysdDisabled')),
        ),
      ),
      h('div', { className: 'dgs-row' },
        h('span', { className: 'dgs-label' }, t('fuhuobi')),
        h('span', { className: 'dgs-value' },
          badge(fuhuobiOk, t('fuhuobiInstalled'), t('fuhuobiMissing')),
          h('span', { className: 'dgs-badge dgs-neutral' },
            (fuhuobi.dep ? 'dep ✓' : 'dep ✗') + ' · ' + (fuhuobi.bundle ? 'bundle ✓' : 'bundle ✗'),
          ),
        ),
      ),
      h('div', { className: 'dgs-row' },
        h('span', { className: 'dgs-label' }, t('cardTitle')),
        h('span', { className: 'dgs-value' },
          setup.fullyReady
            ? h('span', { className: 'dgs-badge dgs-ok' }, '✓ ' + t('setupReady'))
            : h('span', { className: 'dgs-badge dgs-warn' }, t('setupMissing')),
        ),
      ),
      h('div', { className: 'dgs-row' },
        h('span', { className: 'dgs-label' }, t('footerStack')),
        h('span', { className: 'dgs-value' },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: footerStack, disabled: !cfgReady || fsSaving, onChange: toggleFooterStack, style: { cursor: 'pointer' } }),
            h('span', null, footerStack ? t('footerStackOn') : t('footerStackOff')),
          ),
        ),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        h('button', {
          type: 'button',
          className: 'dgs-refresh',
          disabled: busy,
          onClick: load,
        }, busy ? t('cardLoading') + '…' : '↻ ' + t('cardRefresh')),
        h('p', { className: 'dgs-hint' }, t('autoNote')),
      ),
    ) : null,
  )
}

exports.name = 'dsh-guard-restart'
exports.inject = ['slots', 'locale', 'settingsScope']
exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-guard-restart: dictionaries')
  const t = ctx.locale.bind(NS)
  // settingsScope 一次 bind，供侧边栏按钮（footerStack 布局）与设置-插件卡片共用；
  // 无 settings 服务时 scope 为 null，两侧都按默认值工作。
  let scope = null
  try { scope = ctx.settingsScope.bind({ namespace: NS }) } catch { /* no settings service */ }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-guard-restart',
    order: 0,
    label: () => '守护重启',
  }, ({ wide }) => h(GuardRestartRow, { t, wide, scope })))

  // 设置 > 插件 > 插件配置：「守护重启」状态卡片（含 footerStack 开关）。
  // namespace 由宿主侧 settings.register('dsh-guard-restart', …) 提供；
  // 无 settings 服务时静默跳过，不影响侧边栏按钮。
  if (scope) {
    ctx.slots.inject('settings.plugin.item', function* () {
      yield ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        id: NS,
        order: 50,
        label: '守护重启',
        inject: () => ({ scope }),
      }, (props) => h(GuardStatusCard, Object.assign({ t }, props)))
    })
  }
}

return module.exports; } });