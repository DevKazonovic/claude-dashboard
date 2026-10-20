const PRESETS = {
  all: 'All time',
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '12m': 'Last 12 months',
  this_month: 'This month',
  last_month: 'Last month',
  ytd: 'Year to date',
  custom: 'Custom range',
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function shift(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function parseDay(value) {
  if (!DAY.test(value || '')) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

function describe(start, end) {
  const label = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return start.getTime() === end.getTime() ? label(start) : `${label(start)} to ${label(end)}`
}

function allTime() {
  return { key: 'all', label: PRESETS.all, from: null, to: null, description: PRESETS.all }
}

function resolveRange(params, now) {
  const requested = params.get('range')
  const key = Object.prototype.hasOwnProperty.call(PRESETS, requested) ? requested : 'all'
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const span = (start, end) => {
    const description = describe(start, end)
    return { key, label: key === 'custom' ? description : PRESETS[key], from: dayKey(start), to: dayKey(end), description }
  }
  switch (key) {
    case 'today':
      return span(today, today)
    case 'yesterday':
      return span(shift(today, -1), shift(today, -1))
    case '7d':
      return span(shift(today, -6), today)
    case '30d':
      return span(shift(today, -29), today)
    case '90d':
      return span(shift(today, -89), today)
    case '12m': {
      const start = new Date(today)
      start.setFullYear(start.getFullYear() - 1)
      return span(shift(start, 1), today)
    }
    case 'this_month':
      return span(new Date(today.getFullYear(), today.getMonth(), 1), today)
    case 'last_month':
      return span(new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0))
    case 'ytd':
      return span(new Date(today.getFullYear(), 0, 1), today)
    case 'custom': {
      const start = parseDay(params.get('from'))
      const end = parseDay(params.get('to'))
      return start && end && start <= end ? span(start, end) : allTime()
    }
    default:
      return allTime()
  }
}

module.exports = { resolveRange, dayKey, parseDay, shift }
