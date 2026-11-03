import { useState } from 'react'
import { BLUE, DANGER, GOLD, GREEN, INK, LINE, MUTED, PURPLE, STONE } from '../../styles/tokens'
import { FONT_ACCENT, FONT_SANS } from '../../styles/tokens'
import type { AiCheck } from './types'
import { buildFactsLine, clock, detailRepeatsQuote, disclosureHow, sortAiCheckItems, when } from './aiCheckHelpers'

const VERDICT_MARK: Record<string, string> = { pass: '✓', fail: '✗', needs_review: '?' }
const VERDICT_COLOR: Record<string, string> = { pass: GREEN, fail: DANGER, needs_review: GOLD }

function TimeButton({ at, onSeek }: { at: number; onSeek?: (s: number) => void }) {
  const label = clock(at)
  if (!onSeek) return <span style={{ color: MUTED, fontFeatureSettings: '"tnum"' }}>{label}</span>
  return (
    <button
      onClick={e => { e.stopPropagation(); onSeek(at) }}
      aria-label={`Seek to ${label}`}
      style={{
        background: 'transparent',
        border: 'none',
        // Inline in a sentence: no box padding, or every line with a time grows taller.
        padding: '0 2px',
        margin: 0,
        display: 'inline',
        fontFamily: FONT_SANS,
        fontSize: 11.5,
        fontFeatureSettings: '"tnum"',
        color: BLUE,
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

export default function AiCheckBlock({ aiCheck, onSeek }: { aiCheck?: AiCheck | null; onSeek?: (s: number) => void }) {
  const [open, setOpen] = useState(false)

  if (!aiCheck) return null

  const state = aiCheck.state

  // Container is open type: no bg/border/radius, only hairline on top. Fits 390px.
  const wrap: React.CSSProperties = {
    marginTop: 8,
    borderTop: `1px solid ${LINE}`,
    paddingTop: 8,
    paddingLeft: 12,
    paddingRight: 12,
    paddingBottom: 4,
    fontFamily: FONT_SANS,
    maxWidth: '100%',
  }

  if (state === 'running') {
    return (
      <div style={wrap}>
        <p style={{ margin: 0, fontSize: 12, color: MUTED, lineHeight: 1.5 }}>Checking the draft against the brief…</p>
      </div>
    )
  }

  if (state === 'unchecked') {
    const why = aiCheck.why ? ` — ${aiCheck.why}` : ''
    return (
      <div style={wrap}>
        <p style={{ margin: 0, fontSize: 12, color: STONE, lineHeight: 1.5 }}>
          <span style={{ color: GOLD, fontWeight: 700, marginRight: 6 }}>?</span>
          Our AI couldn&apos;t check this video{why}. Review it by eye.
        </p>
      </div>
    )
  }

  // done
  if (state === 'done') {
    const summary = aiCheck.summary ?? ''
    const items = sortAiCheckItems(aiCheck.items ?? [])
    const facts = buildFactsLine(aiCheck.report ?? null)
    const transcript = aiCheck.transcript ?? ''
    const hasTranscript = !!transcript && transcript.trim().length > 0
    const checkedAt = aiCheck.checked_at ?? null

    return (
      <div style={wrap}>
        {/* Kicker like DraftCheckLines */}
        <p className="m-0 uppercase" style={{ fontSize: 10, color: STONE, fontWeight: 600, letterSpacing: '.14em', margin: 0 }}>
          Draft check <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, color: MUTED }}>· AI{checkedAt ? ` · ${when(checkedAt)}` : ''}</span>
        </p>

        {summary && <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.5, color: INK }}>{summary}</p>}

        {items.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {items.map((it, idx) => {
              const mark = VERDICT_MARK[it.verdict] ?? '·'
              const color = VERDICT_COLOR[it.verdict] ?? STONE
              return (
                <div key={it.key} style={{ padding: '6px 0', borderTop: idx > 0 ? `1px solid ${LINE}` : 'none' }}>
                  <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: STONE }}>
                    <span style={{ color, fontWeight: 700 }}>{mark} {it.label}</span>
                    {it.at_s != null && !it.quote && (
                      <>
                        {' '}· <TimeButton at={it.at_s} onSeek={onSeek} />
                      </>
                    )}
                    {it.detail && !detailRepeatsQuote(it.detail, it.quote) && <span> · {it.detail}</span>}
                  </p>
                  {it.quote && (
                    <p
                      style={{
                        margin: '3px 0 0',
                        fontFamily: FONT_ACCENT,
                        fontStyle: 'italic',
                        fontSize: 12.5,
                        lineHeight: 1.4,
                        color: PURPLE,
                      }}
                    >
                      “{it.quote}”
                      {it.at_s != null && (
                        <span style={{ color: MUTED, fontFamily: FONT_SANS, fontStyle: 'normal', fontSize: 11.5 }}>
                          {' '}· at <TimeButton at={it.at_s} onSeek={onSeek} />
                        </span>
                      )}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {facts && (
          <p className="first-letter:uppercase" style={{ margin: '8px 0 0', fontSize: 11.5, lineHeight: 1.45, color: STONE, fontFeatureSettings: '"tnum"' }}>
            {/* facts may contain a time; make brand_first_s seekable if present */}
            <FactsLine report={aiCheck.report ?? null} onSeek={onSeek} />
          </p>
        )}

        {hasTranscript && (
          <div style={{ marginTop: 6 }}>
            <button
              onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
              aria-expanded={open}
              style={{
                background: 'transparent',
                border: 'none',
                padding: '6px 0',
                minHeight: 44,
                fontFamily: FONT_SANS,
                fontSize: 12,
                fontWeight: 600,
                color: BLUE,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: '2px',
              }}
            >
              {open ? 'Hide transcript' : 'Read what they said'}
            </button>
            {open && (
              <p style={{ margin: '2px 0 0', fontSize: 12, lineHeight: 1.5, color: STONE, whiteSpace: 'pre-wrap' }}>{transcript}</p>
            )}
          </div>
        )}
      </div>
    )
  }

  return null
}

function FactsLine({ report, onSeek }: { report: AiCheck['report']; onSeek?: (s: number) => void }) {
  // Reuse same logic as buildFactsLine but with interactive time for brand_first_s
  if (!report) return null
  const segs: React.ReactNode[] = []
  const push = (node: React.ReactNode) => {
    if (segs.length) segs.push(' · ')
    segs.push(node)
  }
  if (report.product_s != null) {
    if (report.product_s === 0) push('product not seen')
    else if (report.duration_s != null) push(`product on screen ${Math.round(report.product_s)}s of ${Math.round(report.duration_s)}s`)
    else push(`product on screen ${Math.round(report.product_s)}s`)
  }
  if (report.brand_first_s != null) {
    const how = report.brand_how ?? 'said'
    push(
      <span key="brand">
        brand first {how} at <TimeButton at={report.brand_first_s} onSeek={onSeek} />
      </span>,
    )
  }
  if (report.disclosed != null) {
    if (report.disclosed) {
      push(`ad disclosed${disclosureHow(report.disclosure_how)}`)
    } else {
      push('no ad disclosure')
    }
  }
  if (!segs.length) return null
  return <>{segs}</>
}
