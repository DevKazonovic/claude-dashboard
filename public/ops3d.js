import * as THREE from './vendor/three.module.min.js'
import { CSS3DRenderer, CSS3DObject } from './vendor/CSS3DRenderer.js'
import { el, reducedMotion } from './ui.js'

const BG = 0x0a0a0a
const TONES = { running: 0x6fcf97, waiting: 0xe8b75a, failed: 0xf28b82, done: 0x6b6b6b, idle: 0x6b6b6b }
const SCREEN_W = 440
const MAX_W = 680
const SCREEN_H = 300
const GAP = 32
const FOCUS_W = 680
const FOCUS_H = 500
const CREW_W = 300
const CREW_H = 160
const CREW_GAP = 10
const SIDE_GAP = 24
const TILT = 0.42
const PULL = 450
const PUSH = 420
const FIT_X = 0.95
const FIT_TOP = 0.82
const FIT_BOTTOM = -0.9
const HUD_BOTTOM = -0.8
const CLOSEST = 0.62
const RADIUS = 1500
const FLOOR = -560
const RADAR = 700
const TINY = 0.05
const LEAVE_MS = 450
const TAU = Math.PI * 2

function discTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.beginPath()
  context.arc(32, 32, 26, 0, TAU)
  context.fill()
  return new THREE.CanvasTexture(canvas)
}

function ring(radius) {
  const points = []
  for (let index = 0; index <= 96; index++) {
    const angle = (index / 96) * TAU
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius))
  }
  return new THREE.BufferGeometry().setFromPoints(points)
}

function line(opacity) {
  return new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false })
}

function normalOf(angle) {
  return new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle))
}

function corners(center, rotation, width, height) {
  const axis = new THREE.Vector3(Math.cos(rotation), 0, -Math.sin(rotation))
  const points = []
  for (const side of [-1, 1]) for (const lift of [-1, 1]) points.push(center.clone().addScaledVector(axis, (side * width) / 2).setY(center.y + (lift * height) / 2))
  return points
}

function plan(count, rows, aspect) {
  const span = (FIT_TOP - FIT_BOTTOM) / 2
  const cols = Math.ceil(count / rows)
  const tall = rows * SCREEN_H + (rows - 1) * GAP
  const width = Math.min(MAX_W, Math.max(SCREEN_W, ((aspect * FIT_X * tall) / span - (cols - 1) * GAP) / cols))
  const scale = Math.min((aspect * FIT_X) / (cols * width + (cols - 1) * GAP), span / tall)
  return { rows, width, area: scale * scale * width }
}

function slots(count, aspect) {
  if (!count) return { width: SCREEN_W, places: [] }
  let best = plan(count, 1, aspect)
  for (let rows = 2; rows <= Math.min(count, 4); rows++) {
    const next = plan(count, rows, aspect)
    if (next.area > best.area) best = next
  }
  const { rows, width } = best
  const step = (width + GAP) / RADIUS
  const places = []
  for (let row = 0; row < rows; row++) {
    const inRow = Math.floor(count / rows) + (row < count % rows ? 1 : 0)
    const y = ((rows - 1) / 2 - row) * (SCREEN_H + GAP)
    for (let col = 0; col < inRow; col++) {
      const angle = (col - (inRow - 1) / 2) * step
      places.push({ angle, position: new THREE.Vector3(Math.sin(angle) * RADIUS, y, -Math.cos(angle) * RADIUS) })
    }
  }
  return { width, places }
}

function anchorOf(slot) {
  return new THREE.Vector3(slot.position.x, 0, slot.position.z).addScaledVector(normalOf(slot.angle), PULL)
}

function cockpit(slot, count) {
  const tangent = new THREE.Vector3(Math.cos(slot.angle), 0, Math.sin(slot.angle))
  const normal = normalOf(slot.angle)
  const anchor = anchorOf(slot)
  const sides = [[], []]
  for (let index = 0; index < count; index++) sides[index % 2].push(index)
  const goals = []
  sides.forEach((list, side) => {
    const sign = side ? -1 : 1
    list.forEach((index, row) => {
      goals[index] = {
        position: anchor
          .clone()
          .addScaledVector(tangent, sign * (FOCUS_W / 2 + SIDE_GAP + (CREW_W / 2) * Math.cos(TILT)))
          .addScaledVector(normal, (CREW_W / 2) * Math.sin(TILT))
          .setY(((list.length - 1) / 2 - row) * (CREW_H + CREW_GAP)),
        rotation: -slot.angle - sign * TILT,
      }
    })
  })
  return { anchor, goals }
}

function goalOf(position, rotation, scale) {
  return { position: position.clone(), rotation, scale }
}

export function createScene(host, { onPick, onBack }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(BG, 1)
  const css = new CSS3DRenderer()
  css.domElement.className = 'ops-css'
  host.replaceChildren(renderer.domElement, css.domElement)

  const still = reducedMotion()
  const disc = discTexture()
  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(BG, 0.00042)
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 12000)
  const probe = new THREE.PerspectiveCamera(45, 1, 1, 12000)
  const ray = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const lean = new THREE.Vector2()
  const away = new THREE.Vector3()
  const base = new THREE.Vector3(0, 420, 3400)
  const gaze = new THREE.Vector3(0, 0, -RADIUS)
  const screens = new Map()
  const crew = new Map()
  const leaving = new Set()
  const blips = new Map()
  let members = []
  let order = []
  let wide = SCREEN_W
  let target = { pos: base.clone(), look: gaze.clone() }
  let focus = null
  let swoop = 0
  let frame = 0
  let last = performance.now()
  let time = 0

  const grid = new THREE.GridHelper(9000, 90, 0x2e2e2e, 0x1c1c1c)
  grid.material.transparent = true
  grid.material.opacity = 0.9
  grid.material.depthWrite = false
  grid.position.y = FLOOR
  scene.add(grid)

  const radar = new THREE.Group()
  const fades = []
  const faded = (material) => {
    fades.push([material, material.opacity])
    return material
  }
  radar.position.set(0, FLOOR + 2, -RADIUS * 0.75)
  for (const share of [0.25, 0.5, 0.75, 1]) radar.add(new THREE.LineLoop(ring(RADAR * share), faded(line(share === 1 ? 0.2 : 0.08))))
  const spokes = []
  for (let index = 0; index < 12; index++) {
    const angle = (index / 12) * TAU
    spokes.push(new THREE.Vector3(), new THREE.Vector3(Math.cos(angle) * RADAR, 0, Math.sin(angle) * RADAR))
  }
  radar.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), faded(line(0.05))))
  const sweep = new THREE.Group()
  const wedge = new THREE.Mesh(new THREE.CircleGeometry(RADAR, 48, 0, 0.55), faded(new THREE.MeshBasicMaterial({ color: TONES.running, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide })))
  wedge.rotation.x = -Math.PI / 2
  sweep.add(wedge, new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(RADAR, 0, 0)]), faded(new THREE.LineBasicMaterial({ color: TONES.running, transparent: true, opacity: 0.6, depthWrite: false }))))
  sweep.visible = false
  radar.add(sweep)
  scene.add(radar)
  let presence = 1

  function fits(points, pos, look, bottom) {
    probe.aspect = camera.aspect
    probe.updateProjectionMatrix()
    probe.position.copy(pos)
    probe.lookAt(look)
    probe.updateMatrixWorld()
    return points.every((point) => {
      const p = point.clone().project(probe)
      return p.z < 1 && Math.abs(p.x) < FIT_X && p.y < FIT_TOP && p.y > bottom
    })
  }

  function overview() {
    const points = [...screens.values()].flatMap((screen) => corners(screen.slot.position, -screen.slot.angle, wide, SCREEN_H))
    const look = new THREE.Vector3(0, 0, -RADIUS)
    if (!points.length) return { pos: new THREE.Vector3(0, 40, 900), look }
    let near = -RADIUS * 0.6
    let far = RADIUS * 3
    for (let step = 0; step < 24; step++) {
      const z = (near + far) / 2
      if (fits(points, new THREE.Vector3(0, 40, z), look, FIT_BOTTOM)) far = z
      else near = z
    }
    return { pos: new THREE.Vector3(0, 40, far), look }
  }

  function closeup(slot, layout) {
    const normal = normalOf(slot.angle)
    const look = layout.anchor.clone()
    const points = [...corners(look, -slot.angle, FOCUS_W, FOCUS_H), ...layout.goals.flatMap((goal) => corners(goal.position, goal.rotation, CREW_W, CREW_H))]
    let near = 0
    let far = RADIUS * 3
    for (let step = 0; step < 24; step++) {
      const distance = (near + far) / 2
      if (fits(points, look.clone().addScaledVector(normal, distance), look, HUD_BOTTOM)) far = distance
      else near = distance
    }
    const closest = FOCUS_H / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / CLOSEST
    return { pos: look.clone().addScaledVector(normal, Math.max(far, closest)), look }
  }

  function aim() {
    const slot = focus ? screens.get(focus).slot : null
    const layout = slot ? cockpit(slot, members.length) : null
    for (const [id, screen] of screens) {
      const { position, angle } = screen.slot
      screen.goal.rotation = -angle
      if (id === focus) screen.goal.position.copy(layout.anchor)
      else if (focus) screen.goal.position.copy(position).addScaledVector(normalOf(angle), -PUSH)
      else screen.goal.position.copy(position)
    }
    members.forEach((member, index) => {
      member.anchor.copy(layout.anchor)
      member.goal = goalOf(layout.goals[index].position, layout.goals[index].rotation, 0.5)
    })
    target = layout ? closeup(slot, layout) : overview()
    if (still) {
      base.copy(target.pos)
      gaze.copy(target.look)
    }
  }

  function relayout() {
    const { width, places } = slots(order.length, camera.aspect)
    wide = width
    order.forEach((id, index) => {
      const screen = screens.get(id)
      screen.slot = places[index]
      screen.holder.style.setProperty('--holo-w', `${width}px`)
    })
  }

  function leave(member) {
    member.holder.classList.add('is-leaving')
    member.goal = goalOf(member.anchor, member.goal.rotation, TINY)
    leaving.add(member)
    member.timer = window.setTimeout(() => {
      scene.remove(member.object)
      leaving.delete(member)
    }, LEAVE_MS)
  }

  function syncCrew(list) {
    const seen = new Set(list.map((item) => item.id))
    for (const [id, member] of crew) {
      if (seen.has(id)) continue
      crew.delete(id)
      leave(member)
    }
    const slot = focus ? screens.get(focus).slot : null
    members = list.map((item, index) => {
      if (!crew.has(item.id)) {
        const holder = el('div', { class: 'ops-holo is-crew' })
        holder.style.setProperty('--i', String(index))
        const object = new CSS3DObject(holder)
        const anchor = anchorOf(slot)
        object.position.copy(anchor)
        object.rotation.y = -slot.angle
        object.scale.setScalar(TINY)
        scene.add(object)
        crew.set(item.id, { holder, object, anchor, goal: goalOf(anchor, -slot.angle, 0.5) })
      }
      const member = crew.get(item.id)
      if (item.node.parentNode !== member.holder) member.holder.replaceChildren(item.node)
      return member
    })
  }

  function placeBlip(item, index, count) {
    if (!blips.has(item.id)) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: disc, color: TONES.idle, transparent: true, opacity: 0.5, depthWrite: false }))
      sprite.userData.id = item.id
      radar.add(sprite)
      blips.set(item.id, { sprite, phase: Math.random() * TAU })
    }
    const blip = blips.get(item.id)
    const angle = (index * 2.39996 + 0.6) % TAU
    const radius = RADAR * (0.22 + 0.7 * ((index + 0.5) / count))
    Object.assign(blip, { item, angle, size: 18 + 6 * Math.log2(1 + item.agents) })
    blip.sprite.position.set(Math.cos(angle) * radius, 14, -Math.sin(angle) * radius)
  }

  function settle(record, amount) {
    record.object.position.lerp(record.goal.position, amount)
    record.object.rotation.y += (record.goal.rotation - record.object.rotation.y) * amount
    record.object.scale.setScalar(record.object.scale.x + (record.goal.scale - record.object.scale.x) * amount)
  }

  function tick(now) {
    frame = window.requestAnimationFrame(tick)
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    time += dt
    const ease = still ? 1 : 1 - Math.exp(-dt * 3.2)
    const amount = still ? 1 : 1 - Math.exp(-dt * 4)
    base.lerp(target.pos, ease)
    gaze.lerp(target.look, ease)
    lean.lerp(pointer, amount)
    let lift = 0
    if (swoop) {
      const progress = 1 - Math.min(1, base.distanceTo(target.pos) / swoop)
      lift = 4 * progress * (1 - progress) * swoop * 0.3
      if (progress > 0.995) swoop = 0
    }
    const sway = still ? 0 : focus ? 0.25 : 1
    away.copy(base).sub(gaze).normalize()
    camera.position.copy(base).addScaledVector(away, lift)
    camera.position.x += away.z * lean.x * 46 * sway
    camera.position.z -= away.x * lean.x * 46 * sway
    camera.position.y += lift * 0.25 - lean.y * 24 * sway
    camera.lookAt(gaze)
    for (const screen of screens.values()) settle(screen, amount)
    for (const member of crew.values()) settle(member, amount)
    for (const member of leaving) settle(member, amount)
    presence += ((focus ? 0 : 1) - presence) * amount
    radar.visible = presence > 0.01
    for (const [material, opacity] of fades) material.opacity = opacity * presence
    const spinning = !still && [...blips.values()].some((blip) => blip.item.state === 'running')
    sweep.visible = spinning
    if (spinning) sweep.rotation.y -= dt * 0.9
    const edge = ((sweep.rotation.y % TAU) + TAU) % TAU
    for (const blip of blips.values()) {
      const running = blip.item.state === 'running'
      const behind = (((blip.angle - edge) % TAU) + TAU) % TAU
      const swept = spinning ? Math.max(0, 1 - behind / 1.4) : 0
      const pulse = running && !still ? 1 + 0.16 * Math.sin(time * 4 + blip.phase) : 1
      blip.sprite.scale.setScalar(blip.size * pulse * (1 + swept * 0.3))
      blip.sprite.material.color.setHex(TONES[blip.item.state] || TONES.idle)
      blip.sprite.material.opacity = (blip.item.state === 'idle' ? 0.5 : 0.95) * presence
    }
    renderer.render(scene, camera)
    css.render(scene, camera)
  }

  host.addEventListener('pointermove', (event) => {
    const box = host.getBoundingClientRect()
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, ((event.clientY - box.top) / box.height) * 2 - 1)
  })
  host.addEventListener('pointerleave', () => pointer.set(0, 0))
  host.addEventListener('click', (event) => {
    if (event.target.closest('.ops-holo')) return
    const box = host.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1), camera)
    const hit = !focus && ray.intersectObjects([...blips.values()].map((blip) => blip.sprite))[0]
    if (hit) onPick(hit.object.userData.id)
    else if (focus) onBack()
  })
  const resize = new ResizeObserver(() => {
    const width = host.clientWidth
    const height = host.clientHeight
    if (!width || !height) return
    renderer.setSize(width, height)
    css.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    relayout()
    aim()
  })
  resize.observe(host)
  frame = window.requestAnimationFrame(tick)

  return {
    place(items, focusId, list) {
      const { width, places } = slots(items.length, camera.aspect)
      const seen = new Set(items.map((item) => item.id))
      const before = focus
      order = items.map((item) => item.id)
      wide = width
      items.forEach((item, index) => {
        if (!screens.has(item.id)) {
          const holder = el('div', { class: 'ops-holo' })
          const object = new CSS3DObject(holder)
          object.scale.setScalar(0.5)
          object.position.copy(places[index].position).add(new THREE.Vector3(0, -120, 0))
          object.rotation.y = -places[index].angle
          scene.add(object)
          screens.set(item.id, { holder, object, goal: goalOf(places[index].position, -places[index].angle, 0.5) })
        }
        const screen = screens.get(item.id)
        if (item.node.parentNode !== screen.holder) screen.holder.replaceChildren(item.node)
        screen.holder.style.setProperty('--holo-w', `${width}px`)
        screen.slot = places[index]
        placeBlip(item, index, items.length)
      })
      for (const [id, screen] of screens) {
        if (seen.has(id)) continue
        scene.remove(screen.object)
        screens.delete(id)
      }
      for (const [id, blip] of blips) {
        if (seen.has(id)) continue
        radar.remove(blip.sprite)
        blip.sprite.material.dispose()
        blips.delete(id)
      }
      focus = focusId && screens.has(focusId) ? focusId : null
      for (const [id, screen] of screens) {
        screen.holder.classList.toggle('is-focus', id === focus)
        screen.holder.classList.toggle('is-back', Boolean(focus) && id !== focus)
      }
      syncCrew(focus ? list : [])
      aim()
      if (!focus || still) swoop = 0
      else if (before && before !== focus) swoop = base.distanceTo(target.pos)
    },
    destroy() {
      window.cancelAnimationFrame(frame)
      resize.disconnect()
      for (const member of leaving) window.clearTimeout(member.timer)
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose()
        if (object.material) object.material.dispose()
      })
      disc.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      host.replaceChildren()
    },
  }
}
