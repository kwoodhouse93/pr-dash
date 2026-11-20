import { app, nativeImage, type NativeImage } from 'electron'
import { ICON_FRAMES, iconSvg, type IconState } from '../../src/shared/icon.ts'

const FRAME_MS = 450

/**
 * Keeps the Dock icon saying what the dashboard does: its top bar takes the most urgent colour,
 * a number counts what waits on the user, and the bars ripple while the merge queue works.
 * Electron cannot read an SVG, so `render` has a page draw it and hand back a PNG as a data address.
 */
export class DockIcon {
  private shown = ''
  private frame = 0
  private timer: NodeJS.Timeout | null = null
  private readonly drawn = new Map<string, NativeImage>()

  constructor(private readonly render: (svg: string) => Promise<string>) {}

  show(state: IconState) {
    const key = JSON.stringify(state)
    if (key === this.shown) return
    this.shown = key
    this.frame = 0
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    void this.draw(state, key)
    if (!state.merging) return
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % ICON_FRAMES
      void this.draw(state, key)
    }, FRAME_MS)
  }

  private async draw(state: IconState, key: string) {
    const svg = iconSvg(state, this.frame, true)
    let image = this.drawn.get(svg)
    if (!image) {
      try {
        image = nativeImage.createFromDataURL(await this.render(svg))
      } catch {
        // The page that draws it is not up yet. The icon is tried again on the next change.
        if (key === this.shown) this.shown = ''
        return
      }
      if (image.isEmpty()) return
      this.drawn.set(svg, image)
    }
    // A slow drawing may finish after the state has moved on.
    if (key === this.shown) app.dock?.setIcon(image)
  }
}

/** Runs in a page: draws an SVG at the size the Dock shows and returns it as a PNG data address. */
export const RASTERIZE = `(svg) => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 512
    canvas.getContext('2d').drawImage(image, 0, 0, 512, 512)
    resolve(canvas.toDataURL('image/png'))
  }
  image.onerror = () => reject(new Error('The icon could not be drawn'))
  image.src = 'data:image/svg+xml,' + encodeURIComponent(svg)
})`
