export const APP_NAME = 'Claude Code usage'

const SVG = {
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevrons: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  flow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
}

export const RANGE_PRESETS = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: '12m', label: 'Last 12 months' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'ytd', label: 'Year to date' },
]

export const live = {
  status: 'loading',
  data: null,
  error: null,
  listeners: new Set(),
  subscribe(listener) {
    this.listeners.add(listener)
    listener(this)
    return () => this.listeners.delete(listener)
  },
  set(next) {
    Object.assign(this, next)
    for (const listener of this.listeners) listener(this)
  },
}

export function $(id) {
  return document.getElementById(id)
}

export function el(tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'style') for (const [name, rule] of Object.entries(value)) node.style.setProperty(name, rule)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function icon(name, className) {
  const span = el('span', { class: className ? `icon ${className}` : 'icon', 'aria-hidden': 'true' })
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SVG[name]}</svg>`
  return span
}

export function readStore(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStore(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {}
}

export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const SPINNER_FRAMES = ['·', '✢︎', '✳︎', '✶︎', '✻︎', '✽︎', '✻︎', '✶︎', '✳︎', '✢︎']
const SPINNER_STILL = '✻︎'
const SPINNER_MS = 120
let spinnerTimer = null
let spinnerFrame = 0

function spinnerText() {
  return reducedMotion() ? SPINNER_STILL : SPINNER_FRAMES[spinnerFrame]
}

function tickSpinners() {
  const nodes = document.querySelectorAll('.spinner')
  if (!nodes.length || reducedMotion()) {
    window.clearInterval(spinnerTimer)
    spinnerTimer = null
    for (const node of nodes) node.textContent = SPINNER_STILL
    return
  }
  if (document.hidden) return
  spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length
  const text = SPINNER_FRAMES[spinnerFrame]
  for (const node of nodes) node.textContent = text
}

export function spinner(label) {
  if (!spinnerTimer && !reducedMotion()) spinnerTimer = window.setInterval(tickSpinners, SPINNER_MS)
  return el('span', label ? { class: 'spinner', role: 'img', 'aria-label': label, title: label } : { class: 'spinner', 'aria-hidden': 'true' }, spinnerText())
}

export function statusDot(session) {
  if (!session) return null
  if (session.status === 'busy') return spinner(session.statusLabel)
  const tone = session.status === 'waiting' || session.status === 'blocked' ? 'waiting' : 'idle'
  return el('span', { class: `dot dot-${tone}`, role: 'img', 'aria-label': session.statusLabel, title: session.statusLabel })
}

export function activityText(activity, extra) {
  const meta = joinMeta([activity.sinceLabel, ...(extra || [])])
  return el(
    'span',
    { class: 'live-text' },
    el('span', { class: 'live-label' }, activity.label),
    activity.target ? el('span', { class: 'live-target' }, activity.target) : null,
    activity.moreLabel ? el('span', { class: 'live-more' }, activity.moreLabel) : null,
    meta ? el('span', { class: 'live-meta' }, meta) : null,
  )
}

export function liveLine(activity) {
  return el('p', { class: 'live-line' }, spinner(), activityText(activity))
}

export function setTitle(text) {
  document.title = text ? `${text} · ${APP_NAME}` : APP_NAME
  const title = $('topbar-title')
  if (title) title.textContent = text || APP_NAME
}

const VIEW_PATHS = { overview: '/overview', conversations: '/conversations', projects: '/projects', skills: '/skills', plugins: '/plugins', analytics: '/analytics', settings: '/settings' }

export function urlFor({ view, session, agent, ...params }) {
  const search = new URLSearchParams()
  if (agent) search.set('agent', agent)
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const pathname = session ? `/chat/${encodeURIComponent(session)}` : VIEW_PATHS[view] || VIEW_PATHS.overview
  const text = search.toString()
  return text ? `${pathname}?${text}` : pathname
}

export function routeFor(location) {
  const params = new URLSearchParams(location.search)
  const pathname = location.pathname.replace(/\/+$/, '') || '/'
  const agentMatch = /^\/chat\/([^/]+)\/agents\/([^/]+)$/.exec(pathname)
  const chatMatch = /^\/chat\/([^/]+)$/.exec(pathname)
  if (agentMatch || chatMatch) {
    const match = agentMatch || chatMatch
    params.set('session', decodeURIComponent(match[1]))
    if (agentMatch) params.set('agent', decodeURIComponent(agentMatch[2]))
    return { view: null, session: params.get('session'), agent: params.get('agent') || null, params }
  }
  const view = Object.keys(VIEW_PATHS).find((key) => VIEW_PATHS[key] === pathname) || (pathname === '/' ? 'overview' : 'notfound')
  return { view, session: null, agent: null, params }
}

export const THEMES = [
  { key: 'system', label: 'System', note: 'Follows the setting of your computer.' },
  { key: 'light', label: 'Light', note: 'Warm off-white background.' },
  { key: 'dark', label: 'Dark', note: 'Warm dark grey background.' },
]

export function currentTheme() {
  const stored = readStore('claude-dashboard-theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

export function setTheme(key) {
  if (key === 'light' || key === 'dark') {
    document.documentElement.dataset.theme = key
    writeStore('claude-dashboard-theme', key)
  } else {
    delete document.documentElement.dataset.theme
    writeStore('claude-dashboard-theme', null)
  }
}

export function navigate(href, options = {}) {
  const current = `${window.location.pathname}${window.location.search}`
  if (href !== current) {
    if (options.replace) window.history.replaceState(null, '', href)
    else window.history.pushState(null, '', href)
  }
  window.dispatchEvent(new Event('routechange'))
}

export function link(href, props, ...children) {
  return el(
    'a',
    {
      ...props,
      href,
      onclick: (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        if (props && props.onnavigate) props.onnavigate()
        navigate(href)
      },
      onnavigate: null,
    },
    ...children,
  )
}

export async function getJson(url) {
  let response
  try {
    response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })
  } catch {
    throw new Error('The dashboard server is not reachable. Start it again from your terminal.')
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) throw new Error((body && body.error) || `The dashboard server answered with status ${response.status}.`)
  return body
}

export async function postJson(url, data) {
  let response
  try {
    response = await fetch(url, { method: 'POST', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  } catch {
    throw new Error('The dashboard server is not reachable. Start it again from your terminal.')
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) throw new Error((body && body.error) || `The dashboard server answered with status ${response.status}.`)
  return body
}

export function keepFocus(container, render) {
  const active = document.activeElement
  const key = active && container.contains(active) ? active.getAttribute('data-focus') : null
  render()
  if (!key) return
  const next = container.querySelector(`[data-focus="${CSS.escape(key)}"]`)
  if (next) next.focus({ preventScroll: true })
}

export function skeleton(className) {
  return el('div', { class: `skeleton ${className}`, 'aria-hidden': 'true' })
}

export function stateBlock({ title, text, actions, tone }) {
  return el(
    'div',
    { class: tone === 'error' ? 'state state-error' : 'state', role: tone === 'error' ? 'alert' : null },
    el('p', { class: 'state-title' }, title),
    text ? el('p', { class: 'state-text' }, text) : null,
    actions && actions.length ? el('div', { class: 'state-actions' }, actions) : null,
  )
}

export function button(label, onclick, className) {
  return el('button', { class: className ? `button ${className}` : 'button', type: 'button', onclick }, label)
}

export function errorBlock(title, message, retry) {
  return stateBlock({ title, text: message, tone: 'error', actions: [button('Try again', retry)] })
}

export function banner(text) {
  return el('div', { class: 'banner', role: 'status' }, text)
}

export function badge(status, label) {
  return el('span', { class: `badge badge-${status}` }, label)
}

export function joinMeta(parts) {
  return parts.filter(Boolean).join(' · ')
}

export function statTile(label, value, note) {
  return el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, label), el('span', { class: 'stat-value' }, value), note ? el('span', { class: 'stat-note' }, note) : null)
}

export function statsSkeleton(count = 4) {
  return el('div', { class: 'stats' }, Array.from({ length: count }, () => el('div', { class: 'stat' }, skeleton('line w-40'), skeleton('value w-60'))))
}

export function linesSkeleton(count = 3) {
  return el('div', { class: 'lines-skeleton' }, Array.from({ length: count }, (_, index) => skeleton(`line ${['w-80', 'w-60', 'w-40'][index % 3]}`)))
}

export function th(label, className) {
  return el('th', { class: className || null, scope: 'col' }, label)
}

export function fact(label, value) {
  return [el('dt', null, label), el('dd', null, value)]
}

export function heat(share) {
  return el('span', { class: 'heat', 'aria-hidden': 'true' }, el('span', { style: { width: `${Math.max(0, Math.min(1, share || 0)) * 100}%` } }))
}

export function shareRows(rows) {
  return el(
    'div',
    { class: 'share-rows' },
    rows.map((row) =>
      el(
        'div',
        { class: `share-row share-${row.key}` },
        el('span', { class: 'share-label' }, row.label),
        el('span', { class: 'share-value' }, row.valueLabel),
        row.detailLabel ? el('span', { class: 'share-detail' }, row.detailLabel) : null,
        row.share === null ? null : el('span', { class: 'track', 'aria-hidden': 'true' }, el('span', { style: { width: `${Math.max(0, Math.min(1, row.share || 0)) * 100}%` } })),
      ),
    ),
  )
}

export function card(title, content, extra) {
  return el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { class: 'card-title' }, title), extra || null), content)
}

export function copyButton(text, label = 'Copy') {
  const status = el('span', { class: 'copy-status', role: 'status' })
  const trigger = el(
    'button',
    {
      class: 'button small',
      type: 'button',
      'data-focus': 'copy',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text)
          status.textContent = 'Copied'
        } catch {
          status.textContent = 'Copy failed. Select the text and copy it by hand.'
        }
      },
    },
    label,
  )
  return [trigger, status]
}

export function createMenu(container, { label, onSelect, align }) {
  const text = el('span', { class: 'menu-text' })
  const trigger = el('button', { class: 'button menu-trigger', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label, 'data-focus': `menu-${label}` }, text, icon('chevrons'))
  const panel = el('div', { class: align === 'end' ? 'menu-panel menu-end' : align === 'up' ? 'menu-panel menu-up' : 'menu-panel', role: 'menu', hidden: true })
  container.replaceChildren(trigger, panel)
  const outside = (event) => {
    if (!container.contains(event.target)) setOpen(false)
  }
  function setOpen(open) {
    panel.hidden = !open
    trigger.setAttribute('aria-expanded', String(open))
    if (open) document.addEventListener('pointerdown', outside, true)
    else document.removeEventListener('pointerdown', outside, true)
  }
  trigger.addEventListener('click', () => setOpen(panel.hidden))
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return
    event.stopPropagation()
    setOpen(false)
    trigger.focus()
  })
  function item(entry, selected) {
    return el(
      'button',
      {
        class: 'menu-item',
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': String(selected),
        onclick: () => {
          setOpen(false)
          onSelect(entry.key)
        },
      },
      el('span', null, entry.label),
      selected ? icon('check') : el('span', { class: 'icon-space' }),
    )
  }
  return {
    render(labelText, items, selectedKey, footer) {
      text.textContent = labelText
      panel.replaceChildren(...items.map((entry) => item(entry, entry.key === selectedKey)), ...(footer ? [footer] : []))
    },
    close: () => setOpen(false),
  }
}

export function rangeMenu(container, { onChange }) {
  let menu = null
  function customForm(query, close) {
    const isCustom = query.get('range') === 'custom'
    const from = el('input', { class: 'input', type: 'date', value: isCustom ? query.get('from') || '' : '', required: true })
    const to = el('input', { class: 'input', type: 'date', value: isCustom ? query.get('to') || '' : '', required: true })
    const error = el('p', { class: 'form-error', role: 'alert', hidden: true })
    const form = el(
      'form',
      {
        class: 'custom-range',
        hidden: !isCustom,
        onsubmit: (event) => {
          event.preventDefault()
          if (!from.value || !to.value || from.value > to.value) {
            error.textContent = 'Pick a start date on or before the end date.'
            error.hidden = false
            return
          }
          close()
          onChange({ range: 'custom', from: from.value, to: to.value })
        },
      },
      el('label', { class: 'field' }, el('span', null, 'From'), from),
      el('label', { class: 'field' }, el('span', null, 'To'), to),
      error,
      el('button', { class: 'button primary', type: 'submit' }, 'Apply'),
    )
    const toggle = el(
      'button',
      {
        class: 'menu-item',
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': String(isCustom),
        'aria-expanded': String(isCustom),
        onclick: () => {
          form.hidden = !form.hidden
          toggle.setAttribute('aria-expanded', String(!form.hidden))
          if (!form.hidden) from.focus()
        },
      },
      el('span', null, 'Custom range…'),
      isCustom ? icon('check') : el('span', { class: 'icon-space' }),
    )
    return el('div', { class: 'menu-footer' }, toggle, form)
  }
  menu = createMenu(container, { label: 'Date range', onSelect: (key) => onChange({ range: key === 'all' ? null : key, from: null, to: null }) })
  return {
    render(query, rangeData) {
      const key = query.get('range') || 'all'
      const preset = RANGE_PRESETS.find((entry) => entry.key === key)
      const label = key === 'custom' ? (rangeData && rangeData.key === 'custom' ? rangeData.label : 'Custom range') : preset ? preset.label : RANGE_PRESETS[0].label
      menu.render(label, RANGE_PRESETS, key, customForm(query, () => menu.close()))
    },
    close: () => menu.close(),
  }
}

export function pager(data, onPage) {
  if (data.pages <= 1) return el('p', { class: 'meta pager' }, data.pageLabel)
  return el(
    'div',
    { class: 'pager' },
    el('p', { class: 'meta' }, data.pageLabel),
    el(
      'div',
      { class: 'pager-buttons' },
      el('button', { class: 'button', type: 'button', disabled: data.page <= 1, 'data-focus': 'previous-page', onclick: () => onPage(data.page - 1) }, 'Previous'),
      el('button', { class: 'button', type: 'button', disabled: data.page >= data.pages, 'data-focus': 'next-page', onclick: () => onPage(data.page + 1) }, 'Next'),
    ),
  )
}

export function scanBlock(scan) {
  const percent = scan ? scan.percent : 0
  return el(
    'div',
    { class: 'scan' },
    el('p', { class: 'meta' }, scan ? scan.label : 'Reading your Claude Code transcripts.'),
    el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent), 'aria-label': 'Reading transcripts' }, el('div', { class: 'progress-bar', style: { width: `${percent}%` } })),
  )
}

export function createResource(getUrl, onChange) {
  let request = 0
  let scanTimer = null
  const state = { status: 'loading', data: null, error: null, refreshError: null, scan: null }
  async function load(options = {}) {
    const id = ++request
    window.clearTimeout(scanTimer)
    if (!options.silent) {
      state.status = state.data ? 'refreshing' : 'loading'
      onChange(state)
    }
    try {
      const data = await getJson(getUrl())
      if (id !== request) return
      if (data.status === 'scanning') {
        Object.assign(state, { status: 'scanning', scan: data.scan, error: null })
        scanTimer = window.setTimeout(() => load({ silent: true }), 1000)
      } else Object.assign(state, { status: 'ready', data, error: null, refreshError: null, scan: null })
    } catch (error) {
      if (id !== request) return
      if (options.silent && state.data) Object.assign(state, { status: 'ready', refreshError: error.message })
      else Object.assign(state, { status: 'error', data: null, error: error.message })
    }
    onChange(state)
  }
  return {
    state,
    load,
    cancel() {
      request++
      window.clearTimeout(scanTimer)
    },
  }
}

export function every(ms, run) {
  const timer = window.setInterval(() => {
    if (!document.hidden) run()
  }, ms)
  return () => window.clearInterval(timer)
}
