import { useMemo, useState, type DragEvent } from 'react'
import { FatigueInputError, flagFatiguedCreatives, type CreativeResult, type FatigueReport, type Status } from '../lib/fatigue'
import { Sparkline } from './Sparkline'

const SAMPLE_URL = 'https://api.monastic.media/functions/v1/careers-mcp/challenge/sample-data.csv'
const STATUSES: Status[] = ['flagged', 'ok', 'not enough volume', 'too new to judge']

const pct = (v: number | null, digits = 2) => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`)
const int = (v: number) => v.toLocaleString('en-IN')

async function loadUrl(url: string): Promise<string> {
  // Try the browser first; fall back to our proxy for hosts without CORS headers.
  try {
    const res = await fetch(url)
    if (res.ok) return await res.text()
  } catch {
    /* CORS or network: use the proxy */
  }
  const res = await fetch(`/api/csv?url=${encodeURIComponent(url)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Could not load CSV (HTTP ${res.status})`)
  }
  return res.text()
}

export default function App() {
  const [csvText, setCsvText] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [url, setUrl] = useState(SAMPLE_URL)
  const [threshold, setThreshold] = useState(30)
  const [minImpressions, setMinImpressions] = useState(5000)
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [dragging, setDragging] = useState(false)

  // Recomputed locally on every slider move: the same pure function the API runs.
  const result = useMemo((): { report?: FatigueReport; error?: string } => {
    if (!csvText) return {}
    try {
      return { report: flagFatiguedCreatives(csvText, { dropThreshold: threshold / 100, minImpressions }) }
    } catch (e) {
      return { error: e instanceof FatigueInputError ? e.message : String(e) }
    }
  }, [csvText, threshold, minImpressions])

  async function run(label: string, get: () => Promise<string>) {
    setLoading(true)
    setLoadError('')
    try {
      setCsvText(await get())
      setSource(label)
      setFilter('all')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const onFile = (file: File | undefined) => file && run(file.name, () => file.text())
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    onFile(e.dataTransfer.files[0])
  }

  const report = result.report
  const rows = report?.creatives.filter((c) => filter === 'all' || c.status === filter) ?? []

  return (
    <main>
      <header>
        <h1>Creative Fatigue Flagger</h1>
        <p className="lede">
          Upload daily Meta ad data and see which creatives have lost {threshold}% or more of their baseline CTR.
        </p>
      </header>

      <section className="inputs">
        <div
          className={`drop ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <label className="file">
            <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
            <strong>Choose a CSV</strong> or drop it here
          </label>
          <span className="hint">Columns: date, ad_id, creative_name, format, impressions, clicks, spend_inr</span>
        </div>

        <form
          className="url"
          onSubmit={(e) => {
            e.preventDefault()
            run(url, () => loadUrl(url))
          }}
        >
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/data.csv" required />
          <button type="submit" disabled={loading}>
            {loading ? 'Loading…' : 'Load URL'}
          </button>
          <button type="button" className="secondary" disabled={loading} onClick={() => run('Demo data (all edge cases)', () => loadUrl('/demo-data.csv'))}>
            Try demo data
          </button>
        </form>

        <div className="params">
          <label>
            Drop threshold <b>{threshold}%</b>
            <input type="range" min={5} max={90} step={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
          <label>
            Min impressions, last 7 days
            <input type="number" min={0} step={500} value={minImpressions} onChange={(e) => setMinImpressions(Math.max(0, Number(e.target.value)))} />
          </label>
        </div>
      </section>

      {(loadError || result.error) && <p className="error">{loadError || result.error}</p>}

      {report && (
        <>
          <p className="meta">
            <b>{source}</b> · file {report.file_window.start} → {report.file_window.end} · baseline = first 7 delivering days · current = {report.current_window.start} →{' '}
            {report.current_window.end}
          </p>

          <nav className="tiles">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              <span>{report.summary.total}</span>All creatives
            </button>
            {STATUSES.map((s) => (
              <button key={s} className={`${filter === s ? 'active' : ''} s-${s.replace(/ /g, '-')}`} onClick={() => setFilter(s)}>
                <span>{report.summary[s]}</span>
                {s}
              </button>
            ))}
          </nav>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Creative</th>
                  <th>Status</th>
                  <th className="num">Baseline CTR</th>
                  <th className="num">Current CTR</th>
                  <th className="num">Drop</th>
                  <th className="num">Impr. last 7d</th>
                  <th>Daily CTR</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <Row key={c.ad_id} c={c} report={report} />
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      No creatives with this status.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {report.warnings.length > 0 && (
            <details className="warnings">
              <summary>{report.warnings.length} data warning(s)</summary>
              <ul>
                {report.warnings.slice(0, 50).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {!report && !result.error && (
        <p className="empty-state">Load the Monastic Media sample URL above, upload your own CSV, or try the demo data.</p>
      )}

      <footer>
        Same logic as a JSON API (<code>/api/flag?csv_url=…&amp;drop_threshold=0.3</code>) and an MCP tool (<code>/api/mcp</code> →{' '}
        <code>flag_fatigued_creatives</code>).
      </footer>
    </main>
  )
}

function Row({ c, report }: { c: CreativeResult; report: FatigueReport }) {
  return (
    <tr>
      <td>
        <div className="name">{c.creative_name || c.ad_id}</div>
        <div className="sub">
          {c.ad_id}
          {c.format && ` · ${c.format}`} · {c.active_days} delivering days
        </div>
      </td>
      <td>
        <span className={`pill s-${c.status.replace(/ /g, '-')}`}>{c.status}</span>
        <div className="sub reason">{c.reason}</div>
      </td>
      <td className="num">{pct(c.baseline_ctr)}</td>
      <td className="num">{pct(c.current_ctr)}</td>
      <td className={`num ${c.drop === null ? 'muted' : c.drop > 0 ? 'down' : 'up'}`}>
        {c.drop === null ? '—' : `${c.drop > 0 ? '▼' : '▲'} ${Math.abs(c.drop * 100).toFixed(1)}%`}
      </td>
      <td className={`num ${c.current_impressions < report.min_impressions ? 'muted' : ''}`}>{int(c.current_impressions)}</td>
      <td>
        <Sparkline c={c} currentStart={report.current_window.start} />
      </td>
    </tr>
  )
}
