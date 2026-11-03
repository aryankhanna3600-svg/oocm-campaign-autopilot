import type { AiCheckItem, AiCheckReport } from './types'

export const clock = (s?: number | null): string => {
  if (s == null || Number.isNaN(s)) return ''
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export const when = (iso?: string | null): string => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const rank = (v: string): number => {
  if (v === 'fail') return 0
  if (v === 'needs_review') return 1
  return 2
}

export const sortAiCheckItems = (items: AiCheckItem[]): AiCheckItem[] => {
  const copy = [...items]
  copy.sort((a, b) => rank(a.verdict) - rank(b.verdict))
  return copy
}

/** Where the ad disclosure was found, in words ("in the caption, out loud"). */
const HOW: Record<string, string> = { caption: 'in the caption', 'in the video': 'in the video', said: 'out loud', paid_partnership: 'with the paid-partnership label' }
export const disclosureHow = (how?: string[] | null): string => (how?.length ? ` ${how.map(h => HOW[h] ?? h).join(', ')}` : '')

/** A detail line that only repeats the quote (e.g. 'Said at 0:20: "…"') is dropped when the quote is shown. */
export const detailRepeatsQuote = (detail?: string | null, quote?: string | null): boolean =>
  !!detail && !!quote && detail.includes(quote.slice(0, 40))

export const buildFactsLine = (report?: AiCheckReport | null): string | null => {
  if (!report) return null
  const parts: string[] = []
  const r = report
  if (r.product_s != null) {
    if (r.product_s === 0) parts.push('product not seen')
    else if (r.duration_s != null) parts.push(`product on screen ${Math.round(r.product_s)}s of ${Math.round(r.duration_s)}s`)
    else parts.push(`product on screen ${Math.round(r.product_s)}s`)
    // product_share is not shown alone; it's implicit in the "of" already
  }
  if (r.brand_first_s != null) {
    const how = r.brand_how ?? 'said'
    parts.push(`brand first ${how} at ${clock(r.brand_first_s)}`)
  }
  if (r.disclosed != null) {
    if (r.disclosed) {
      const how = disclosureHow(r.disclosure_how)
      parts.push(`ad disclosed${how}`)
    } else {
      parts.push('no ad disclosure')
    }
  }
  if (!parts.length) return null
  return parts.join(' · ')
}

// For rendering with interactive times: split facts into segments where the time is a button
// We keep string helper for tests; component will handle interactive rendering separately.
