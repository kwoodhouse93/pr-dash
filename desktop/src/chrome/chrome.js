const strip = document.getElementById('tabs')
const back = document.getElementById('back')
const forward = document.getElementById('forward')
const reload = document.getElementById('reload')
const external = document.getElementById('external')
const update = document.getElementById('update')

back.onclick = () => window.shell.send('back')
forward.onclick = () => window.shell.send('forward')
reload.onclick = () => window.shell.send('reload')
external.onclick = () => window.shell.send('open-external')
update.onclick = () => window.shell.send('apply-update')

function tabElement(tab, active) {
  const el = document.createElement('div')
  el.className = ['tab', active && 'active', tab.pinned && 'pinned', tab.loading && 'loading'].filter(Boolean).join(' ')
  el.setAttribute('role', 'tab')
  el.setAttribute('aria-selected', String(active))
  el.title = tab.title
  el.onmousedown = (event) => {
    if (event.button === 0) window.shell.send('select', tab.id)
  }
  el.onauxclick = (event) => {
    if (event.button === 1) window.shell.send('close', tab.id)
  }

  if (!tab.pinned) {
    if (tab.favicon) {
      const icon = document.createElement('img')
      icon.src = tab.favicon
      icon.alt = ''
      icon.onerror = () => icon.replaceWith(dot())
      el.append(icon)
    } else {
      el.append(dot())
    }
  }

  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = tab.title
  el.append(title)

  if (!tab.pinned) {
    const close = document.createElement('button')
    close.className = 'close'
    close.setAttribute('aria-label', 'Close tab')
    close.innerHTML = '<svg viewBox="0 0 10 10"><path d="m2 2 6 6M8 2 2 8" /></svg>'
    close.onmousedown = (event) => event.stopPropagation()
    close.onclick = () => window.shell.send('close', tab.id)
    el.append(close)
  }
  return el
}

function dot() {
  const el = document.createElement('span')
  el.className = 'dot'
  return el
}

window.shell.onState((state) => {
  document.body.classList.toggle('fullscreen', state.fullscreen)
  back.disabled = !state.canGoBack
  forward.disabled = !state.canGoForward
  external.disabled = !state.external
  update.hidden = !state.updateReady
  strip.replaceChildren(...state.tabs.map((tab) => tabElement(tab, tab.id === state.activeId)))
})
