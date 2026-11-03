import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { F } from '../ui'
import { OOCM } from '../../constants/theme'
import { fmtSec, type AiCheck } from './types'

// Same look as the "AI check — before the brand" block in src/app/submit/[id].tsx
// (~590-650): open type, hairline separators, no boxes/cards/pills.

const HAIRLINE = 'rgba(26,26,26,0.12)'

function fmtAt(s: number | null | undefined): string | null {
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return fmtSec(n)
}

function fmtCheckedAt(iso?: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    // IST, same as submit screen's sendDay logic
    return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
  } catch { return null }
}

export default function AiCheckBlock({
  aiCheck,
  onSeekAt,
}: {
  aiCheck: AiCheck | null | undefined
  /** If provided, "at m:ss" becomes a pressable that seeks the draft viewer. */
  onSeekAt?: (at: number) => void
}) {
  const [showTranscript, setShowTranscript] = useState(false)

  if (!aiCheck) return null

  if (aiCheck.state === 'running') {
    return (
      <View style={s.wrap} accessibilityLabel="AI check">
        <Text style={s.muted}>Checking the draft against the brief…</Text>
      </View>
    )
  }

  if (aiCheck.state === 'unchecked') {
    return (
      <View style={s.wrap} accessibilityLabel="AI check">
        <Text style={s.muted}>
          Our AI couldn’t check this video{aiCheck.why ? ` — ${aiCheck.why}` : ''}. Review it by eye.
        </Text>
      </View>
    )
  }

  if (aiCheck.state !== 'done') return null

  // done
  const items = Array.isArray(aiCheck.items) ? aiCheck.items : []
  const order: Record<string, number> = { fail: 0, needs_review: 1, pass: 2 }
  const sorted = [...items].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))

  const time = fmtCheckedAt(aiCheck.checked_at)

  // Facts line from report — skip missing parts
  const r: any = aiCheck.report ?? {}
  // Number(null) is 0, so a missing value must stay missing, never "0s".
  const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
  const duration = num(r.duration_s)
  const product = num(r.product_s)
  const brandFirst = num(r.brand_first_s)
  const disclosed: boolean | null = typeof r.disclosed === 'boolean' ? r.disclosed : null
  const disclosureHow: string[] = Array.isArray(r.disclosure_how) ? r.disclosure_how : []
  const brandHow: string = r.brand_how === 'shown' ? 'shown' : 'said'
  const HOW: Record<string, string> = { caption: 'in the caption', 'in the video': 'in the video', said: 'out loud', paid_partnership: 'with the paid-partnership label' }
  const facts: string[] = []
  if (product != null) facts.push(duration != null ? `Product on screen ${Math.round(product)}s of ${Math.round(duration)}s` : `Product on screen ${Math.round(product)}s`)
  if (brandFirst != null) {
    const at = fmtAt(brandFirst)
    if (at) facts.push(`brand first ${brandHow} at ${at}`)
  }
  if (disclosed === true) {
    const how = disclosureHow.map(h => HOW[h] ?? h).join(', ')
    facts.push(how ? `ad disclosed ${how}` : 'ad disclosed')
  } else if (disclosed === false) {
    facts.push('ad not disclosed')
  }

  const glyph = (v: string) => (v === 'fail' ? '✗' : v === 'pass' ? '✓' : '?')
  const glyphColor = (v: string) => (v === 'fail' ? OOCM.danger : v === 'pass' ? OOCM.success : OOCM.gold)

  const hasTranscript = typeof aiCheck.transcript === 'string' && aiCheck.transcript.trim().length > 0

  return (
    <View style={s.wrap} accessibilityLabel="AI check">
      <Text style={s.kicker}>DRAFT CHECK · AI{time ? ` · ${time}` : ''}</Text>
      {aiCheck.summary ? <Text style={s.summary}>{aiCheck.summary}</Text> : null}

      {sorted.map((it, i) => {
        const at = fmtAt(it.at_s)
        const canSeek = at != null && it.at_s != null && typeof onSeekAt === 'function'
        return (
          <View key={it.key ?? String(i)} style={s.row}>
            <Text style={s.itemLine}>
              <Text style={[s.glyph, { color: glyphColor(it.verdict) }]}>{glyph(it.verdict)} </Text>
              <Text style={s.itemLabel}>{it.label ?? it.key.replace(/_/g, ' ')}</Text>
              {it.detail ? <Text style={s.itemDetail}>{` — ${it.detail}`}</Text> : null}
            </Text>
            {it.quote ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', marginTop: 4 }}>
                <Text style={s.quote}>“{it.quote}”</Text>
                {at ? (
                  canSeek ? (
                    <Pressable
                      onPress={() => onSeekAt!(it.at_s!)}
                      hitSlop={6}
                      style={s.timePress}
                      accessibilityRole="button"
                      accessibilityLabel={`Go to ${at}`}
                    >
                      <Text style={s.timeLink}> · at {at}</Text>
                    </Pressable>
                  ) : (
                    <Text style={s.timePlain}> · at {at}</Text>
                  )
                ) : null}
              </View>
            ) : at ? (
              canSeek ? (
                <Pressable
                  onPress={() => onSeekAt!(it.at_s!)}
                  hitSlop={6}
                  style={s.timePress}
                  accessibilityRole="button"
                  accessibilityLabel={`Go to ${at}`}
                >
                  <Text style={s.timeLink}>at {at}</Text>
                </Pressable>
              ) : (
                <Text style={s.mutedSm}>at {at}</Text>
              )
            ) : null}
          </View>
        )
      })}

      {facts.length > 0 ? <Text style={s.facts}>{facts.join(' · ')}</Text> : null}

      {hasTranscript ? (
        <View style={s.transcriptWrap}>
          <Pressable
            onPress={() => setShowTranscript(v => !v)}
            hitSlop={8}
            style={s.transcriptBtn}
            accessibilityRole="button"
            accessibilityLabel={showTranscript ? 'Hide transcript' : 'Read what they said'}
          >
            <Text style={s.transcriptLink}>{showTranscript ? 'Hide transcript' : 'Read what they said'}</Text>
          </Pressable>
          {showTranscript ? <Text style={s.transcriptText}>{aiCheck.transcript}</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: {
    // Outside the draft card's bone — open type, like submit/[id].tsx
    marginTop: 8,
    gap: 0,
  },
  kicker: {
    fontFamily: F.sansBold,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: OOCM.blue,
  },
  summary: {
    fontFamily: F.sans,
    fontSize: 13.5,
    lineHeight: 19,
    color: OOCM.ink,
    marginTop: 6,
  },
  row: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: HAIRLINE,
    paddingVertical: 10,
    marginTop: 8,
  },
  itemLine: {
    fontFamily: F.sans,
    fontSize: 13,
    lineHeight: 19,
    color: OOCM.ink,
  },
  glyph: {
    fontFamily: F.sansBold,
  },
  itemLabel: {
    fontFamily: F.sansBold,
    color: OOCM.ink,
  },
  itemDetail: {
    fontFamily: F.sans,
    color: OOCM.inkSoft,
  },
  quote: {
    fontFamily: F.accent,
    fontSize: 15,
    lineHeight: 21,
    color: OOCM.inkSoft,
  },
  timeLink: {
    fontFamily: F.sansMedium,
    fontSize: 12,
    color: OOCM.blue,
    textDecorationLine: 'underline',
  },
  timePlain: {
    fontFamily: F.sans,
    fontSize: 12,
    color: OOCM.inkSoft,
  },
  timePress: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 2,
    marginLeft: 2,
  },
  muted: {
    fontFamily: F.sans,
    fontSize: 13,
    lineHeight: 19,
    color: OOCM.inkSoft,
  },
  mutedSm: {
    fontFamily: F.sans,
    fontSize: 12,
    color: OOCM.inkSoft,
    marginTop: 4,
  },
  facts: {
    fontFamily: F.sans,
    fontSize: 12,
    lineHeight: 17,
    color: OOCM.inkSoft,
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: HAIRLINE,
    paddingTop: 8,
  },
  transcriptWrap: {
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: HAIRLINE,
    paddingTop: 8,
  },
  transcriptBtn: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  transcriptLink: {
    fontFamily: F.sansMedium,
    fontSize: 13,
    color: OOCM.blue,
  },
  transcriptText: {
    fontFamily: F.sans,
    fontSize: 13,
    lineHeight: 19,
    color: OOCM.inkSoft,
    marginTop: 6,
  },
})
