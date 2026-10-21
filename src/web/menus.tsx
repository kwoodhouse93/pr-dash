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
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('.popover')) return
      setActive(null)
    }
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
  disabled = false,
  children,
}: {
  id: string
  className?: string
  label: ReactNode
  disabled?: boolean
  children: ReactNode
}) {
  const menu = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const open = menu.active?.id === id
  useEffect(() => {
    if (disabled && open) menu.close()
  }, [disabled, open, menu])
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        disabled={disabled}
        aria-expanded={open}
        onMouseEnter={() => !disabled && ref.current && menu.hover(id, ref.current)}
        onMouseLeave={() => menu.leave()}
        onClick={(event) => {
          event.stopPropagation()
          if (disabled || !ref.current) return
          menu.pin(id, ref.current)
        }}
      >
        {label}
      </button>
      {open && !disabled && menu.active
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
  disabled = false,
  children,
}: {
  id: string
  className?: string
  label: ReactNode
  panelClassName?: string
  disabled?: boolean
  children: ReactNode
}) {
  const menu = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const open = menu.active?.id === id
  useEffect(() => {
    if (disabled && open) menu.close()
  }, [disabled, open, menu])
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        disabled={disabled}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          if (disabled || !ref.current) return
          menu.pin(id, ref.current)
        }}
      >
        {label}
      </button>
      {open && !disabled && menu.active
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
