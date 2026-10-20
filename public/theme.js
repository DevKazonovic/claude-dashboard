try {
  const theme = window.localStorage.getItem('claude-dashboard-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  if (window.localStorage.getItem('claude-dashboard-sidebar') === 'hidden') document.documentElement.dataset.sidebar = 'hidden'
} catch {}
