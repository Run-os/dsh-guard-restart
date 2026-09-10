window.__ModuleLoader__.load({ id: "dsh-guard-restart", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-guard-restart client: a guarded-restart button in the left sidebar,
 * displayed on its own row directly ABOVE the Settings row.
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
`

function injectStyles() {
  if (document.querySelector('style[data-plugin-css="dsh-guard-restart"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-guard-restart'
  tag.dataset.pluginCss = 'dsh-guard-restart'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

function GuardRestartRow({ t, wide }) {
  // Logic state (React-owned).
  const [armed, setArmed] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [fuhuobiOk, setFuhuobiOk] = useState(null)
  const [ensureBusy, setEnsureBusy] = useState(false)
  const [ensureError, setEnsureError] = useState(false)
  const oldBoot = useRef(null)

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

exports.name = 'dsh-guard-restart'
exports.inject = ['slots', 'locale']
exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-guard-restart: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-guard-restart',
    order: 0,
    label: () => '守护重启',
  }, ({ wide }) => h(GuardRestartRow, { t, wide })))
}

return module.exports; } });