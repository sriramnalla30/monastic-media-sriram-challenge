import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCsv } from '../lib/csv.js'
import { FatigueInputError, flagFatiguedCreatives, normalizeThreshold } from '../lib/fatigue.js'

const HEADER = 'date,ad_id,creative_name,format,impressions,clicks,spend_inr'

type Day = [impressions: number, clicks: number] | null // null = paused (no row)

/** Builds a CSV for one or more creatives from day 1 (2026-09-01) onwards. */
function csv(creatives: Record<string, Day[]>): string {
  const lines = [HEADER]
  for (const [id, days] of Object.entries(creatives)) {
    days.forEach((d, i) => {
      if (!d) return
      const date = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)
      lines.push(`${date},${id},"${id} (video, test)",video,${d[0]},${d[1]},100`)
    })
  }
  return lines.join('\n')
}

const repeat = (n: number, d: Day): Day[] => Array.from({ length: n }, () => d)
const one = (text: string, opts = {}) => flagFatiguedCreatives(text, opts).creatives[0]
const byId = (text: string, id: string) => flagFatiguedCreatives(text).creatives.find((c) => c.ad_id === id)!

describe('parseCsv', () => {
  it('keeps commas and escaped quotes inside quoted fields', () => {
    expect(parseCsv('a,b\n1,"x, ""y"""\r\n')).toEqual([
      ['a', 'b'],
      ['1', 'x, "y"'],
    ])
  })
  it('strips a BOM and ignores blank lines', () => {
    expect(parseCsv('﻿a\n\n1\n')).toEqual([['a'], ['1']])
  })
})

describe('normalizeThreshold', () => {
  it('accepts fractions, percents and strings', () => {
    expect(normalizeThreshold(0.3)).toBe(0.3)
    expect(normalizeThreshold(30)).toBe(0.3)
    expect(normalizeThreshold('25%')).toBe(0.25)
    expect(normalizeThreshold(undefined)).toBe(0.3)
  })
  it('rejects nonsense', () => {
    expect(() => normalizeThreshold(0)).toThrow(FatigueInputError)
    expect(() => normalizeThreshold(150)).toThrow(FatigueInputError)
    expect(() => normalizeThreshold('abc')).toThrow(FatigueInputError)
  })
})

describe('CTR math', () => {
  it('flags a creative whose CTR fell 40%', () => {
    // baseline 2% for 14 days, last 7 days 1.2% => drop 40%
    const r = one(csv({ A: [...repeat(14, [10000, 200]), ...repeat(7, [10000, 120])] }))
    expect(r.baseline_ctr).toBeCloseTo(0.02)
    expect(r.current_ctr).toBeCloseTo(0.012)
    expect(r.drop).toBeCloseTo(0.4)
    expect(r.status).toBe('flagged')
  })

  it('flags at exactly the threshold despite float noise', () => {
    // 1 - 0.007/0.01 = 0.30000000000000004 or 0.29999999999999993 depending on path
    const r = one(csv({ A: [...repeat(14, [10000, 100]), ...repeat(7, [10000, 70])] }))
    expect(r.drop).toBeCloseTo(0.3)
    expect(r.status).toBe('flagged')
  })

  it('does not flag just under the threshold', () => {
    const r = one(csv({ A: [...repeat(14, [10000, 100]), ...repeat(7, [10000, 71])] }))
    expect(r.status).toBe('ok')
  })

  it('respects a custom threshold', () => {
    const data = csv({ A: [...repeat(14, [10000, 100]), ...repeat(7, [10000, 80])] }) // 20% drop
    expect(one(data).status).toBe('ok')
    expect(one(data, { dropThreshold: 0.15 }).status).toBe('flagged')
    expect(one(data, { dropThreshold: 15 }).status).toBe('flagged')
  })

  it('weights CTR by impressions instead of averaging daily CTRs', () => {
    // Day 1: 100 impr, 10 clicks (10%). Days 2-7: 10,000 impr, 100 clicks (1%).
    // Weighted baseline = 610 / 60,100 = 1.015%; a naive daily mean would be 2.29%.
    const days: Day[] = [[100, 10], ...repeat(6, [10000, 100]), ...repeat(14, [10000, 100])]
    const r = one(csv({ A: days }))
    expect(r.baseline_ctr).toBeCloseTo(610 / 60100, 6)
    expect(r.status).toBe('ok')
  })

  it('treats a CTR increase as ok with a negative drop', () => {
    const r = one(csv({ A: [...repeat(14, [10000, 100]), ...repeat(7, [10000, 150])] }))
    expect(r.drop).toBeCloseTo(-0.5)
    expect(r.status).toBe('ok')
  })

  it('does not divide by zero when the baseline had no clicks', () => {
    const r = one(csv({ A: [...repeat(14, [10000, 0]), ...repeat(7, [10000, 50])] }))
    expect(r.baseline_ctr).toBe(0)
    expect(r.drop).toBeNull()
    expect(r.status).toBe('ok')
  })

  it('flags a total collapse to zero clicks as a 100% drop', () => {
    const r = one(csv({ A: [...repeat(14, [10000, 100]), ...repeat(7, [10000, 0])] }))
    expect(r.drop).toBe(1)
    expect(r.status).toBe('flagged')
  })
})

describe('edge cases from the brief', () => {
  it('marks creatives with fewer than 14 delivering days as too new to judge', () => {
    const r = one(csv({ A: repeat(13, [10000, 100]) }))
    expect(r.status).toBe('too new to judge')
    expect(r.active_days).toBe(13)
  })

  it('judges a late launch by its own first 7 delivering days', () => {
    // Launches on day 8. Baseline must be days 8-14 (2%), not days 1-7 (no data).
    const days: Day[] = [...repeat(7, null), ...repeat(7, [10000, 200]), ...repeat(7, [10000, 100])]
    const r = byId(csv({ A: days, B: repeat(21, [10000, 100]) }), 'A')
    expect(r.baseline_window).toEqual({ start: '2026-09-08', end: '2026-09-14' })
    expect(r.baseline_ctr).toBeCloseTo(0.02)
    expect(r.status).toBe('flagged')
  })

  it('does not count paused days (0 impressions) toward baseline or age', () => {
    // Delivers 3 days, pauses 5 days with explicit 0 rows, then delivers.
    const days: Day[] = [...repeat(3, [10000, 200]), ...repeat(5, [0, 0]), ...repeat(4, [10000, 200]), ...repeat(7, [10000, 200])]
    const r = one(csv({ A: days }))
    expect(r.active_days).toBe(14)
    expect(r.baseline_window).toEqual({ start: '2026-09-01', end: '2026-09-12' })
    expect(r.daily[4].ctr).toBeNull()
    expect(r.status).toBe('ok')
  })

  it('treats missing rows as paused days too', () => {
    const days: Day[] = [...repeat(10, [10000, 100]), null, null, ...repeat(4, [10000, 100]), ...repeat(7, [10000, 100])]
    const r = one(csv({ A: days }))
    expect(r.active_days).toBe(21)
    expect(r.daily).toHaveLength(23)
    expect(r.daily[10]).toEqual({ date: '2026-09-11', impressions: 0, clicks: 0, ctr: null })
  })

  it('a creative paused for the whole last week is not enough volume, not flagged', () => {
    const days: Day[] = [...repeat(20, [10000, 200]), ...repeat(7, null)]
    const r = byId(csv({ A: days, B: repeat(27, [10000, 100]) }), 'A')
    expect(r.current_impressions).toBe(0)
    expect(r.current_ctr).toBeNull()
    expect(r.status).toBe('not enough volume')
  })

  it('a recovering creative is judged on the last 7 days only', () => {
    const days: Day[] = [...repeat(7, [10000, 200]), ...repeat(7, [10000, 80]), ...repeat(7, [10000, 190])]
    const r = one(csv({ A: days }))
    expect(r.drop).toBeCloseTo(0.05)
    expect(r.status).toBe('ok')
  })

  it('a low-volume creative is not enough volume even with a big drop', () => {
    const r = one(csv({ A: [...repeat(14, [700, 20]), ...repeat(7, [700, 5])] })) // 4,900 last-7 impressions
    expect(r.current_impressions).toBe(4900)
    expect(r.drop).toBeGreaterThan(0.3)
    expect(r.status).toBe('not enough volume')
  })

  it('exactly 5,000 impressions clears the floor', () => {
    const days: Day[] = [...repeat(14, [10000, 200]), ...repeat(6, [700, 7]), [800, 8]]
    const r = one(csv({ A: days }))
    expect(r.current_impressions).toBe(5000)
    expect(r.status).toBe('flagged')
  })

  it('uses the file-wide last 7 days, not each creative’s own last 7 rows', () => {
    // A stops 3 days before the file ends; its current window still ends on the file's last date.
    const days: Day[] = [...repeat(18, [10000, 200]), ...repeat(3, null)]
    const r = flagFatiguedCreatives(csv({ A: days, B: repeat(21, [10000, 100]) }))
    expect(r.current_window).toEqual({ start: '2026-09-15', end: '2026-09-21' })
    expect(r.creatives.find((c) => c.ad_id === 'A')!.current_impressions).toBe(40000)
  })
})

describe('input handling', () => {
  it('sums duplicate rows for the same ad and date', () => {
    const text = csv({ A: repeat(21, [5000, 100]) }) + '\n2026-09-21,A,"A",video,5000,0,50'
    const r = flagFatiguedCreatives(text)
    expect(r.creatives[0].daily.at(-1)!.impressions).toBe(10000)
    expect(r.warnings.some((w) => w.includes('duplicate'))).toBe(true)
  })

  it('skips bad rows with a warning instead of crashing', () => {
    const text = [csv({ A: repeat(21, [10000, 100]) }), '2026-13-01,A,x,video,1,1,1', '2026-09-02,A,x,video,-5,1,1', '2026-09-03,A,x,video,10,50,1'].join('\n')
    const r = flagFatiguedCreatives(text)
    expect(r.warnings).toHaveLength(3)
    expect(r.creatives[0].status).toBe('ok')
  })

  it('accepts columns in any order and in any case', () => {
    const text = 'Clicks,Impressions,AD_ID,Date\n' + Array.from({ length: 21 }, (_, i) => `100,10000,A,2026-09-${String(i + 1).padStart(2, '0')}`).join('\n')
    expect(one(text).status).toBe('ok')
  })

  it('rejects files missing required columns', () => {
    expect(() => flagFatiguedCreatives('date,ad_id\n2026-09-01,A')).toThrow(/impressions, clicks/)
  })

  it('rejects empty files', () => {
    expect(() => flagFatiguedCreatives(HEADER)).toThrow(FatigueInputError)
  })
})

describe('demo data', () => {
  it('produces the expected status for every scenario', () => {
    const r = flagFatiguedCreatives(readFileSync('public/demo-data.csv', 'utf8'))
    const status = Object.fromEntries(r.creatives.map((c) => [c.ad_id, c.status]))
    expect(status).toEqual({
      'DEMO-01': 'ok',
      'DEMO-02': 'flagged',
      'DEMO-03': 'ok',
      'DEMO-04': 'too new to judge',
      'DEMO-05': 'not enough volume',
      'DEMO-06': 'ok',
      'DEMO-07': 'not enough volume',
      'DEMO-08': 'flagged',
      'DEMO-09': 'ok',
      'DEMO-10': 'flagged',
    })
    // flagged list is sorted worst drop first
    const drops = r.flagged.map((id) => r.creatives.find((c) => c.ad_id === id)!.drop!)
    expect(drops).toEqual([...drops].sort((a, b) => b - a))
  })
})
