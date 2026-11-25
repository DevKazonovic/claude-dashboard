const MODULES = ['explore', 'code', 'learn', 'views']

export async function registerAll(api) {
  const loaded = await Promise.allSettled(MODULES.map((name) => import(`./understand-${name}.js`)))
  for (const [i, result] of loaded.entries()) {
    if (result.status === 'rejected') {
      console.error(`Understand ${MODULES[i]} module failed to load`, result.reason)
      continue
    }
    try {
      const cleanup = await result.value.register(api)
      if (typeof cleanup === 'function') api.onDestroy(cleanup)
    } catch (error) {
      console.error(`Understand ${MODULES[i]} module failed to start`, error)
    }
  }
}
