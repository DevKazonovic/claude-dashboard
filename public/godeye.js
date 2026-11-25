import { $, el, icon, link, urlFor, navigate, setTitle, createResource, stateBlock, errorBlock, linesSkeleton, button, keepFocus, postJson } from './ui.js'
import { pageShell } from './pages.js'

const MAX_FILE_BYTES = 8 * 1024 * 1024

function hasFiles(event) {
  return Boolean(event.dataTransfer) && [...event.dataTransfer.types].includes('Files')
}

function dropZone(source, highlight, onDrop) {
  let depth = 0
  const handlers = {
    dragenter(event) {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      highlight.classList.add('is-dropping')
    },
    dragover(event) {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    dragleave() {
      depth = Math.max(0, depth - 1)
      if (!depth) highlight.classList.remove('is-dropping')
    },
    drop(event) {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      highlight.classList.remove('is-dropping')
      onDrop([...event.dataTransfer.files])
    },
  }
  for (const [type, handler] of Object.entries(handlers)) source.addEventListener(type, handler)
  return () => {
    for (const [type, handler] of Object.entries(handlers)) source.removeEventListener(type, handler)
  }
}

function guardDrops() {
  const stop = (event) => {
    if (!hasFiles(event) || event.defaultPrevented) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'none'
  }
  window.addEventListener('dragover', stop)
  window.addEventListener('drop', stop)
  return () => {
    window.removeEventListener('dragover', stop)
    window.removeEventListener('drop', stop)
  }
}

function note(status, value, error) {
  status.textContent = value
  status.classList.toggle('is-error', Boolean(error))
}

async function addMaps(project, files, status) {
  if (!files.length) return note(status, 'Drop a .json design file saved by /godeye.', true)
  note(status, files.length > 1 ? `Adding ${files.length} designs…` : 'Adding the design…')
  const added = []
  const failed = []
  for (const file of files) {
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is too large to be a design.`)
      added.push((await postJson('/api/godeye/maps', { project, file: file.name, text: await file.text() })).title)
    } catch (error) {
      failed.push(error.message)
    }
  }
  note(status, [added.length ? `Added ${added.join(', ')} to ${project}.` : '', ...failed].filter(Boolean).join(' '), failed.length > 0)
}

function browseView(container, initial) {
  setTitle('GodEye')
  let current = initial || null
  let data = null
  const status = el('p', { class: 'godeye-status', role: 'status' })
  const name = el('input', { class: 'input', type: 'text', name: 'project', placeholder: 'New project…', 'aria-label': 'New project name', autocomplete: 'off', spellcheck: 'false', maxlength: '60', required: true, oninput: () => (formError.hidden = true) })
  const create = el('button', { class: 'button', type: 'submit', 'aria-label': 'Create project', title: 'Create project' }, icon('plus'))
  const formError = el('p', { class: 'form-error', role: 'alert', hidden: true })
  const form = el(
    'form',
    {
      class: 'godeye-new',
      onsubmit: async (event) => {
        event.preventDefault()
        create.disabled = true
        formError.hidden = true
        try {
          const result = await postJson('/api/godeye/projects', { name: name.value })
          name.value = ''
          await resource.load({ silent: true })
          navigate(urlFor({ view: 'godeye', project: result.name }))
        } catch (error) {
          formError.textContent = error.message
          formError.hidden = false
          name.focus()
        }
        create.disabled = false
      },
    },
    name,
    create,
  )
  const list = el('nav', { class: 'godeye-projects', 'aria-label': 'Projects' })
  const side = el('aside', { class: 'godeye-side scroll-area', 'aria-label': 'GodEye projects' }, el('h2', { class: 'godeye-side-title' }, 'Projects'), form, formError, list)
  const main = el('div', { class: 'godeye-main scroll-area' })
  container.replaceChildren(el('div', { class: 'godeye-layout' }, side, main))
  const picker = el('input', {
    type: 'file',
    accept: '.json,application/json',
    multiple: true,
    hidden: true,
    onchange: () => {
      const files = [...picker.files]
      picker.value = ''
      upload(current, files)
    },
  })
  const addButton = el('button', { class: 'button primary', type: 'button', 'data-focus': 'add-map', onclick: () => picker.click() }, 'Add design')
  const resource = createResource(() => '/api/godeye', render)

  async function upload(project, files) {
    if (!project) return note(status, 'Create a project first, then drop the design into it.', true)
    await addMaps(project, files, status)
    await resource.load({ silent: true })
  }

  function item(project) {
    const node = link(
      urlFor({ view: 'godeye', project: project.name }),
      { class: 'nav-item godeye-project', 'aria-current': project.name === current ? 'page' : null, 'data-focus': `project-${project.name}`, title: project.name },
      el('span', { class: 'godeye-project-name' }, project.name),
      el('span', { class: 'godeye-project-count', 'aria-label': project.countLabel }, String(project.maps.length)),
    )
    dropZone(node, node, (files) => upload(project.name, files))
    return node
  }

  function card(map) {
    return link(
      urlFor({ view: 'godeye', project: current, map: map.id }),
      { class: 'plugin-card godeye-card', 'data-focus': `map-${map.id}` },
      el('span', { class: 'plugin-name' }, map.title),
      map.error ? el('span', { class: 'godeye-card-error' }, map.error) : el('span', { class: 'plugin-parts' }, map.partsLabel),
      el('span', { class: 'meta' }, map.updatedLabel),
    )
  }

  function renderSide() {
    const sorted = [...data.projects].sort((a, b) => a.name.localeCompare(b.name))
    keepFocus(list, () => list.replaceChildren(...(sorted.length ? sorted.map(item) : [el('p', { class: 'meta godeye-side-note' }, 'No projects yet.')])))
  }

  function renderMain() {
    const project = data.projects.find((entry) => entry.name === current)
    setTitle(project ? project.name : 'GodEye')
    if (!project) {
      const empty = data.projects.length
        ? stateBlock({ title: 'This project was not found', text: `There is no ${current} folder in ${data.folderLabel}. Pick a project on the left.` })
        : stateBlock({ title: 'No projects yet', text: 'Create a project on the left, then drag the design files /godeye saves into it.' })
      main.replaceChildren(el('div', { class: 'page' }, empty))
      return
    }
    keepFocus(main, () => {
      const { actions, body } = pageShell(main, { title: project.name, intro: 'Drag design files saved by /godeye anywhere here to add them. A file with the same name replaces its design.' })
      actions.append(addButton, picker)
      body.before(status)
      body.replaceChildren(project.maps.length ? el('div', { class: 'plugin-grid' }, project.maps.map(card)) : stateBlock({ title: 'Drop a design here', text: 'Drag the .json file /godeye saved, from Finder or VS Code, or use Add design.' }))
    })
  }

  function render(state) {
    if (state.status === 'loading') {
      list.replaceChildren(linesSkeleton(3))
      main.replaceChildren(el('div', { class: 'page' }, linesSkeleton(4)))
      return
    }
    if (state.status === 'error') {
      main.replaceChildren(el('div', { class: 'page' }, errorBlock('Could not load your projects', state.error, () => resource.load())))
      return
    }
    data = state.data
    if (!current && data.projects.length) {
      current = data.projects[0].name
      navigate(urlFor({ view: 'godeye', project: current }), { replace: true })
    }
    renderSide()
    renderMain()
  }

  resource.load()
  const release = dropZone(main, main, (files) => upload(current, files))
  const unguard = guardDrops()
  return {
    select(next) {
      if (!next) {
        if (data && data.projects.length) navigate(urlFor({ view: 'godeye', project: data.projects[0].name }), { replace: true })
        return
      }
      if (next === current) return
      current = next
      formError.hidden = true
      note(status, '')
      main.scrollTop = 0
      if (data) {
        renderSide()
        renderMain()
      }
    },
    destroy() {
      release()
      unguard()
      resource.cancel()
    },
  }
}

function mapView(container, project, id, sheet) {
  setTitle('GodEye')
  let started = false
  let sheets = null
  let wanted = sheet
  let gone = false
  container.replaceChildren(el('div', { class: 'page' }, linesSkeleton(4)))
  const failed = (message, retry) =>
    container.replaceChildren(el('div', { class: 'page' }, stateBlock({ title: 'Could not open this design', text: message, tone: 'error', actions: [button('Try again', retry), link(urlFor({ view: 'godeye', project }), { class: 'button' }, `Back to ${project}`)] })))
  const resource = createResource(
    () => `/api/godeye/map?${new URLSearchParams({ project, id })}`,
    (state) => {
      if (state.status === 'error') failed(state.error, () => resource.load())
      else if (state.status === 'ready' && !started) {
        started = true
        if (state.data.version !== 4) {
          container.replaceChildren(el('div', { class: 'page' }, stateBlock({ title: 'Old format. Run /godeye again for this feature.', actions: [link(urlFor({ view: 'godeye', project }), { class: 'button' }, `Back to ${project}`)] })))
        } else {
          import('./godeye-sheets.js')
            .then(({ drawSheets }) => {
              if (!gone) sheets = drawSheets(container, state.data, wanted)
            })
            .catch((error) => {
              if (!gone) failed(error.message, () => window.location.reload())
            })
        }
      }
    },
  )
  resource.load()
  const unguard = guardDrops()
  return {
    setSheet(next) {
      wanted = next
      if (sheets) sheets.setSheet(next)
    },
    destroy() {
      gone = true
      unguard()
      resource.cancel()
      if (sheets) sheets.destroy()
    },
  }
}

export function godeyePage(container, params) {
  let key = null
  let view = null

  function mount(next) {
    const project = next.get('project')
    const id = project ? next.get('map') : null
    if (!id && view && view.select) {
      view.select(project)
      return false
    }
    const nextKey = id ? JSON.stringify([project, id]) : 'browse'
    if (nextKey === key) {
      if (view.setSheet) view.setSheet(next.get('sheet'))
      return false
    }
    key = nextKey
    if (view) view.destroy()
    view = id ? mapView(container, project, id, next.get('sheet')) : browseView(container, project)
    return true
  }

  mount(params)
  return {
    update(next) {
      if (!mount(next)) return
      $('scroller').scrollTop = 0
      container.focus({ preventScroll: true })
    },
    destroy() {
      view.destroy()
    },
  }
}
