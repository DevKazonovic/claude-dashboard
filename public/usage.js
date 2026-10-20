import { el, button, linesSkeleton, joinMeta, createResource } from './ui.js'

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

function accountView(account) {
  const limits = account.groups.flatMap((group) => group.limits)
  return el(
    'div',
    { class: 'usage-strip', 'aria-label': `Usage limits for ${account.email}` },
    el(
      'div',
      { class: 'usage-strip-head' },
      el('span', { class: 'usage-strip-account' }, account.email),
      el('span', { class: 'usage-strip-plan' }, joinMeta([account.planLabel, account.organizationLabel])),
      el('span', { class: `usage-strip-checked${account.stale ? ' is-stale' : ''}`, title: account.staleNote || account.checkedLabel }, account.checkedShort),
    ),
    limits.length ? el('div', { class: 'usage-strip-meters' }, limits.map(meter)) : el('p', { class: 'usage-reset' }, account.checkedLabel),
    account.staleNote ? el('p', { class: 'usage-reset' }, account.staleNote) : null,
  )
}

export function createUsage(holder, { only, emptyText }) {
  let timer = null
  const resource = createResource(() => '/api/accounts', render)
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
    const nodes = accounts.map(accountView)
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
