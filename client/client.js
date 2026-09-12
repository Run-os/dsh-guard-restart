window.__ModuleLoader__.load({ id: "dsh-guard-restart", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-guard-restart client: 可见入口为左侧边栏「设置」行内的圆钮（与设置按钮
 * 同一行），点击后弹出确认 Popover，「确定」即调用宿主
 * /dsh-guard-restart/restart 做守护重启。
 *
 * v0.8.0 起重启链路完全自带（不再安装 / 依赖 dsh-fuhuobi 复活币）：
 *   - 宿主自带 $DSH_HOME/boot-guard.sh + guard/guard-cli.js + guard/launch.json，
 *     重启由 systemd 单元或 boot-guard 直启完成（快照 → 健康检查 → 失败回滚）；
 *   - 组件挂载时 POST /dsh-guard-restart/booted 作为"客户端渲染成功"回执，
 *     宿主据此刷新启动清单并存一枚回滚快照（移植自 dsh-fuhuobi 的同名机制）。
 *
 * 挂载策略（2026-09-11 验证安全）：本插件在 `sidebar.footer.action` 槽挂载
 * GuardRestartRow（React 生命周期载体）；可见圆钮由命令式 DOM 注入「设置」行
 * 容器（settingsArea / sidebar.settings 槽 / aria-haspopup 按钮的父级，逐级
 * 降级定位）。保活 = body/head 双 MutationObserver + 100ms 防抖 + 4s 心跳；
 * reconcile 严格幂等（条件不满足绝不写 DOM），带 running 重入护栏。
 *
 * 交互流：点击圆钮 → 锚定确认 Popover（确定/取消）；「确定」才 POST
 * /restart，全屏遮罩 + 轮询 /ping 直到 boot id 变化后刷新。
 *
 * 版本历史：
 *   v0.5.0 曾用「设置行圆钮 + 全页面 observer」实现同样入口，但 reconcile 每次
 *   无条件写 DOM 且与页面活动自激，导致重启后前端卡在 Loading plugins；v0.5.1
 *   回退 footArea 行按钮。v0.6.0 回到设置行内圆钮，改用幂等 supervisor 模式。
 *   v0.7.0 移除 footerStack（已迁移至 dsh-eco-fixes）。v0.7.1 确认交互改为
 *   Popover。v0.7.2 卡片样式对齐 fuhuobi `.gdb-card` 并提前注入样式。
 *   v0.7.3 圆钮图标 ↻ → ⟳（用户选定）。
 *   v0.8.0 去掉「装复活币」分支与 fuhuobi 状态字段；卡片改为展示自带守护链
 *   （boot-guard / guard-cli / 启动清单）与快照状态；新增 /booted 回执。
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useRef, useCallback } = React

// ---------------------------------------------------------------------------
// v0.9.0 启动看门狗 + 恢复面板（纯 DOM，不依赖 React/应用挂载）。
// 触发点 = 本插件 chunk 在并行 client boot 期间被物化（即使其它插件卡死/报错，
// 只要本 chunk 能加载，这里的代码就会跑）。检测 splash 三态：
//   - splash 消失           → boot 正常，什么都不做（/booted 回执走正常路径）
//   - "Failed to load plugins" → 失败态：解析元凶名字上报 → 弹恢复面板
//   - 长时间仍 "Loading plugins…" → 挂起态：上报(无名字) → 弹恢复面板供手动
// ---------------------------------------------------------------------------

const NS2 = 'dsh-guard-restart'
const WATCH_POLL_MS = 2000
const HANG_TIMEOUT_MS = 90000

function dgrPanelCss() {
  if (document.querySelector('style[data-plugin-css="dsh-guard-restart-panel"]')) return
  const tag = document.createElement('style')
  tag.dataset.plugin = NS2
  tag.dataset.pluginCss = 'dsh-guard-restart-panel'
  tag.textContent = `
.dgrp{position:fixed;top:16px;right:16px;z-index:9500;width:min(420px,92vw);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#d0d5dd);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);padding:16px;box-sizing:border-box;font:13px/1.6 system-ui,Segoe UI,Roboto,sans-serif;color:var(--dsw-alias-label-primary,#1f2328);text-align:left}
.dgrp h3{margin:0 0 6px;font-size:14px;font-weight:700}
.dgrp .dgrp-sub{margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:pre-wrap;word-break:break-word}
.dgrp .dgrp-item{display:flex;align-items:center;gap:8px;padding:5px 2px;border-top:1px solid var(--dsw-alias-border-l1,#eef0f3)}
.dgrp .dgrp-name{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dgrp .dgrp-badge{flex:none;font-size:11px;padding:0 6px;border-radius:999px}
.dgrp .dgrp-on{background:rgba(22,163,74,.12);color:#16a34a}
.dgrp .dgrp-off{background:rgba(107,114,128,.12);color:#6b7280}
.dgrp .dgrp-block{background:rgba(180,83,9,.12);color:#b45309}
.dgrp button{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#d0d5dd);background:var(--dsw-alias-bg-layer-2,#f8fafc);border-radius:8px;padding:3px 10px;flex:none}
.dgrp button:disabled{opacity:.55;cursor:not-allowed}
.dgrp button.dgrp-danger{background:rgba(220,38,38,.1);border-color:rgba(220,38,38,.35);color:#dc2626}
.dgrp .dgrp-actions{display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap}
.dgrp .dgrp-actions button.dgrp-restart{background:var(--dsw-alias-button-primary-fill,#4f6ef7);color:#fff;border:none;padding:6px 16px;font-weight:600}
.dgrp .dgrp-note{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);margin:8px 0 0}
.dgrp .dgrp-x{position:absolute;top:8px;right:10px;border:none;background:none;font-size:15px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}
.dgrp .dgrp-empty{padding:8px 2px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}
`
  document.head.appendChild(tag)
}

/** 从错误消息/DOM 文本里尽量提取插件名（服务端还会按 deps 名单做二次校验）。 */
function dgrExtractNames(message, allText) {
  const set = new Set()
  const msgs = [message, allText].filter(Boolean).join('\n')
  let m
  const re = /loader\s+entry\s+[0-9a-f]+\s*\(([^()]+)\)/gi
  while ((m = re.exec(msgs))) { const n = m[1].trim(); if (n) set.add(n) }
  for (const line of msgs.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('web boot:')) continue
    const idx = t.indexOf(':')
    const cand = idx > 0 ? t.slice(0, idx).trim() : ''
    if (cand && cand.length <= 120 && !/^(failed|loading|import|pending|waiting|unknown|active|unloading|disposed)/i.test(cand)) set.add(cand)
  }
  return [...set]
}

/** 面板：插件清单 + 启用/禁用切换 + 底部重启。 */
function dgrShowPanel(phase, message) {
  dgrPanelCss()
  if (document.querySelector('.dgrp')) return
  const box = document.createElement('div')
  box.className = 'dgrp'
  box.style.position = 'fixed'
  const xBtn = document.createElement('button')
  xBtn.className = 'dgrp-x'
  xBtn.textContent = '×'
  xBtn.onclick = () => {
    window.__dgrPanelDismissed = true
    if (box.parentElement) box.parentElement.removeChild(box)
  }
  const title = document.createElement('h3')
  title.textContent = phase === 'failed' ? '页面加载报错 — 插件可在此处置' : '页面加载卡住 — 可在此手动处置'
  const sub = document.createElement('p')
  sub.className = 'dgrp-sub'
  sub.textContent = phase === 'failed'
    ? (message ? message : '检测到插件加载报错，已上报守护链。下方可手动禁用/恢复插件。')
    : '原因未知（没有报错信息），无法自动定位元凶，请手动选择要禁用的插件，或回滚、重启。'
  const list = document.createElement('div')
  const actions = document.createElement('div')
  actions.className = 'dgrp-actions'
  const restartBtn = document.createElement('button')
  restartBtn.className = 'dgrp-restart'
  restartBtn.textContent = '重启 DSH'
  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = '刷新清单'
  const note = document.createElement('p')
  note.className = 'dgrp-note'
  refreshBtn.onclick = () => { refreshBtn.disabled = true; dgrLoadList(list, note); setTimeout(() => { refreshBtn.disabled = false }, 1500) }
  restartBtn.onclick = () => { restartBtn.disabled = true; restartBtn.textContent = '重启中…'; dgrPanelRestart(restartBtn, note) }
  actions.appendChild(refreshBtn)
  actions.appendChild(restartBtn)
  box.appendChild(xBtn)
  box.appendChild(title)
  box.appendChild(sub)
  box.appendChild(list)
  box.appendChild(actions)
  box.appendChild(note)
  document.body.appendChild(box)
  dgrLoadList(list, note)
}

function dgrLoadList(list, note) {
  list.textContent = ''
  fetch('/dsh-guard-restart/plugins', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
    .then((data) => {
      const plugins = (data && data.plugins) || []
      if (plugins.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'dgrp-empty'
        empty.textContent = '没有可枚举的插件（可能 host 路由不可达）。'
        list.appendChild(empty)
        return
      }
      if (note) note.textContent = '切换后需点「重启 DSH」使其生效；恢复面板只在页面未能正常加载时出现。'
      for (const p of plugins) {
        const row = document.createElement('div')
        row.className = 'dgrp-item'
        const name = document.createElement('span')
        name.className = 'dgrp-name'
        name.textContent = (p.bundle ? '◆ ' : '') + p.name + ' (' + p.entryId + ')'
        name.title = p.name
        const badge = document.createElement('span')
        badge.className = 'dgrp-badge ' + (p.blocked ? 'dgrp-block' : (p.enabled ? 'dgrp-on' : 'dgrp-off'))
        badge.textContent = p.blocked ? '核心组件' : (p.enabled ? '已启用' : '已禁用')
        const toggle = document.createElement('button')
        if (p.blocked) {
          toggle.disabled = true
          toggle.textContent = '禁删'
        }
        else {
          toggle.className = p.enabled ? 'dgrp-danger' : ''
          toggle.textContent = p.enabled ? '禁用' : '启用'
          toggle.onclick = () => {
            toggle.disabled = true
            dgrSetPlugin(p.name, !p.enabled, toggle, row, badge)
          }
        }
        row.appendChild(name)
        row.appendChild(badge)
        row.appendChild(toggle)
        list.appendChild(row)
      }
    })
    .catch(() => {
      const empty = document.createElement('div')
      empty.className = 'dgrp-empty'
      empty.textContent = '读取插件清单失败（服务端不可达？）。'
      list.appendChild(empty)
    })
}

function dgrSetPlugin(name, enabled, btn, row, badge) {
  fetch('/dsh-guard-restart/plugin-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, enabled }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (!res || res.ok !== true) {
        btn.disabled = false
        badge.textContent = res && res.error ? ('失败: ' + res.error) : '失败'
        return
      }
      badge.textContent = enabled ? '已启用' : '已禁用'
      badge.className = 'dgrp-badge ' + (enabled ? 'dgrp-on' : 'dgrp-off')
      btn.textContent = enabled ? '禁用' : '启用'
      btn.className = enabled ? 'dgrp-danger' : ''
      btn.disabled = false
    })
    .catch(() => { btn.disabled = false; badge.textContent = '请求失败' })
}

function dgrPanelRestart(restartBtn, note) {
  const oldBoot = { value: null }
  fetch('/dsh-guard-restart/ping', { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => { oldBoot.value = d && d.boot })
    .catch(() => {})
  fetch('/dsh-guard-restart/restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {})
  const started = Date.now()
  const poll = setInterval(() => {
    fetch('/dsh-guard-restart/ping', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d && typeof d.boot === 'string' && d.boot !== oldBoot.value) {
          clearInterval(poll)
          location.reload()
        }
      })
      .catch(() => {})
      .then(() => {
        if (Date.now() - started > 60000) {
          clearInterval(poll)
          restartBtn.disabled = false
          restartBtn.textContent = '重启 DSH'
          note.textContent = '等待恢复超时：可手动刷新页面，或检查服务日志。'
        }
      })
  }, 1000)
}

/** 看门狗主循环：factory 物化即启动（window 标志防重复）。 */
function dgrStartWatchdog() {
  if (window.__dgrWatchdog) return window.__dgrWatchdog
  const state = { reported: false, startedAt: Date.now(), timer: null }
  const isSplash = () => !!document.querySelector('[data-dsh-boot]')
  const tick = () => {
    try {
      if (!isSplash()) {
        // boot 正常：面板不该出现，撤掉轮询
        clearInterval(state.timer)
        state.timer = null
        const panel = document.querySelector('.dgrp')
        if (panel && panel.parentElement) panel.parentElement.removeChild(panel)
        return
      }
      const bootRoot = document.querySelector('[data-dsh-boot]')
      const text = bootRoot ? bootRoot.textContent || '' : ''
      if (text.indexOf('Failed to load plugins') !== -1) {
        const names = dgrExtractNames(null, text)
        if (!state.reported) {
          state.reported = true
          fetch('/dsh-guard-restart/plugin-stuck', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phase: 'failed', message: text.slice(0, 2000), names }),
          }).catch(() => {})
        }
        if (!window.__dgrPanelDismissed) dgrShowPanel('failed', text.slice(0, 400))
        return
      }
      if (Date.now() - state.startedAt > HANG_TIMEOUT_MS) {
        if (!state.reported) {
          state.reported = true
          fetch('/dsh-guard-restart/plugin-stuck', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phase: 'hang', names: [] }),
          }).catch(() => {})
        }
        if (!window.__dgrPanelDismissed) dgrShowPanel('hang', null)
      }
    }
    catch { /* 看门狗问题绝不影响页面 */ }
  }
  state.timer = setInterval(tick, WATCH_POLL_MS)
  setTimeout(tick, 3000)
  window.__dgrWatchdog = state
  return state
}

try { dgrStartWatchdog() } catch { /* ignore */ }

const NS = 'dsh-guard-restart'
const POLL_MS = 1000
const STUCK_AFTER_MS = 60000
const BTN_VERSION = '0.9.0'

const zh = {
  btn: '守护重启',
  askTitle: '确认守护重启？',
  askBody: '将重启 DeepSeek Harness，当前会话会短暂中断；启动失败会自动回滚，完成后页面自动刷新。',
  ok: '确定',
  cancel: '取消',
  restarting: '正在守护重启 DeepSeek Harness',
  pleaseWait: '将经自带 boot-guard 守护启动重启（快照→健康检查→失败回滚）；完成后页面自动刷新',
  stuck: '重启耗时有点久，服务可能未正常启动。点下方按钮手动刷新，或检查服务日志。',
  refresh: '手动刷新',
  hint: '守护重启：systemd / 自带 boot-guard（快照 → 健康检查 → 失败回滚 → 成功存回滚快照）',
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
  chain: '守护链（自带）',
  chainBootGuard: 'boot-guard',
  chainCli: 'guard-cli',
  chainLaunch: '启动清单',
  chainReady: '已就绪',
  chainMissing: '缺失',
  chainOutdated: '待升级',
  snap: '回滚快照',
  snapCount: '份数',
  snapCurrent: '当前',
  snapNone: '(无)',
  restartMode: '重启方式',
  modeSystemd: 'systemd 单元',
  modeBootGuard: 'boot-guard 直启',
  setupReady: '守护链完整：boot-guard.sh → run-dsh-web.sh → systemd 单元',
  setupMissing: '守护链有缺件，启动后 6 秒会自动补齐/升级',
  autoNote: '自动检测：每次 DSH 启动后 6 秒检查并补齐守护链；客户端渲染成功会自动刷新启动清单并存快照。本卡片每次打开 / 刷新都实时读取最新状态。',
}

const en = {
  btn: 'Guard restart',
  askTitle: 'Restart DeepSeek Harness?',
  askBody: 'The current session will briefly interrupt; it auto-rolls back on failure and the page reloads once it is back.',
  ok: 'Restart',
  cancel: 'Cancel',
  restarting: 'Guard-restarting DeepSeek Harness',
  pleaseWait: 'Restarting via the bundled boot-guard (snapshot, health check, auto rollback). The page reloads when it is back.',
  stuck: 'This is taking a while; the service may not have come back. Refresh manually or check the service logs.',
  refresh: 'Refresh now',
  hint: 'Guarded restart: systemd / bundled boot-guard (snapshot, health check, auto rollback, rollback-snapshot on success).',
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
  chain: 'Guard chain (bundled)',
  chainBootGuard: 'boot-guard',
  chainCli: 'guard-cli',
  chainLaunch: 'launch manifest',
  chainReady: 'ready',
  chainMissing: 'missing',
  chainOutdated: 'outdated',
  snap: 'Rollback snapshots',
  snapCount: 'count',
  snapCurrent: 'current',
  snapNone: '(none)',
  restartMode: 'Restart mode',
  modeSystemd: 'systemd unit',
  modeBootGuard: 'boot-guard direct',
  setupReady: 'Guard chain complete: boot-guard.sh → run-dsh-web.sh → systemd unit',
  setupMissing: 'Guard chain has gaps; auto-provisioned/upgraded 6s after startup',
  autoNote: 'Auto-check: the guard chain is verified and repaired 6s after every DSH start; a client render confirm refreshes the launch manifest and mints a rollback snapshot. Opening / refreshing this card always reads the latest state.',
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
.dgr-nub{color:var(--dsw-alias-label-secondary,#6b7280);font-size:15px;line-height:1;cursor:pointer;background:transparent}
.dgr-nub:hover{color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-interactive-bg-hover)}
.dgr-nub-warn{color:var(--dsw-alias-state-warn-primary,#b45309)}
.dgr-nub-warn:hover{color:#92400e}
.dgr-nub-busy{opacity:.6;cursor:wait}
.dgr-pop{position:fixed;z-index:9100;min-width:220px;max-width:min(300px,86vw);box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.22);padding:14px 16px;display:flex;flex-direction:column;gap:10px;text-align:left;color:var(--dsw-alias-label-primary,#1f2328)}
.dgr-pop::before{content:'';position:absolute;width:10px;height:10px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#fff);border-left:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb);transform:rotate(45deg)}
.dgr-pop[data-dgr-pop-arrow="top"]::before{top:-6px;right:14px}
.dgr-pop[data-dgr-pop-arrow="bottom"]::before{bottom:-6px;right:14px}
.dgr-pop-title{font-size:14px;font-weight:700;margin:0}
.dgr-pop-body{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280);margin:0}
.dgr-pop-actions{display:flex;gap:8px;justify-content:flex-end}
.dgr-pop-btn{border:none;border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.dgr-pop-cancel{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,#d0d5dd)}
.dgr-pop-cancel:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dgr-pop-ok{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff}
.dgr-pop-ok:hover{background:#b91c1c}
.dgs-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s;overflow:hidden}
.dgs-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dgs-card.dgs-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
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

function createNub(onClick) {
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
  btn.style.setProperty('background', 'transparent', 'important')
  btn.style.setProperty('padding', '0', 'important')
  btn.style.setProperty('z-index', '10', 'important')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return btn
}

function GuardRestartRow({ t, wide }) {
  // ---- 交互状态（React 持有；命令式按钮通过 ref 读取/刷新）----
  const [ask, setAsk] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const oldBoot = useRef(null)
  const btnRef = useRef(null)

  const restartRef = useRef(() => {})
  const confirmRef = useRef(() => {})
  // 最新状态供命令式按钮刷新（supervisor 的 paint 从这儿取）。
  const stateRef = useRef({ t })
  stateRef.current.t = t

  // 「客户端渲染成功」回执：宿主据此刷新启动清单 + 存一枚回滚快照
  // （移植自 dsh-fuhuobi 的 /fuhuobi/api/booted；每进程只生效一次）。
  useEffect(() => {
    fetch('/dsh-guard-restart/booted', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => { /* host 不可达时忽略 */ })
  }, [])

  // 点击圆钮 = 弹出确认 Popover（不直接重启）。
  const onRestart = useCallback(() => {
    if (restarting) return
    setAsk(true)
  }, [restarting])

  // Popover 里点「确定」才真正执行守护重启。
  const confirmRestart = useCallback(async () => {
    if (restarting) return
    setAsk(false)
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
  }, [restarting])

  useEffect(() => { restartRef.current = onRestart }, [onRestart])
  useEffect(() => { confirmRef.current = confirmRestart }, [confirmRestart])

  // paint：按最新状态刷新圆钮外观与位置（幂等；style 不触发 childList）。
  const paint = useCallback((btn, box) => {
    if (!btn) return
    try {
      const s = stateRef.current
      btn.dataset.dgrMode = 'restart'
      btn.className = 'dgr-nub'
      btn.textContent = '⟳'
      btn.title = s.t('hint') || ''
      btn.disabled = false
      const b = box || (btn.parentElement && isBox(btn.parentElement) ? btn.parentElement : null)
      if (b) {
        // 避让同行其它插件按钮（硬性重启 [data-nio-rst] / 复活币存币钮 [data-fuhuobi-rst]）。
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
          btn = createNub(() => restartRef.current())
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
  useEffect(() => { const b = btnRef.current; if (b) paint(b, b.parentElement) }, [paint])

  // 确认 Popover（命令式 DOM：锚定圆钮，确定/取消；点击外部或 Esc 关闭）。
  useEffect(() => {
    if (!ask) return
    const btn = btnRef.current
    if (!btn || !btn.isConnected) { setAsk(false); return }
    const pop = document.createElement('div')
    pop.className = 'dgr-pop'
    const title = document.createElement('p')
    title.className = 'dgr-pop-title'
    title.textContent = t('askTitle')
    const body = document.createElement('p')
    body.className = 'dgr-pop-body'
    body.textContent = t('askBody')
    const actions = document.createElement('div')
    actions.className = 'dgr-pop-actions'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'dgr-pop-btn dgr-pop-cancel'
    cancelBtn.textContent = t('cancel')
    cancelBtn.onclick = () => setAsk(false)
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.className = 'dgr-pop-btn dgr-pop-ok'
    okBtn.textContent = t('ok')
    okBtn.onclick = () => confirmRef.current()
    actions.appendChild(cancelBtn)
    actions.appendChild(okBtn)
    pop.appendChild(title)
    pop.appendChild(body)
    pop.appendChild(actions)
    document.body.appendChild(pop)

    // 锚定定位：优先放在圆钮下方右对齐；空间不足则放上方。
    pop.style.visibility = 'hidden'
    const rect = btn.getBoundingClientRect()
    const GAP = 8
    const below = rect.bottom + GAP + pop.offsetHeight <= window.innerHeight - GAP
    const top = below ? rect.bottom + GAP : Math.max(GAP, rect.top - GAP - pop.offsetHeight)
    let right = Math.max(GAP, window.innerWidth - rect.right)
    if (window.innerWidth - right - pop.offsetWidth < GAP) right = Math.max(GAP, window.innerWidth - GAP - pop.offsetWidth)
    pop.style.top = top + 'px'
    pop.style.right = right + 'px'
    pop.dataset.dgrPopArrow = below ? 'top' : 'bottom'
    pop.style.visibility = ''

    const close = () => setAsk(false)
    const onDown = (e) => {
      if (!pop.contains(e.target) && e.target !== btn) close()
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    cancelBtn.focus() // 默认焦点在取消：回车不会误触发重启

    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      if (pop.parentElement) pop.parentElement.removeChild(pop)
    }
  }, [ask, t])

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

  // v0.7.0 起不再渲染 footer 锚点（footerStack 已迁移至 dsh-eco-fixes）。
  return null
}

function GuardStatusCard({ t }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

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
  const guard = s.guard || {}
  const setup = s.setup || {}
  const snap = guard.snapshot || {}
  const restart = s.restart || {}

  const badge = (ok, good, bad) => h('span', { className: 'dgs-badge ' + (ok ? 'dgs-ok' : 'dgs-bad') }, ok ? good : bad)
  // 资产三态：就绪（绿）/ 待升级（黄）/ 缺失（红）—— 兼容旧宿主只给 present 的情况。
  const assetBadge = (info) => {
    const ok = info && info.present === true
    const outdated = ok && info.upToDate === false
    if (outdated) return h('span', { className: 'dgs-badge dgs-warn' }, t('chainOutdated'))
    return badge(ok, t('chainReady'), t('chainMissing'))
  }
  const chainOk = !!(guard.bootGuard && guard.bootGuard.present && guard.cli && guard.cli.present && guard.launch && guard.launch.present)
  const sysdOk = !!(sysd.present && sysd.active && sysd.enabled)

  const summary = status === null
    ? (failed ? t('cardFailed') : t('cardLoading'))
    : (chainOk ? '✓ ' + t('chain') : '✗ ' + t('chainMissing')) + ' · ' + (sysdOk ? '✓ systemd' : '· systemd')

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
        h('span', { className: 'dgs-label' }, t('chain')),
        h('span', { className: 'dgs-value' },
          h('span', { className: 'dgs-badge dgs-neutral' }, t('chainBootGuard')), assetBadge(guard.bootGuard),
          h('span', { className: 'dgs-badge dgs-neutral' }, t('chainCli')), assetBadge(guard.cli),
          h('span', { className: 'dgs-badge dgs-neutral' }, t('chainLaunch')), assetBadge(guard.launch),
        ),
      ),
      h('div', { className: 'dgs-row' },
        h('span', { className: 'dgs-label' }, t('snap')),
        h('span', { className: 'dgs-value' },
          h('span', { className: 'dgs-badge dgs-neutral' }, t('snapCount') + ' ' + (snap.count ?? 0)),
          h('span', { className: 'dgs-badge dgs-neutral' }, t('snapCurrent') + ' ' + (snap.current || t('snapNone'))),
        ),
      ),
      h('div', { className: 'dgs-row' },
        h('span', { className: 'dgs-label' }, t('restartMode')),
        h('span', { className: 'dgs-value' },
          h('span', { className: 'dgs-badge dgs-neutral' },
            restart.mode === 'systemd' ? t('modeSystemd') : t('modeBootGuard')),
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
  // 无条件注入全部样式（卡片边框/底色、Popover、遮罩等）：与卡片渲染解耦，
  // 插件一启动即就绪，避免只依赖组件 useEffect 调用导致样式表缺失、卡片退化
  // 为无边框裸文本（v0.7.2 起，参考 dsh-eco-fixes STYLE-DIFF-REPORT 同款根因）。
  injectStyles()
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-guard-restart: dictionaries')
  } catch { /* locale unavailable: degrade quietly */ }
  const t = ctx.locale.bind(NS)
  let scope = null
  try { scope = ctx.settingsScope.bind({ namespace: NS }) } catch { /* no settings service */ }
  // 侧边栏 slot:挂载 GuardRestartRow(圆钮 supervisor 的 React 生命周期载体;
  // v0.7.0 起不再渲染 footer 锚点/不再应用 footerStack class)。
  try {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-guard-restart',
      order: 0,
      label: () => '守护重启',
    }, ({ wide }) => h(GuardRestartRow, { t, wide })))
  } catch { /* slot unavailable: button absent, rest unaffected */ }

  // 设置 > 插件 > 插件配置：「守护重启」状态卡片（v0.8.0 起展示自带守护链
  // boot-guard / guard-cli / 启动清单 + systemd + 快照状态，来自 /status）。
  if (scope) {
    try {
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: NS,
          id: NS,
          order: 50,
          label: '守护重启',
        }, (props) => h(GuardStatusCard, Object.assign({ t }, props)))
      })
    } catch { /* no settings card */ }
  }
}

return module.exports; } });