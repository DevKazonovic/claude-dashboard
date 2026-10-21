import { el, button, linesSkeleton, joinMeta, createResource, postJson } from './ui.js'

const REFRESH_MS = 60000

function meter(limit) {
  return el(
    'div',
    { class: `usage-meter severity-${limit.severity}${limit.outdated ? ' is-outdated' : ''}` },
    el('div', { class: 'usage-meter-row' }, el('span', { class: 'usage-meter-label' }, limit.label), el('span', { class: 'usage-meter-value' }, limit.percentLabel)),
    el(
      'div',
      { class: 'usage-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(limit.percent), 'aria-label': `${limit.label}: ${limit.percentLabel}` },
      el('span', { style: { width: `${limit.percent}%` } }),
    ),
    limit.resetLabel ? el('p', { class: 'usage-reset' }, limit.resetLabel) : null,
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
      el(
        'span',
        { class: 'usage-strip-check' },
        el('span', { class: `usage-strip-checked${account.stale && !refreshing.error ? ' is-stale' : ''}`, title: account.checkedLabel }, refreshing.busy ? 'Checking now' : account.checkedShort),
        el('button', { class: 'text-button', type: 'button', 'data-focus': `refresh-${account.key}`, disabled: refreshing.busy, onclick: () => refresh(account.key) }, refreshing.busy ? 'Refreshing' : 'Refresh'),
      ),
    ),
    refreshing.error ? el('p', { class: 'usage-error-line', role: 'alert' }, refreshing.error) : null,
    limits.length ? el('div', { class: 'usage-strip-meters' }, limits.map(meter)) : el('p', { class: 'usage-reset' }, account.checkedLabel),
    account.staleNote && !refreshing.busy ? el('p', { class: 'usage-reset' }, account.staleNote) : null,
  )
}

export function createUsage(holder, { only, emptyText }) {
  let timer = null
  const refreshing = new Map()
  const resource = createResource(() => '/api/accounts', render)
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
    const nodes = accounts.map((account) => accountView(account, refreshing.get(account.key) || { busy: false, error: null }, refresh))
    if (state.refreshError) nodes.push(el('p', { class: 'usage-reset' }, 'Could not refresh. Showing the last numbers.'))
    holder.replaceChildren(...nodes)
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
    stop() {
      window.clearInterval(timer)
      timer = null
      resource.cancel()
    },
  }
}
