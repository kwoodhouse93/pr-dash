import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type ActiveMenu = { id: string; top: number; left: number; pinned: boolean }

type MenuApi = {
  active: ActiveMenu | null
  hover: (id: string, element: HTMLElement) => void
  leave: () => void
  pin: (id: string, element: HTMLElement) => void
  close: () => void
}

const MenuContext = createContext<MenuApi | null>(null)

function place(rect: DOMRect): { top: number; left: number } {
  const width = 380
  const height = 280
  let left = Math.max(12, rect.left)
  if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12)
  let top = rect.bottom + 6
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 6)
  return { top, left }
}

export function MenuProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveMenu | null>(null)
  const timer = useRef<number>(0)
  const generation = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active

  const api: MenuApi = {
    active,
    hover(id, element) {
      const ticket = ++generation.current
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        if (ticket !== generation.current) return
        if (activeRef.current?.pinned && activeRef.current.id !== id) return
        const rect = element.getBoundingClientRect()
        setActive((current) => ({
          id,
          pinned: current?.id === id ? current.pinned : false,
          ...place(rect),
        }))
      }, 140)
    },
    leave() {
      const ticket = ++generation.current
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        if (ticket !== generation.current) return
        setActive((current) => (current?.pinned ? current : null))
      }, 200)
    },
    pin(id, element) {
      ++generation.current
      window.clearTimeout(timer.current)
      const rect = element.getBoundingClientRect()
      setActive((current) => (current?.id === id && current.pinned ? null : { id, pinned: true, ...place(rect) }))
    },
    close() {
      ++generation.current
      window.clearTimeout(timer.current)
      setActive(null)
    },
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActive(null)
    }
    const onScroll = () => setActive(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [])

  return <MenuContext.Provider value={api}>{children}</MenuContext.Provider>
}

function useMenu(): MenuApi {
  const menu = useContext(MenuContext)
  if (!menu) throw new Error('MenuProvider is missing')
  return menu
}

export function HoverCard({
  id,
  className,
  label,
  children,
}: {
  id: string
  className?: string
  label: ReactNode
  children: ReactNode
}) {
  const menu = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const open = menu.active?.id === id
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        aria-expanded={open}
        onMouseEnter={() => ref.current && menu.hover(id, ref.current)}
        onMouseLeave={() => menu.leave()}
        onClick={(event) => {
          event.stopPropagation()
          if (ref.current) menu.pin(id, ref.current)
        }}
      >
        {label}
      </button>
      {open && menu.active
        ? createPortal(
            <div
              className="popover"
              style={{ top: menu.active.top, left: menu.active.left }}
              onMouseEnter={() => ref.current && menu.hover(id, ref.current)}
              onMouseLeave={() => menu.leave()}
              onClick={(event) => event.stopPropagation()}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

export function ClickCard({
  id,
  className,
  label,
  panelClassName,
  children,
}: {
  id: string
  className?: string
  label: ReactNode
  panelClassName?: string
  children: ReactNode
}) {
  const menu = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const open = menu.active?.id === id
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          if (ref.current) menu.pin(id, ref.current)
        }}
      >
        {label}
      </button>
      {open && menu.active
        ? createPortal(
            <div
              className={panelClassName ? `popover ${panelClassName}` : 'popover'}
              style={{ top: menu.active.top, left: menu.active.left }}
              onClick={(event) => event.stopPropagation()}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

export function useMenuClose(): () => void {
  return useMenu().close
}
