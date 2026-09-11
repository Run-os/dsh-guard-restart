window.__ModuleLoader__.load({ id: "dsh-guard-restart", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-guard-restart client: 可见入口为左侧边栏「设置」行内的圆钮（与设置按钮
 * 同一行，参考 dsh-fuhuobi 的守护重启按钮），点击两次确认后调用宿主
 * /dsh-guard-restart/restart 做守护重启；缺少 dsh-fuhuobi（复活币）时点按
 * 变为自动安装。
 *
 * 挂载策略（参考 dsh-fuhuobi 的 guard supervisor，2026-09-11 验证安全）：
 *   - 本插件在 `sidebar.footer.action` 槽只渲染一个不可见锚点（占位、
 *     footerStack 开关需要其父容器引用）；可见圆钮由命令式 DOM 注入「设置」
 *     行容器（settingsArea / sidebar.settings 槽 / aria-haspopup 按钮的父级，
 *     逐级降级定位）。
 *   - 保活 = `MutationObserver(document.body, {childList,subtree})` + head
 *     observer + 800ms 一次 + 3s 心跳；reconcile 严格幂等（条件不满足绝不写
 *     DOM，收敛后完全静默），带 running 重入护栏 —— 不会像 v0.5.0 那样与页面
 *     其它 DOM 活动自激占死主线程。
 *   - 按钮几何全部内联 !important，不依赖样式表存活；绝不修改其它插件 DOM。
 *
 * 交互流：第一次点击进入确认态（红色✓，5 秒自动解除）；第二次点击 POST
 * /dsh-guard-restart/restart，全屏遮罩 + 轮询 /ping 直到 boot id 变化后刷新。
 *
 * 版本历史：
 *   v0.5.0 曾用「设置行圆钮 + 全页面 observer」实现同样入口，但 reconcile 每次
 *   无条件写 DOM 且与页面活动自激，导致重启后前端卡在 Loading plugins；v0.5.1
 *   回退 footArea 行按钮。v0.6.0 按用户要求回到设置行内圆钮，改用 fuhuobi 的
 *   幂等 supervisor 模式（已实测 fuhuobi 同机制长期稳定）。
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useRef, useCallback } = React

const NS = 'dsh-guard-restart'
const POLL_MS = 1000
const STUCK_AFTER_MS = 60000
const BTN_VERSION = '0.6.0'

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
  missing: '缺少 dsh-fuhuobi（复活币），点按安装',
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
  missing: 'dsh-fuhuobi (revival coin) is missing; click to install',
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
.dgr-mask{position:fixed;inset:0;z-index:9000;background:rgba(10,12,18,.55);display:flex;align-items:center;justify-content:center;pointer-events:auto}
.dgr-card{width:min(360px,86vw);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:16px;padding:28px 24px;box-shadow:0 24px 70px rgba(0,0,0,.3);display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;color:var(--dsw-alias-label-primary,#1f2328)}
.dgr-spin{width:34px;height:34px;border:3px solid var(--dsw-alias-border-l1,#e5e7eb);border-top-color:var(--dsw-alias-brand-primary,#4f6ef7);border-radius:99px;animation:dgr-sp .8s linear infinite}
@keyframes dgr-sp{to{transform:rotate(360deg)}}
.dgr-title{font-size:15px;font-weight:700;margin:0}
.dgr-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);margin:0;line-height:1.6}
.dgr-elapsed{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#6b7280)}
.dgr-stuck{font-size:12px;color:var(--dsw-alias-state-warn-primary,#b45309);line-height:1.6;margin:0}
.dgr-refresh{border:none;border-radius:8px;padding:8px 18px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:var(--dsw-alias-button-primary-fill,#4f6ef7);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dgr-nub{color:var(--dsw-alias-label-secondary,#6b7280);font-size:15px;line-height:1;cursor:pointer}
.dgr-nub:hover{color:var(--dsw-alias-label-primary,#1f2328)}
.dgr-nub-armed{color:var(--dsw-alias-state-error-primary,#dc2626);background:rgba(220,38,38,.14)}
.dgr-nub-armed:hover{color:#b91c1c}
.dgr-nub-warn{color:var(--dsw-alias-state-warn-primary,#b45309)}
.dgr-nub-warn:hover{color:#92400e}
.dgr-nub-busy{opacity:.6;cursor:wait}
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

// ---------------------------------------------------------------------------
// 设置行圆钮 supervisor（参考 dsh-fuhuobi：幂等 reconcile + body/head 双
// observer + 心跳；收敛后不再写 DOM，不会自激）。
// ---------------------------------------------------------------------------

function isBox(el) {
  try { return !!el && el instanceof Element && el.getBoundingClientRect && getComputedStyle(el).display !== 'contents' } catch { return false }
}

// 4 级降级定位「设置」行容器：settingsArea 类 → sidebar.settings 槽（含父级）
// → aria-haspopup=dialog 按钮的父级。
function resolveBox() {
  const byClass = document.querySelector('[class*="settingsArea"]')
  if (isBox(byClass)) return byClass
  const slot = document.querySelector('[data-slot="sidebar.settings"]')
  if (slot) {
    if (slot.parentElement && isBox(slot.parentElement)) return slot.parentElement
    if (isBox(slot)) return slot
  }
  const trigger = document.querySelector('button[aria-haspopup="dialog"]')
  if (trigger && trigger.parentElement && isBox(trigger.parentElement)) return trigger.parentElement
  return null
}

function createNub(onClick, onInstall) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dgr-nub'
  btn.setAttribute('data-dgr-nub', '1')
  btn.dataset.dgrVersion = BTN_VERSION
  btn.setAttribute('aria-label', '守护重启')
  // 几何全部内联 !important：不依赖样式表存活，样式表没加载布局也不坏。
  btn.style.setProperty('position', 'absolute', 'important')
  btn.style.setProperty('top', '50%', 'important')
  btn.style.setProperty('transform', 'translateY(-50%)', 'important')
  btn.style.setProperty('width', '28px', 'important')
  btn.style.setProperty('height', '28px', 'important')
  btn.style.setProperty('box-sizing', 'border-box', 'important')
  btn.style.setProperty('display', 'inline-flex', 'important')
  btn.style.setProperty('align-items', 'center', 'important')
  btn.style.setProperty('justify-content', 'center', 'important')
  btn.style.setProperty('border', 'none', 'important')
  btn.style.setProperty('border-radius', '50%', 'important')
  btn.style.setProperty('padding', '0', 'important')
  btn.style.setProperty('z-index', '10', 'important')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (btn.dataset.dgrMode === 'install') { onInstall(); return }
    onClick()
  })
  return btn
}

function GuardRestartRow({ t, wide, scope }) {
  // ---- 交互状态（React 持有；命令式按钮通过 ref 读取/刷新）----
  const [armed, setArmed] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [fuhuobiOk, setFuhuobiOk] = useState(null)
  const [ensureBusy, setEnsureBusy] = useState(false)
  const [ensureError, setEnsureError] = useState(false)
  const oldBoot = useRef(null)
  const anchorRef = useRef(null)
  const btnRef = useRef(null)
  const stackRef = useRef(false)

  const ensureRef = useRef(() => {})
  const restartRef = useRef(() => {})
  // 最新状态供命令式按钮刷新（supervisor 的 paint 从这儿取）。
  const stateRef = useRef({ fuhuobiOk: null, armed: false, ensureBusy: false, ensureError: false, t })
  stateRef.current.fuhuobiOk = fuhuobiOk
  stateRef.current.armed = armed
  stateRef.current.ensureBusy = ensureBusy
  stateRef.current.ensureError = ensureError
  stateRef.current.t = t

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/dsh-guard-restart/status', { cache: 'no-store' })
      if (!res.ok) return
      const body = await res.json()
      setFuhuobiOk(!!(body.fuhuobi && body.fuhuobi.installed))
    } catch { /* host unreachable */ }
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
    } catch { /* response may be lost when the host dies right after */ }
  }, [armed, restarting])

  useEffect(() => { ensureRef.current = ensureFuhuobi }, [ensureFuhuobi])
  useEffect(() => { restartRef.current = onRestart }, [onRestart])

  // footerStack：订阅 settingsScope 并应用到 footer 槽容器（anchor 的父级）。
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

  // paint：按最新状态刷新圆钮外观与位置（幂等；style 不触发 childList）。
  const paint = useCallback((btn, box) => {
    if (!btn) return
    try {
      const s = stateRef.current
      const fh = s.fuhuobiOk
      if (fh === false) {
        btn.dataset.dgrMode = 'install'
        btn.className = 'dgr-nub dgr-nub-warn' + (s.ensureBusy ? ' dgr-nub-busy' : '')
        btn.textContent = s.ensureBusy ? '…' : '✚'
        btn.title = s.ensureBusy ? (s.t('installing') || 'installing') : (s.ensureError ? (s.t('failedInstall') || 'failed') : (s.t('missing') || 'missing'))
        btn.disabled = !!s.ensureBusy
      } else {
        btn.dataset.dgrMode = s.armed ? 'confirm' : 'restart'
        btn.className = 'dgr-nub' + (s.armed ? ' dgr-nub-armed' : '')
        btn.textContent = s.armed ? '✓' : '↻'
        btn.title = s.armed ? (s.t('armed') || 'confirm') : (s.t('hint') || '')
        btn.disabled = false
      }
      const b = box || (btn.parentElement && isBox(btn.parentElement) ? btn.parentElement : null)
      if (b) {
        // 避让同行 [data-nio-rst]（硬性重启）与 [data-fuhuobi-rst]（复活币存币钮）。
        const nio = b.querySelector('[data-nio-rst]')
        const fhb = b.querySelector('[data-fuhuobi-rst]')
        btn.style.setProperty('right', (8 + (nio ? 34 : 0) + (fhb ? 34 : 0)) + 'px', 'important')
        const collapsed = b.closest('[class*="collapsed"]') !== null
        btn.style.setProperty('display', collapsed ? 'none' : 'inline-flex', 'important')
      } else {
        btn.style.setProperty('right', '8px', 'important')
      }
    } catch { /* 本按钮问题绝不影响页面 */ }
  }, [])

  // supervisor：把圆钮注入设置行并保活。
  //   - observer 回调只做 100ms 防抖触发（kick），启动期 DOM 风暴被合并，
  //     不会高频全量 reconcile（v0.6.0 教训：启动早期高频 reconcile + forced
  //     reflow 会拖死 splash 的 loader.await）。
  //   - 初始执行延迟 1500ms，等 client boot 的 DOM 风暴过去；4s 心跳兜底。
  //   - reconcile 幂等收敛：稳定后不写 DOM；running 锁由 run() 统一管理。
  useEffect(() => {
    injectStyles()
    let disposed = false
    let running = false
    let timer = null
    let debounce = null
    let heartbeat = null

    const reconcile = () => {
      try {
        const all = Array.from(document.querySelectorAll('[data-dgr-nub]'))
        if (all.length > 1) {
          const boxTmp = resolveBox()
          const keep = (boxTmp && all.find((b) => boxTmp.contains(b))) || all[0]
          for (const b of all) if (b !== keep) { try { b.remove() } catch {} }
        }
        let btn = document.querySelector('[data-dgr-nub]')
        if (btn && btn.dataset.dgrVersion !== BTN_VERSION) {
          try { btn.remove() } catch {}
          btn = null
        }
        const box = resolveBox()
        if (!box) {
          // 设置行还不存在：若按钮已被孤立挂到别处则收走，避免游离。
          if (btn && btn.isConnected && btn.parentElement && btn.parentElement !== document.body) {
            try { btn.remove() } catch {}
          }
          return
        }
        if (!btn || !btn.isConnected) {
          // 幂等定位（只读）；真正需要写盒定位时用 setProperty 一次到位，
          // 避免每次 reconcile 读 getComputedStyle（forced reflow）。
          try {
            const pos = getComputedStyle(box).position
            if (pos === 'static') box.style.setProperty('position', 'relative', 'important')
          } catch {}
          btn = createNub(() => restartRef.current(), () => ensureRef.current())
          btnRef.current = btn
          box.appendChild(btn)
        } else if (!box.contains(btn)) {
          box.appendChild(btn) // 领养移动：监听器随元素保留，不重建
        }
        paint(btn, box)
      } catch { /* 本按钮崩溃绝不致黑屏 */ }
    }

    const run = () => {
      if (disposed || running) return
      running = true
      try { reconcile() } finally { running = false }
    }
    let pending = false
    const kick = () => {
      if (disposed || pending) return
      pending = true
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { pending = false; debounce = null; run() }, 100)
    }
    const moBody = new MutationObserver(kick)
    const moHead = new MutationObserver(kick)
    try { moBody.observe(document.body, { childList: true, subtree: true }) } catch {}
    try { moHead.observe(document.head, { childList: true }) } catch {}
    timer = setTimeout(run, 1500) // 避开 client boot 早期 DOM 风暴
    heartbeat = setInterval(run, 4000)

    return () => {
      disposed = true
      if (debounce) clearTimeout(debounce)
      if (timer) clearTimeout(timer)
      if (heartbeat) clearInterval(heartbeat)
      try { moBody.disconnect() } catch {}
      try { moHead.disconnect() } catch {}
      const b = btnRef.current
      if (b && b.isConnected && b.parentElement) { try { b.parentElement.removeChild(b) } catch {} }
      btnRef.current = null
    }
  }, [paint])

  // Initial status probe + paint on state change.
  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { const b = btnRef.current; if (b) paint(b, b.parentElement) }, [paint, armed, fuhuobiOk, ensureBusy, ensureError])

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

  // React 渲染不可见锚点（占住 footer 槽位；footerStack 开关需要其父容器）。
  return h('span', { ref: anchorRef, style: { display: 'none' } })
}

function GuardStatusCard({ scope, t }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [fsSaving, setFsSaving] = useState(false)

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
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-guard-restart: dictionaries')
  } catch { /* locale unavailable: degrade quietly */ }
  const t = ctx.locale.bind(NS)
  let scope = null
  try { scope = ctx.settingsScope.bind({ namespace: NS }) } catch { /* no settings service */ }
  try {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-guard-restart',
      order: 0,
      label: () => '守护重启',
    }, ({ wide }) => h(GuardRestartRow, { t, wide, scope })))
  } catch { /* slot unavailable: button absent, rest unaffected */ }

  // 设置 > 插件 > 插件配置：「守护重启」状态卡片（含 footerStack 开关）。
  if (scope) {
    try {
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
    } catch { /* no settings card */ }
  }
}

return module.exports; } });