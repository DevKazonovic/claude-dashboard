const os = require('os')
const path = require('path')
const format = require('./format')
const { createJsonCache, realpathSafe } = require('./collector')

const STALE_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const GROUP_TITLES = { session: null, weekly: 'Weekly limits' }

function str(value) {
  return typeof value === 'string' ? value : ''
}

function planLabel(account) {
  const tier = str(account.userRateLimitTier) || str(account.organizationRateLimitTier)
  const max = /max_(\d+)x/.exec(tier)
  const plan = max ? `Max ${max[1]}x` : /enterprise/.test(tier) ? 'Enterprise' : /pro/.test(tier) ? 'Pro' : null
  const team = /team/.test(str(account.seatTier)) ? 'Team' : null
  return [team, plan].filter(Boolean).join(', ') || null
}

function resetLabel(resetAt, now) {
  if (resetAt - now < DAY_MS) return `Resets in ${format.duration(resetAt - now)}`
  return `Resets ${new Date(resetAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
}

function limitLabel(limit) {
  if (limit.kind === 'session') return 'Current session'
  if (limit.kind === 'weekly_all') return 'All models'
  const scope = limit.scope && typeof limit.scope === 'object' ? limit.scope : {}
  const model = scope.model && typeof scope.model === 'object' ? str(scope.model.display_name) : ''
  const surface = scope.surface && typeof scope.surface === 'object' ? str(scope.surface.display_name) : str(scope.surface)
  if (model || surface) return [model, surface].filter(Boolean).join(', ')
  return format.capitalize(str(limit.kind).replace(/_/g, ' ')) || 'Limit'
}

function limitDto(limit, now) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(limit.percent) || 0)))
  const resetAt = Date.parse(str(limit.resets_at))
  const passed = Number.isFinite(resetAt) && resetAt <= now
  const severity = passed ? 'normal' : ['warning', 'critical'].includes(limit.severity) ? limit.severity : 'normal'
  return {
    label: limitLabel(limit),
    percent,
    percentLabel: percent >= 100 && !passed ? 'Limit reached' : `${percent}% used`,
    severity,
    outdated: passed,
    resetLabel: !Number.isFinite(resetAt) ? null : passed ? `Reset at ${format.timeLabel(resetAt, now)}, after Claude Code last checked` : resetLabel(resetAt, now),
  }
}

function usageDto(entry, now) {
  const account = entry.account
  const usage = entry.usage && typeof entry.usage === 'object' ? entry.usage : null
  const fetchedAt = usage && Number.isFinite(usage.fetchedAtMs) ? usage.fetchedAtMs : null
  const sameAccount = usage && (!usage.accountUuid || usage.accountUuid === account.accountUuid)
  const limits = sameAccount && usage.utilization && Array.isArray(usage.utilization.limits) ? usage.utilization.limits.filter((limit) => limit && typeof limit === 'object') : []
  const groups = new Map()
  for (const limit of limits) {
    const key = limit.group in GROUP_TITLES ? limit.group : 'other'
    if (!groups.has(key)) groups.set(key, { key, title: key in GROUP_TITLES ? GROUP_TITLES[key] : 'Other limits', limits: [] })
    groups.get(key).limits.push(limitDto(limit, now))
  }
  return {
    key: str(account.accountUuid),
    email: str(account.emailAddress) || 'Email not saved',
    name: str(account.displayName) || str(account.fullName) || null,
    organizationLabel: str(account.organizationName) || null,
    planLabel: planLabel(account),
    folderLabel: format.homePath(entry.configDir),
    groups: [...groups.values()],
    checkedLabel: fetchedAt && sameAccount ? `Claude Code checked these ${format.ago(fetchedAt, now)}.` : 'Claude Code has not saved usage limits for this account yet.',
    checkedShort: fetchedAt && sameAccount ? `Checked ${format.ago(fetchedAt, now)}` : 'Not checked yet',
    stale: Boolean(fetchedAt && sameAccount && now - fetchedAt > STALE_MS),
    staleNote: fetchedAt && sameAccount && now - fetchedAt > STALE_MS ? 'Open Claude Code with this account to refresh them.' : null,
  }
}

function createAccounts(collector) {
  const readJson = createJsonCache()
  const home = os.homedir()

  async function load() {
    await collector.init()
    const defaultDir = await realpathSafe(path.join(home, '.claude'))
    const entries = []
    for (const configDir of collector.configDirs()) {
      const realDir = (await realpathSafe(configDir)) || configDir
      const files = [path.join(configDir, '.claude.json')]
      if (realDir === defaultDir) files.push(path.join(home, '.claude.json'))
      for (const file of files) {
        const data = await readJson(file)
        if (!data || !data.oauthAccount || typeof data.oauthAccount !== 'object') continue
        entries.push({ configDir, realDir, account: data.oauthAccount, usage: data.cachedUsageUtilization || null })
        break
      }
    }
    const byAccount = new Map()
    for (const entry of entries) {
      const key = str(entry.account.accountUuid) || entry.realDir
      const known = byAccount.get(key)
      const fetched = (value) => (value.usage && Number.isFinite(value.usage.fetchedAtMs) ? value.usage.fetchedAtMs : 0)
      if (!known || fetched(entry) > fetched(known)) byAccount.set(key, { ...entry, dirs: [...(known ? known.dirs : []), entry.realDir] })
      else known.dirs.push(entry.realDir)
    }
    return [...byAccount.values()]
  }

  async function resolve(item, entries) {
    const data = item.loaded.main ? item.loaded.main.data : null
    const byDir = async (dir) => {
      if (!dir) return null
      const real = (await realpathSafe(dir)) || path.resolve(dir)
      return entries.find((entry) => entry.dirs.includes(real)) || null
    }
    const live = item.record ? await byDir(item.record.configDir) : null
    if (live) return live
    if (data && data.ownerAccount) return entries.find((entry) => str(entry.account.accountUuid) === data.ownerAccount) || { missing: true }
    return (data && (await byDir(data.settingsRoot))) || null
  }

  return {
    async folders() {
      await collector.init()
      const entries = await load()
      const folders = []
      for (const configDir of collector.configDirs()) {
        const realDir = (await realpathSafe(configDir)) || configDir
        const entry = entries.find((item) => item.dirs.includes(realDir))
        const projects = (await realpathSafe(path.join(configDir, 'projects'))) || null
        folders.push({
          label: format.homePath(configDir),
          accountLabel: entry ? str(entry.account.emailAddress) || 'Email not saved' : 'No account signed in',
          projectsLabel: projects ? `Transcripts in ${format.homePath(projects)}` : 'No transcripts folder',
        })
      }
      return folders
    },
    async list() {
      const now = Date.now()
      return { generatedAt: now, accounts: (await load()).map((entry) => usageDto(entry, now)) }
    },
    async forSession(item) {
      const entries = await load()
      const entry = await resolve(item, entries)
      if (entry && !entry.missing) return { known: true, key: str(entry.account.accountUuid), label: str(entry.account.emailAddress) || 'Email not saved', note: null }
      if (entry && entry.missing) return { known: false, key: null, label: 'Account not signed in here', note: 'This conversation ran on an account that is no longer signed in to Claude Code on this computer.' }
      return { known: false, key: null, label: 'Account not recorded', note: 'Claude Code did not record which account ran this conversation.' }
    },
  }
}

module.exports = { createAccounts }
