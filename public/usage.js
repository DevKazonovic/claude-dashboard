import { el, icon, button, linesSkeleton, joinMeta, keepFocus, readStore, writeStore, createResource, postJson } from './ui.js'

const REFRESH_MS = 60000

function meterClass(limit) {
  return `usage-meter severity-${limit.severity}${limit.outdated ? ' is-outdated' : ''}`
}

function bar(limit) {
  return el(
    'div',
    { class: 'usage-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(limit.percent), 'aria-label': `${limit.label}: ${limit.percentLabel}` },
    el('span', { style: { width: `${limit.percent}%` } }),
  )
}

function meter(limit) {
  return el(
    'div',
    { class: meterClass(limit) },
    el('div', { class: 'usage-meter-row' }, el('span', { class: 'usage-meter-label' }, limit.label), el('span', { class: 'usage-meter-value' }, limit.percentLabel)),
    bar(limit),
    limit.resetLabel ? el('p', { class: 'usage-reset' }, limit.resetLabel) : null,
  )
}

function checkView(account, refreshing, refresh) {
  return el(
    'span',
    { class: 'usage-strip-check' },
    el('span', { class: `usage-strip-checked${account.stale && !refreshing.error ? ' is-stale' : ''}`, title: account.checkedLabel }, refreshing.busy ? 'Checking now' : account.checkedShort),
    el('button', { class: 'text-button', type: 'button', 'data-focus': `refresh-${account.key}`, disabled: refreshing.busy, onclick: () => refresh(account.key) }, refreshing.busy ? 'Refreshing' : 'Refresh'),
  )
}

function accountView(account, refreshing, refresh) {
  const limits = account.groups.flatMap((group) => group.limits)
  return el(
    'div',
    { class: 'usage-strip', 'aria-label': `Usage limits for ${account.email}` },
    el(
      'div',
      { class: 'usage-strip-head' },
      el('span', { class: 'usage-strip-account' }, account.email),
      el('span', { class: 'usage-strip-plan' }, joinMeta([account.planLabel, account.organizationLabel])),
      checkView(account, refreshing, refresh),
    ),
    refreshing.error ? el('p', { class: 'usage-error-line', role: 'alert' }, refreshing.error) : null,
    limits.length ? el('div', { class: 'usage-strip-meters' }, limits.map(meter)) : el('p', { class: 'usage-reset' }, account.checkedLabel),
    account.staleNote && !refreshing.busy ? el('p', { class: 'usage-reset' }, account.staleNote) : null,
  )
}

function summaryView(account) {
  return el(
    'div',
    { class: 'usage-summary' },
    el('span', { class: 'usage-strip-account' }, account.email),
    account.summaryLimits
      ? el(
          'div',
          { class: 'usage-bars' },
          account.summaryLimits.flatMap((limit) => [el('span', { class: 'usage-bars-label' }, limit.label), el('div', { class: meterClass(limit), title: limit.title }, bar(limit))]),
        )
      : el('span', { class: 'usage-reset' }, account.checkedShort),
  )
}

function tableView(accounts, stateOf, refresh) {
  return el(
    'div',
    { class: 'usage-table' },
    accounts.map((account) => {
      const refreshing = stateOf(account)
      return [
        el('span', { class: 'usage-strip-account usage-table-span' }, account.email),
        el('div', { class: 'usage-strip-head usage-table-span' }, el('span', { class: 'usage-strip-plan' }, account.planLabel), checkView(account, refreshing, refresh)),
        refreshing.error ? el('p', { class: 'usage-error-line usage-table-span', role: 'alert' }, refreshing.error) : null,
        account.limitRows
          ? account.limitRows.map((limit) => [
              el('span', { class: 'usage-table-label' }, limit.label),
              el('div', { class: meterClass(limit), title: limit.title }, bar(limit)),
              el('span', { class: `usage-table-percent severity-${limit.severity}${limit.outdated ? ' is-outdated' : ''}`, title: limit.title }, limit.percentLabel),
              el('span', { class: 'usage-table-reset', title: limit.title }, limit.resetLabel),
            ])
          : el('p', { class: 'usage-reset usage-table-span' }, account.checkedLabel),
      ]
    }),
  )
}

export function createUsage(holder, { only, emptyText, collapseKey }) {
  let timer = null
  const refreshing = new Map()
  const resource = createResource(() => '/api/accounts', render)
  const expanded = () => Boolean(collapseKey) && readStore(collapseKey) === 'expanded'
  function toggle() {
    writeStore(collapseKey, expanded() ? null : 'expanded')
    render(resource.state)
  }
  async function refresh(key) {
    refreshing.set(key, { busy: true, error: null })
    render(resource.state)
    try {
      const data = await postJson('/api/accounts/refresh', { key })
      refreshing.delete(key)
      Object.assign(resource.state, { status: 'ready', data, refreshError: null })
    } catch (error) {
      refreshing.set(key, { busy: false, error: error.message })
    }
    render(resource.state)
  }
  function render(state) {
    if (state.status === 'loading' && !state.data) return holder.replaceChildren(el('div', { class: 'usage-loading' }, linesSkeleton(2)))
    if (state.status === 'error') {
      return holder.replaceChildren(el('div', { class: 'usage-error', role: 'alert' }, el('p', null, `Could not load the usage limits. ${state.error}`), button('Try again', () => resource.load(), 'small')))
    }
    if (!state.data) return null
    const key = only ? only() : null
    const accounts = only ? state.data.accounts.filter((account) => key && account.key === key) : state.data.accounts
    if (!accounts.length) {
      holder.replaceChildren(...(emptyText ? [el('p', { class: 'usage-empty' }, emptyText)] : []))
      return null
    }
    const stateOf = (account) => refreshing.get(account.key) || { busy: false, error: null }
    const open = expanded()
    const nodes = collapseKey
      ? [
          el('button', { class: 'disclosure usage-toggle', type: 'button', 'aria-expanded': String(open), 'data-focus': 'usage-toggle', onclick: toggle }, icon('chevron', 'disclosure-chevron'), el('span', null, 'Usage limits')),
          open ? tableView(accounts, stateOf, refresh) : accounts.map(summaryView),
        ]
      : accounts.map((account) => accountView(account, stateOf(account), refresh))
    if (state.refreshError) nodes.push(el('p', { class: 'usage-reset' }, 'Could not refresh. Showing the last numbers.'))
    keepFocus(holder, () => holder.replaceChildren(...nodes.flat()))
    return null
  }
  return {
    start() {
      resource.load({ silent: Boolean(resource.state.data) })
      window.clearInterval(timer)
      timer = window.setInterval(() => {
        if (!document.hidden) resource.load({ silent: true })
      }, REFRESH_MS)
    },
    render: () => render(resource.state),
    expanded,
    stop() {
      window.clearInterval(timer)
      timer = null
      resource.cancel()
    },
  }
}
