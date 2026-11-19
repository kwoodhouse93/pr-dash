/** How one row of an open stack draws its part of the rail. Lane 0 is the leftmost. */
export type Rail = {
  /** The lane this row's own mark sits on. */
  lane: number
  /** A row above joins this one on the same lane. */
  up: boolean
  /** This row is based on a row further down. */
  down: boolean
  /** Lanes that end here: branches that are based on this row. */
  joins: number[]
  /** Lanes that pass this row on their way to a row further down. */
  through: number[]
}

/**
 * Rows come top to bottom, each above the row it is based on.
 * A branch takes the first free lane and gives it back where it joins the row it is based on.
 */
export function layoutRails(rows: { id: string; parent: string | null }[]): { rails: Rail[]; lanes: number } {
  // What each lane is heading down to. Null is a free lane.
  const heading: (string | null)[] = []
  let lanes = rows.length ? 1 : 0
  const rails = rows.map((row) => {
    const arriving = heading.flatMap((target, lane) => (target === row.id ? [lane] : []))
    let lane = arriving[0]
    if (lane == null) {
      const free = heading.indexOf(null)
      lane = free < 0 ? heading.length : free
    }
    for (const done of arriving) heading[done] = null
    const through = heading.flatMap((target, other) => (target != null && other !== lane ? [other] : []))
    heading[lane] = row.parent
    lanes = Math.max(lanes, heading.length)
    return {
      lane,
      up: arriving.length > 0,
      down: row.parent != null,
      joins: arriving.slice(1),
      through,
    }
  })
  return { rails, lanes }
}
