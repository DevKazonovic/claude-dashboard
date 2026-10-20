const os = require('os')
const path = require('path')

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat('en-US')

const WHERE = {
  'claude-vscode': 'VS Code',
  'claude-desktop': 'Desktop app',
  'claude-jetbrains': 'JetBrains',
  cli: 'Terminal',
  'sdk-ts': 'Agent SDK',
  'sdk-py': 'Agent SDK',
  'sdk-cli': 'Agent SDK',
}

const SESSION_STATUS = { busy: 'Working', idle: 'Idle', waiting: 'Needs input', blocked: 'Needs input' }
const AGENT_TYPES = { 'workflow-subagent': 'Workflow agent' }

function money(value) {
  if (value > 0 && value < 0.01) return '<$0.01'
  return usd.format(value || 0)
}

function tokens(value) {
  return compact.format(value || 0)
}

function count(value) {
  return whole.format(value || 0)
}

function plural(value, one, many) {
  return `${count(value)} ${value === 1 ? one : many}`
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

function dateLabel(ms, now) {
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })
}

function dateTimeLabel(ms) {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function ago(ms, now) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return dateLabel(ms, now)
}

function timeLabel(ms, now) {
  const date = new Date(ms)
  const today = new Date(now)
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === today.toDateString()) return time
  return `${dateLabel(ms, now)}, ${time}`
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return 'under 1 s'
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${plural(days, 'day', 'days')} ${hours % 24} h` : plural(days, 'day', 'days')
}

function percent(share) {
  if (!share || share <= 0) return '0%'
  if (share < 0.01) return 'under 1%'
  return `${Math.round(share * 100)}%`
}

function bytes(value) {
  const size = value || 0
  if (size >= 1e9) return `${(size / 1e9).toFixed(1)} GB`
  if (size >= 1e6) return `${Math.round(size / 1e6)} MB`
  if (size >= 1e3) return `${Math.round(size / 1e3)} KB`
  return `${size} B`
}

function homePath(value) {
  if (!value) return ''
  const home = os.homedir()
  if (value === home) return '~'
  return value.startsWith(home + path.sep) ? `~${value.slice(home.length)}` : value
}

function whereLabel(kind, entrypoint) {
  if (kind === 'background' || kind === 'bg') return 'Background'
  return WHERE[entrypoint] || entrypoint || 'Unknown'
}

function sessionStatusLabel(status) {
  return SESSION_STATUS[status] || capitalize(status || 'unknown')
}

function modelLabel(model) {
  const id = String(model || '').replace(/\[.*\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const parts = id.split('-')
  const familyIndex = parts.findIndex((part) => /^[a-z]+$/.test(part))
  if (familyIndex === -1) return String(model)
  const version = parts.filter((_, index) => index !== familyIndex).join('.')
  return `${capitalize(parts[familyIndex])}${version ? ` ${version}` : ''}`
}

function agentTypeLabel(type) {
  if (!type) return 'Agent'
  return AGENT_TYPES[type] || capitalize(type.replace(/[-_]+/g, ' '))
}

module.exports = {
  money,
  tokens,
  count,
  plural,
  capitalize,
  dateLabel,
  dateTimeLabel,
  timeLabel,
  duration,
  percent,
  ago,
  bytes,
  homePath,
  whereLabel,
  sessionStatusLabel,
  modelLabel,
  agentTypeLabel,
}
