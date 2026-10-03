import { parseCsv } from './csv.js'

export type Status = 'flagged' | 'ok' | 'too new to judge' | 'not enough volume'

export interface Options {
  /** Flag when 1 - current/baseline >= this. Fraction (0.3) or percent (30). */
  dropThreshold?: number | string
  /** Minimum impressions in the current window before we judge at all. */
  minImpressions?: number
  /** Number of delivering days (impressions > 0) that make up the baseline. */
  baselineDays?: number
  /** Calendar days at the end of the file that make up the current window. */
  currentDays?: number
  /** Creatives with fewer delivering days than this are "too new to judge". */
  minActiveDays?: number
}

export interface DailyPoint {
  date: string
  impressions: number
  clicks: number
  /** null on a paused day (0 impressions): a pause is not data. */
  ctr: number | null
}

export interface Window {
  start: string
  end: string
}

export interface CreativeResult {
  ad_id: string
  creative_name: string
  format: string
  status: Status
  reason: string
  baseline_ctr: number | null
  current_ctr: number | null
  /** 1 - current/baseline. Negative means CTR went up. */
  drop: number | null
  active_days: number
  baseline_impressions: number
  baseline_clicks: number
  current_impressions: number
  current_clicks: number
  baseline_window: Window | null
  /** One point per calendar day of the file, paused days included as nulls. */
  daily: DailyPoint[]
}

export interface FatigueReport {
  drop_threshold: number
  min_impressions: number
  file_window: Window
  current_window: Window
  summary: Record<Status, number> & { total: number }
  /** ad_ids with status "flagged", worst drop first. */
  flagged: string[]
  creatives: CreativeResult[]
  warnings: string[]
}

export const DEFAULTS = {
  dropThreshold: 0.3,
  minImpressions: 5000,
  baselineDays: 7,
  currentDays: 7,
  minActiveDays: 14,
} as const

// Guards against float noise, e.g. 1 - 0.7 = 0.30000000000000004 vs 0.3.
const EPS = 1e-9

export class FatigueInputError extends Error {}

/** Accepts 0.3, "0.3", 30, "30" or "30%" and returns a fraction in (0, 1). */
export function normalizeThreshold(value: number | string | undefined | null): number {
  if (value === undefined || value === null || value === '') return DEFAULTS.dropThreshold
  const raw = typeof value === 'string' ? Number(value.trim().replace(/%$/, '')) : value
  if (!Number.isFinite(raw)) throw new FatigueInputError(`drop_threshold must be a number, got "${value}"`)
  const fraction = raw > 1 ? raw / 100 : raw
  if (fraction <= 0 || fraction >= 1) {
    throw new FatigueInputError(`drop_threshold must be between 0 and 1 (or 0 and 100 as a percent), got ${value}`)
  }
  return fraction
}

const DAY_MS = 86_400_000

function parseIsoDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  // Reject impossible dates like 2026-02-31, which Date.UTC silently rolls over.
  return new Date(t).toISOString().slice(0, 10) === s.trim() ? t : null
}

const toIso = (t: number) => new Date(t).toISOString().slice(0, 10)

function parseCount(s: string | undefined): number | null {
  if (s === undefined) return null
  const cleaned = s.trim().replace(/,/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const ctr = (clicks: number, impressions: number) => (impressions > 0 ? clicks / impressions : null)

interface Creative {
  ad_id: string
  creative_name: string
  format: string
  days: Map<number, { impressions: number; clicks: number }>
}

export function flagFatiguedCreatives(csvText: string, options: Options = {}): FatigueReport {
  const threshold = normalizeThreshold(options.dropThreshold)
  const minImpressions = options.minImpressions ?? DEFAULTS.minImpressions
  const baselineDays = options.baselineDays ?? DEFAULTS.baselineDays
  const currentDays = options.currentDays ?? DEFAULTS.currentDays
  const minActiveDays = options.minActiveDays ?? DEFAULTS.minActiveDays
  const warnings: string[] = []

  const rows = parseCsv(csvText)
  if (rows.length < 2) throw new FatigueInputError('CSV has no data rows')

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const idx = {
    date: col('date'),
    ad_id: col('ad_id'),
    creative_name: col('creative_name'),
    format: col('format'),
    impressions: col('impressions'),
    clicks: col('clicks'),
  }
  const missing = (['date', 'ad_id', 'impressions', 'clicks'] as const).filter((k) => idx[k] === -1)
  if (missing.length) {
    throw new FatigueInputError(`CSV is missing required column(s): ${missing.join(', ')}. Found: ${header.join(', ')}`)
  }

  const creatives = new Map<string, Creative>()
  let minDate = Infinity
  let maxDate = -Infinity
  let duplicates = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const line = r + 1
    const adId = (row[idx.ad_id] ?? '').trim()
    const date = parseIsoDate(row[idx.date] ?? '')
    const impressions = parseCount(row[idx.impressions])
    const clicks = parseCount(row[idx.clicks])

    if (!adId) {
      warnings.push(`Line ${line}: missing ad_id, row skipped`)
      continue
    }
    if (date === null) {
      warnings.push(`Line ${line}: invalid date "${row[idx.date] ?? ''}" (expected YYYY-MM-DD), row skipped`)
      continue
    }
    if (impressions === null || clicks === null) {
      warnings.push(`Line ${line}: impressions/clicks must be non-negative numbers, row skipped`)
      continue
    }
    if (clicks > impressions) {
      warnings.push(`Line ${line}: ${adId} has more clicks (${clicks}) than impressions (${impressions}), row skipped`)
      continue
    }

    let c = creatives.get(adId)
    if (!c) {
      c = { ad_id: adId, creative_name: '', format: '', days: new Map() }
      creatives.set(adId, c)
    }
    if (!c.creative_name && idx.creative_name !== -1) c.creative_name = (row[idx.creative_name] ?? '').trim()
    if (!c.format && idx.format !== -1) c.format = (row[idx.format] ?? '').trim()

    const day = c.days.get(date)
    if (day) {
      // Same ad on the same day twice (e.g. split placements): sum them.
      day.impressions += impressions
      day.clicks += clicks
      duplicates++
    } else {
      c.days.set(date, { impressions, clicks })
    }
    minDate = Math.min(minDate, date)
    maxDate = Math.max(maxDate, date)
  }

  if (creatives.size === 0) throw new FatigueInputError('No valid rows found in CSV')
  if (duplicates) warnings.push(`${duplicates} duplicate ad_id/date row(s) were summed together`)

  // "Last 7 days in the file" is a calendar window ending on the file's last date,
  // shared by every creative. A creative with no row on a day had 0 impressions.
  const currentStart = maxDate - (currentDays - 1) * DAY_MS
  const results: CreativeResult[] = []

  for (const c of creatives.values()) {
    const activeDates = [...c.days.entries()]
      .filter(([, d]) => d.impressions > 0)
      .map(([t]) => t)
      .sort((a, b) => a - b)

    const daily: DailyPoint[] = []
    for (let t = minDate; t <= maxDate; t += DAY_MS) {
      const d = c.days.get(t) ?? { impressions: 0, clicks: 0 }
      daily.push({ date: toIso(t), impressions: d.impressions, clicks: d.clicks, ctr: ctr(d.clicks, d.impressions) })
    }

    // Baseline: the first N days that actually delivered, so a late launch or an
    // early pause doesn't drag zeros into the baseline.
    const baselineDates = activeDates.slice(0, baselineDays)
    let baselineImpr = 0
    let baselineClicks = 0
    for (const t of baselineDates) {
      const d = c.days.get(t)!
      baselineImpr += d.impressions
      baselineClicks += d.clicks
    }

    let currentImpr = 0
    let currentClicks = 0
    for (const [t, d] of c.days) {
      if (t >= currentStart && t <= maxDate) {
        currentImpr += d.impressions
        currentClicks += d.clicks
      }
    }

    // CTRs are impression-weighted (sum clicks / sum impressions), not an
    // average of daily CTRs, so a 200-impression day can't swing the result.
    const baselineCtr = ctr(baselineClicks, baselineImpr)
    const currentCtr = ctr(currentClicks, currentImpr)
    const drop = baselineCtr !== null && baselineCtr > 0 && currentCtr !== null ? 1 - currentCtr / baselineCtr : null

    let status: Status
    let reason: string
    if (activeDates.length < minActiveDays) {
      status = 'too new to judge'
      reason = `Only ${activeDates.length} day(s) with delivery; need ${minActiveDays}`
    } else if (currentImpr < minImpressions) {
      status = 'not enough volume'
      reason =
        currentImpr === 0
          ? `Paused: no impressions in the last ${currentDays} days`
          : `${currentImpr.toLocaleString('en-IN')} impressions in the last ${currentDays} days; need ${minImpressions.toLocaleString('en-IN')}`
    } else if (drop === null) {
      status = 'ok'
      reason = 'Baseline had no clicks, so a drop cannot be measured'
    } else if (drop >= threshold - EPS) {
      status = 'flagged'
      reason = `CTR down ${(drop * 100).toFixed(1)}% vs baseline (threshold ${(threshold * 100).toFixed(0)}%)`
    } else {
      status = 'ok'
      reason =
        drop < 0
          ? `CTR up ${(-drop * 100).toFixed(1)}% vs baseline`
          : `CTR down ${(drop * 100).toFixed(1)}%, under the ${(threshold * 100).toFixed(0)}% threshold`
    }

    results.push({
      ad_id: c.ad_id,
      creative_name: c.creative_name,
      format: c.format,
      status,
      reason,
      baseline_ctr: baselineCtr,
      current_ctr: currentCtr,
      drop,
      active_days: activeDates.length,
      baseline_impressions: baselineImpr,
      baseline_clicks: baselineClicks,
      current_impressions: currentImpr,
      current_clicks: currentClicks,
      baseline_window: baselineDates.length
        ? { start: toIso(baselineDates[0]), end: toIso(baselineDates[baselineDates.length - 1]) }
        : null,
      daily,
    })
  }

  const order: Record<Status, number> = { flagged: 0, ok: 1, 'not enough volume': 2, 'too new to judge': 3 }
  results.sort(
    (a, b) => order[a.status] - order[b.status] || (b.drop ?? -Infinity) - (a.drop ?? -Infinity) || a.ad_id.localeCompare(b.ad_id),
  )

  const summary = { total: results.length, flagged: 0, ok: 0, 'too new to judge': 0, 'not enough volume': 0 }
  for (const r of results) summary[r.status]++

  return {
    drop_threshold: threshold,
    min_impressions: minImpressions,
    file_window: { start: toIso(minDate), end: toIso(maxDate) },
    current_window: { start: toIso(currentStart), end: toIso(maxDate) },
    summary,
    flagged: results.filter((r) => r.status === 'flagged').map((r) => r.ad_id),
    creatives: results,
    warnings,
  }
}

const MAX_CSV_BYTES = 5_000_000

/** Downloads a CSV with basic validation, a timeout and a size cap. */
export async function fetchCsvText(csvUrl: string): Promise<string> {
  let url: URL
  try {
    url = new URL(csvUrl)
  } catch {
    throw new FatigueInputError(`csv_url is not a valid URL: "${csvUrl}"`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new FatigueInputError('csv_url must be an http(s) URL')
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new FatigueInputError(`Could not download CSV: HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_CSV_BYTES) throw new FatigueInputError('CSV is larger than 5 MB')
  return text
}

/** Fetches a CSV from a URL and runs the flagger. Used by the API and the MCP tool. */
export async function flagFatiguedCreativesFromUrl(csvUrl: string, options: Options = {}): Promise<FatigueReport> {
  return flagFatiguedCreatives(await fetchCsvText(csvUrl), options)
}
