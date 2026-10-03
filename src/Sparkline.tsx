import type { CreativeResult } from '../lib/fatigue'

const W = 180
const H = 40
const PAD = 3

/**
 * Daily CTR line. Paused days break the line instead of dropping to zero.
 * Dashed line = baseline CTR; shaded band = the current 7-day window.
 */
export function Sparkline({ c, currentStart }: { c: CreativeResult; currentStart: string }) {
  const values = c.daily.map((d) => d.ctr)
  const known = values.filter((v): v is number => v !== null)
  if (known.length === 0) return <span className="sub">no delivery</span>

  const max = Math.max(...known, c.baseline_ctr ?? 0) * 1.1 || 1
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, values.length - 1)
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD)

  // Split into segments at paused days.
  const segments: string[] = []
  let current = ''
  values.forEach((v, i) => {
    if (v === null) {
      if (current) segments.push(current)
      current = ''
    } else {
      current += `${current ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    }
  })
  if (current) segments.push(current)

  const startIdx = c.daily.findIndex((d) => d.date >= currentStart)
  const title = c.daily.map((d) => `${d.date}: ${d.ctr === null ? 'paused' : (d.ctr * 100).toFixed(2) + '%'}`).join('\n')

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={`spark s-${c.status.replace(/ /g, '-')}`} role="img" aria-label={`Daily CTR for ${c.ad_id}`}>
      <title>{title}</title>
      {startIdx >= 0 && <rect x={x(startIdx) - 2} y={0} width={W - x(startIdx) + 2} height={H} className="window" />}
      {c.baseline_ctr !== null && <line x1={0} x2={W} y1={y(c.baseline_ctr)} y2={y(c.baseline_ctr)} className="baseline" />}
      {segments.map((d, i) => (
        <path key={i} d={d} className="line" />
      ))}
      {values.map((v, i) =>
        v !== null && (i === 0 || values[i - 1] === null) && (i === values.length - 1 || values[i + 1] === null) ? (
          <circle key={i} cx={x(i)} cy={y(v)} r={1.6} className="dot" />
        ) : null,
      )}
    </svg>
  )
}
