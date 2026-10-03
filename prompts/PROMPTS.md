# Prompts used to build this

Built with Claude (Claude Code) as the coding agent. These are the prompts in order, lightly cleaned up. Agent configuration is in `../CLAUDE.md`.

## 1. Understand the brief
> Read the Monastic Media AI Engineer role and its fast-track challenge. Pull out the exact rules: baseline window, current window, drop formula, threshold, minimum volume, the status labels, and the CSV columns of the sample file.

## 2. Plan
> Build a creative fatigue flagger. One pure TypeScript function holds all the logic; the React UI, a JSON API and an MCP tool must all call it so they can never disagree. Deploy target is Vercel (free). Keep dependencies minimal: no chart library, no CSV library, no MCP SDK.

## 3. Logic and edge cases
> Implement flagFatiguedCreatives(csv, options). Decide and document: impression-weighted CTR vs averaging daily CTRs; zero-impression days and missing rows as pauses; whether "last 7 days" is per creative or file-wide; what "14 days" means for a creative that paused or launched late; what happens exactly at the threshold with float rounding; a baseline with zero clicks; duplicate rows; quoted names with commas; bad rows.

## 4. Tests first for the tricky parts
> Write vitest tests with a tiny CSV builder helper. Cover: 40% drop flagged, exactly 30% flagged despite float noise, just under not flagged, custom threshold as fraction and percent, weighted vs naive CTR, CTR increase, zero-click baseline, collapse to zero, 13 vs 14 delivering days, late launch baseline, paused days, paused all last week, recovering creative, low volume with a big drop, exactly 5,000 impressions, file-wide window, duplicates, bad rows, column order/case, missing columns.

## 5. Demo data
> Generate a deterministic demo CSV in the same schema with one creative per edge case, and a test that pins the expected status of each.

## 6. API and MCP
> Expose the function as /api/flag (GET with csv_url, POST JSON, or POST a raw CSV) and /api/mcp (stateless Streamable HTTP MCP: initialize, tools/list, tools/call for flag_fatigued_creatives). Tool errors go back in-band with isError so the calling model can recover. Make both work in `npm run dev` too.

## 7. UI
> React page: upload or drop a CSV, or load from URL (with a proxy fallback for hosts without CORS), threshold slider and impressions floor that recompute instantly, summary tiles that filter the table, and a table with baseline CTR, current CTR, drop, last-7-day impressions, status with a plain-English reason, and an SVG sparkline of daily CTR (gaps for paused days, dashed baseline, shaded current window). Works in dark mode and on mobile.

## 8. Review
> Take a screenshot of the page with the demo data and check every status matches the test expectations. Re-read the diff for anything that would fail on Vercel (ESM import extensions, Node version, function signatures).
