const $ = (id) => document.getElementById(id)
const send = (command, arg) => window.shell.send(command, arg)
const EARLIER_SHOWN = 5

let state = null
let menuOpen = false
let earlierAll = false
let resizing = false
let pendingWidth = null
let copiedTimer = null
// Agents whose task is still flying to them. Their row keeps its place, unseen, until the task lands.
const incoming = new Set()
// The row that has just caught its task, and whether the pill has.
let landedKey = null
let pillCaught = false

$('back').onclick = () => send('back')
$('forward').onclick = () => send('forward')
$('reload').onclick = () => send('reload')
$('external').onclick = () => send('open-external')
$('copy-link').onclick = () => {
  send('copy-link')
  // A tick for a moment, as nothing else on screen says the link was copied.
  const button = $('copy-link')
  button.classList.add('copied')
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => button.classList.remove('copied'), 1200)
}
$('update').onclick = () => send('apply-update')
$('show-sidebar').onclick = () => send('toggle-sidebar')
$('hide-sidebar').onclick = () => send('toggle-sidebar')
$('grouping').onclick = () => send('grouping-menu')
$('agents-clear').onclick = () => send('agents-clear')
$('pop-clear').onclick = () => send('agents-clear')
for (const [id, page] of [['home', 'list'], ['agents-link', 'agents'], ['queue-link', 'queue'], ['settings-link', 'settings']]) {
  $(id).onmousedown = (event) => {
    if (event.button === 0) send('dashboard', page)
  }
}

// The page sits over everything right of the sidebar, so the strip's view is
// raised for the length of a drag to keep hearing the pointer.
$('resize').onmousedown = (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  resizing = true
  document.body.classList.add('resizing')
  send('overlay', true)
}
$('resize').ondblclick = () => send('sidebar-width', 264)
window.onmousemove = (event) => {
  if (!resizing) return
  const first = pendingWidth === null
  pendingWidth = Math.round(event.clientX)
  if (!first) return
  requestAnimationFrame(() => {
    send('sidebar-width', pendingWidth)
    pendingWidth = null
  })
}
window.onmouseup = () => {
  if (!resizing) return
  resizing = false
  document.body.classList.remove('resizing')
  send('overlay', menuOpen)
}
$('pop-all').onclick = () => {
  setMenu(false)
  send('dashboard', 'agents')
}
$('agents-pill').onclick = () => setMenu(!menuOpen)
$('backdrop').onmousedown = () => setMenu(false)
document.onkeydown = (event) => {
  if (event.key === 'Escape' && menuOpen) setMenu(false)
}

function setMenu(open) {
  if (menuOpen === open) return
  menuOpen = open
  send('overlay', open)
  render()
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function classes(...names) {
  return names.filter(Boolean).join(' ')
}

function favicon(src) {
  if (!src) return el('span', 'dot')
  const icon = el('img', 'fav')
  icon.src = src
  icon.alt = ''
  icon.onerror = () => icon.replaceWith(el('span', 'dot'))
  return icon
}

// The length of one turn, as set for .spin in chrome.css.
const SPIN_MS = 1100

// Every update from the shell draws the page again, and a new element starts its
// animation from the beginning. Each spinner is started part-way through its turn,
// at the place the clock puts it, so a redrawn one carries on where the last was.
function spinner(title) {
  const spin = el('span', 'spin')
  spin.style.animationDelay = `-${Date.now() % SPIN_MS}ms`
  if (title) spin.title = title
  return spin
}

function agentMark(mark) {
  return mark === 'running' ? spinner() : el('span', `mark ${mark}`)
}

function closeButton(label, onClose) {
  const close = el('button', 'close')
  close.setAttribute('aria-label', label)
  close.title = label
  close.innerHTML = '<svg viewBox="0 0 10 10"><path d="m2 2 6 6M8 2 2 8" /></svg>'
  close.onmousedown = (event) => event.stopPropagation()
  close.onclick = onClose
  return close
}

function selectable(node, id) {
  node.setAttribute('role', 'tab')
  node.setAttribute('aria-selected', String(id === state.activeId))
  node.onmousedown = (event) => {
    if (event.button === 0) send('select', id)
  }
  node.onauxclick = (event) => {
    if (event.button === 1) send('close', id)
  }
  node.oncontextmenu = () => send('tab-menu', id)
}

function stripTab(tab) {
  const node = el('div', classes('tab', tab.id === state.activeId && 'active', tab.pinned && 'pinned', tab.loading && 'loading'))
  node.title = tab.title
  selectable(node, tab.id)
  if (!tab.pinned) node.append(tab.agent ? agentMark(tab.agent) : tab.gone ? goneMark(tab.gone) : tab.ci ? el('span', `ci ${tab.ci}`) : favicon(tab.favicon))
  node.append(el('span', 'title', tab.title))
  if (!tab.pinned) node.append(closeButton('Close tab', () => send('close', tab.id)))
  return node
}

function goneMark(gone) {
  const mark = el('span', `ci ${gone}`)
  mark.title = gone === 'merged' ? 'Merged' : 'Closed'
  return mark
}

function railBox(rail, dot) {
  const box = el('span', 'rails')
  box.style.setProperty('--lanes', rail.lanes)
  const segment = (kind, lane, line, span) => {
    const seg = el('span', `seg ${kind} ${line}`)
    seg.style.setProperty('--lane', lane)
    if (span) seg.style.setProperty('--span', span)
    box.append(seg)
  }
  for (const pass of rail.through) segment('through', pass.lane, pass.line)
  if (rail.lane === null) return box
  if (rail.up) segment('up', rail.lane, rail.up)
  if (rail.down) segment('down', rail.lane, rail.down)
  for (const join of rail.joins) segment('join', rail.lane, join.line, join.lane - rail.lane)
  dot.style.setProperty('--lane', rail.lane)
  box.append(dot)
  return box
}

function tabRow({ depth, row, rail }) {
  const nested = rail && rail.lane === null
  const node = el('div', classes('row', `d${depth}`, nested && 'nested', row.id === state.activeId && 'active', row.loading && 'loading'))
  node.title = [row.number === null ? row.title : `#${row.number} ${row.title}`, row.note].filter(Boolean).join('\n')
  selectable(node, row.id)
  const dot = row.gone ? goneMark(row.gone) : row.ci ? el('span', `ci ${row.ci}`) : favicon(row.favicon)
  if (!rail) node.append(dot)
  else if (nested) node.append(railBox(rail), dot)
  else node.append(railBox(rail, dot))
  node.append(el('span', 'title', row.title))
  if (row.agent) {
    node.append(spinner('An agent is working on this pull request'))
  }
  if (row.needs > 0) {
    const needs = el('span', 'needs', String(row.needs))
    needs.title = 'Waiting on you'
    node.append(needs)
  }
  if (row.number !== null) node.append(el('span', 'num', `#${row.number}`))
  node.append(closeButton('Close tab', () => send('close', row.id)))
  return node
}

function treeNode(item) {
  if (item.kind === 'tab') return tabRow(item)
  if (item.kind === 'issue') return el('div', 'sub', item.title)
  if (item.kind === 'label') {
    const label = el('div', 'sec')
    label.append(el('span', '', item.title))
    return label
  }
  const node = el('div', 'row group')
  node.setAttribute('aria-expanded', String(item.open))
  node.onclick = () => send('toggle-group', item.id)
  node.append(el('span', classes('caret', item.open && 'open')), el('span', 'title', item.title), el('span', 'num', String(item.count)))
  node.title = item.title
  return node
}

function agentRow(agent, earlier) {
  const fresh = agent.mark === 'unread' || agent.mark === 'failed'
  const node = el('div', classes('row', earlier && 'd1 dim', fresh && !earlier && 'strong', agent.tabId !== null && agent.tabId === state.activeId && 'active', incoming.has(agent.key) && 'incoming', agent.key === landedKey && 'landed'))
  node.dataset.key = agent.key
  node.title = `${agent.label} · #${agent.number}`
  node.onclick = () => {
    setMenu(false)
    send('agent-open', agent.key)
  }
  node.append(agentMark(earlier && agent.mark !== 'running' ? 'read' : agent.mark), el('span', 'title', agent.label), el('span', 'num', `#${agent.number}`))
  if (!earlier) {
    node.append(
      closeButton('Dismiss', (event) => {
        event.stopPropagation()
        send('agent-dismiss', agent.key)
      }),
    )
  }
  node.append(el('span', classes('num age', agent.mark === 'failed' && !earlier && 'bad'), agent.mark === 'failed' && !earlier ? 'failed' : agent.age))
  return node
}

function agentList() {
  const nodes = state.agents.map((agent) => agentRow(agent, false))
  if (state.agents.length === 0) nodes.push(el('div', 'empty', 'Nothing running, nothing unread.'))
  if (state.earlier.length === 0) return nodes
  const toggle = el('div', 'row dim')
  toggle.setAttribute('aria-expanded', String(state.earlierOpen))
  toggle.onclick = () => send('toggle-earlier')
  toggle.append(el('span', classes('caret', state.earlierOpen && 'open')), el('span', 'title', 'Earlier'), el('span', 'num', String(state.earlier.length)))
  nodes.push(toggle)
  if (!state.earlierOpen) return nodes
  const shown = earlierAll ? state.earlier : state.earlier.slice(0, EARLIER_SHOWN)
  nodes.push(...shown.map((agent) => agentRow(agent, true)))
  if (shown.length < state.earlier.length) {
    const more = el('div', 'row d1 dim')
    more.onclick = () => {
      earlierAll = true
      render()
    }
    more.append(el('span', 'title', `Show ${state.earlier.length - shown.length} more`))
    nodes.push(more)
  }
  return nodes
}

function agentNote() {
  const parts = []
  if (state.running) parts.push(`${state.running} running`)
  if (state.unread) parts.push(`${state.unread} unread`)
  return parts.join(' · ')
}

function crumb() {
  return state.crumb.flatMap((part, index) => (index === 0 ? [el('span', '', part)] : [el('i', '', '›'), el('span', '', part)]))
}

function pill() {
  const parts = []
  if (state.running) {
    const running = el('span')
    running.append(spinner(), String(state.running))
    parts.push(running)
  }
  if (state.unread) {
    const failed = state.agents.some((agent) => agent.mark === 'failed')
    const unread = el('span')
    unread.append(el('span', `mark ${failed ? 'failed' : 'unread'}`), String(state.unread))
    parts.push(unread)
  }
  return parts.length ? parts : ['Agents']
}

// The same reading as the dashboard's own queue button: a spinner while a merge
// runs, a red mark for any held, and how many are in the queue.
function queueStatus(queue) {
  const parts = []
  if (queue.state === 'active') parts.push(spinner())
  if (queue.held > 0) parts.push(el('span', 'mark failed'))
  parts.push(el('span', classes('num', queue.state), String(queue.count)))
  return parts
}

function render() {
  if (!state) return
  const anyAgents = state.agents.length + state.earlier.length > 0
  if (state.sidebar || !anyAgents) menuOpen = false

  document.body.classList.toggle('fullscreen', state.fullscreen)
  document.body.classList.toggle('sidebar-open', state.sidebar)
  $('back').disabled = !state.canGoBack
  $('forward').disabled = !state.canGoForward
  $('external').disabled = !state.external
  $('copy-link').disabled = !state.external
  $('update').hidden = !state.updateReady

  document.documentElement.style.setProperty('--sidebar', `${state.width}px`)
  $('sidebar').hidden = !state.sidebar
  $('tabs').hidden = state.sidebar
  $('crumb').hidden = !state.sidebar
  if (state.sidebar) {
    $('crumb').replaceChildren(...crumb())
    const onDashboard = state.tabs.some((tab) => tab.pinned && tab.id === state.activeId)
    $('home').className = classes('row home', onDashboard && state.dashboard === 'list' && 'active')
    $('agents-link').className = classes('row', onDashboard && state.dashboard === 'agents' && 'active')
    $('agents-link').title = agentNote()
    $('agents-status').hidden = !state.running
    $('agents-status').replaceChildren(...(state.running ? [el('span', 'num active', String(state.running))] : []))
    $('queue-link').className = classes('row', onDashboard && state.dashboard === 'queue' && 'active')
    const queued = state.queue !== null && state.queue.count > 0
    $('queue-link').title = state.queue ? state.queue.label : ''
    $('queue-status').hidden = !queued
    $('queue-status').replaceChildren(...(queued ? queueStatus(state.queue) : []))
    $('settings-link').className = classes('row', onDashboard && state.dashboard === 'settings' && 'active')
    $('agents-section').hidden = !anyAgents
    $('agents-note').textContent = agentNote()
    $('agents-clear').hidden = state.unread === 0
    $('agents').replaceChildren(...agentList())
    $('grouping').textContent = state.grouping
    const nodes = state.nodes.map(treeNode)
    $('nodes').replaceChildren(...(nodes.length ? nodes : [el('div', 'empty', 'No tabs open. A link on the dashboard opens here.')]))
  } else {
    $('tabs').replaceChildren(...state.tabs.map(stripTab))
  }

  const button = $('agents-pill')
  button.hidden = state.sidebar || !anyAgents
  button.className = classes('agents-pill', !state.running && !state.unread && 'quiet', pillCaught && 'caught')
  button.title = agentNote() || 'Agents'
  button.setAttribute('aria-expanded', String(menuOpen))
  button.replaceChildren(...pill())
  $('backdrop').hidden = !menuOpen
  $('pop').hidden = !menuOpen
  if (menuOpen) {
    $('pop-note').textContent = agentNote()
    $('pop-clear').hidden = state.unread === 0
    $('pop-agents').replaceChildren(...agentList())
  }
}

// Where a task lands: its agent's row in the sidebar, or the link to the agents under it, or the pill in the strip.
function landing(key) {
  const boxOf = (node) => (node ? window.flight.shownBox(node) : null)
  if (!state.sidebar) return boxOf($('agents-pill'))
  const row = [...$('agents').children].find((node) => node.dataset.key === key)
  return boxOf(row?.firstElementChild) ?? boxOf($('agents-link').firstElementChild)
}

// How long the dashboard is given to hear where the task lands before both pages start.
const FLIGHT_LEAD_MS = 80

// The dashboard started an agent. Its task folds up where it was started and flies here. The dashboard's
// page lies over this one and plays the same flight, so each shows the part that is over it: this page
// says where the task lands and when to start, and both go by the clock.
window.shell.onFlight(async (job) => {
  if (!state) return
  incoming.add(job.key)
  render()
  const to = landing(job.key)
  const at = Date.now() + FLIGHT_LEAD_MS
  send('flight-target', JSON.stringify({ to, at }))
  const landed = await window.flight.flyParcel({ layer: document.body, from: job.from, label: job.label, to: () => to, at })
  incoming.delete(job.key)
  if (landed) {
    landedKey = job.key
    pillCaught = true
    setTimeout(() => {
      if (landedKey === job.key) landedKey = null
      pillCaught = false
      render()
    }, 520)
  }
  render()
})

window.shell.onState((next) => {
  const wasOpen = menuOpen
  state = next
  document.documentElement.dataset.theme = state.theme
  render()
  // The sidebar opening, or the last agent going, closes the menu from here.
  if (wasOpen && !menuOpen) send('overlay', false)
})
