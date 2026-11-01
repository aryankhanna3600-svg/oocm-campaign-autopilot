// Distinct per-reel safety-flag categories, capped for brand surfaces.
// Flags are free-text model output ("profanity", "alcohol", ...), so both the
// brand application payload and the creators-for-you cards read them through
// here: at most 5 flags, each cut to 40 chars. Short category strings only —
// never reel content.
export function distinctSafetyFlags(reels: unknown, maxFlags = 5, maxLen = 40): string[] {
  if (!Array.isArray(reels)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of reels) {
    const list = (r as any)?.safety_flags;
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const s = String(f ?? "").trim().slice(0, maxLen);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= maxFlags) return out;
    }
  }
  return out;
}
