/**
 * Open-weight lane vs the Muse Spark API on the same reels.
 *
 *   node scripts/open-eval.ts <results-v2.json> <reel.mp4>... [--out <name.json>]
 *
 * The open model (Muse Spark Open, via OPEN_BASE_URL/OPEN_API_KEY/OPEN_MODEL)
 * sees 16 frames plus the transcript the API run already made, so both lanes
 * judge the same evidence. Prints a field-by-field table and writes the
 * results next to the API results (default open-results.json; pass --out to
 * avoid overwriting an older run).
 *
 * Must-say is strict, the same as the API lane (src/draftCheck/check.ts):
 * the model must give an EXACT quote from the transcript for each line, and
 * the quote is checked against the transcript in code with transcriptSupport
 * (>= 0.6). A bare "said: true" with no supporting quote does not pass.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { openConfigFromEnv, openJson, sampleFrames } from "../src/meta/openWeight.ts";
import { transcriptSupport } from "../src/draftCheck/check.ts";

const BRIEF = {
  brand: "Sorry Sugar",
  product: "Sorry Sugar coffee cup",
  mustSay: ["Sorry Sugar", "it is low in sugar"],
};

const INSTRUCTIONS = `You check a creator's draft video against a brand's brief before the brand sees it.
You get frames sampled one a second (with their time) and the transcript of what is said.
Answer only from what is in the frames and the transcript. Never assume.
A must-say line counts as said only if its meaning is said in the transcript, in any language: set the bool true AND copy the exact words from the transcript, unchanged and in the transcript's own script, as the quote. If the meaning is not said, set the bool false and the quote null. Never invent a quote.
A brand name also counts if it is visible on screen (say so in the quote as "on screen at Ns" only when it is NOT said; a spoken quote wins).
An ad disclosure is "#ad", "ad", "advertisement", "paid partnership", "sponsored", or the same in Hindi, said or on screen.
List every brand other than ${BRIEF.brand} that is named in the transcript or visible in a frame.`;

const REQUIRED = ["brand_mentioned", "brand_at_s", "brand_quote", "product_on_screen", "product_from_s", "low_sugar_said", "low_sugar_quote", "disclosure_present", "other_brands"];

const argv = process.argv.slice(2);
let outName = "open-results.json";
const oi = argv.indexOf("--out");
if (oi >= 0 && argv[oi + 1]) { outName = argv[oi + 1]; argv.splice(oi, 2); }
const [resultsPath, ...reels] = argv;
const api = JSON.parse(readFileSync(resultsPath, "utf8"));
const cfg = openConfigFromEnv();
const out: Record<string, any> = {};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "").replace(/coffee$/, "").replace(/byblinkit$/, "");

for (const reel of reels) {
  const name = basename(reel);
  const a = api[name];
  if (!a) { console.log(`skip ${name}: no API result`); continue; }
  const frames = await sampleFrames(reel, { max: 16 });
  const transcript = a.transcript?.transcript ?? "";
  const r = await openJson<any>(cfg, {
    instructions: INSTRUCTIONS,
    text: `THE BRIEF\nBrand: ${BRIEF.brand}\nProduct: ${BRIEF.product}\nMust say: 1. ${BRIEF.mustSay[0]} 2. ${BRIEF.mustSay[1]}\nAd disclosure required: yes\n\nTRANSCRIPT\n${transcript || "(no speech)"}\n\nKeys: brand_mentioned (bool), brand_at_s (number|null), brand_quote (exact transcript words, or "on screen at Ns", or null), product_on_screen (bool), product_from_s (number|null), low_sugar_said (bool), low_sugar_quote (exact transcript words or null), disclosure_present (bool), other_brands (array of names).`,
    frames,
    required: REQUIRED,
    maxTokens: 8000,
  });
  const v = (k: string) => a.items.find((i: any) => i.key === k)?.verdict;
  const apiOther = (a.items.find((i: any) => i.key === "other_brands")?.detail ?? "").replace(/^Also (shown|named): /, "").replace(/\. Not on.*$/, "").split(/,\s*/).filter(Boolean);
  const o = r.data;
  // Strict must-say, API-lane style: the quote must survive a code check
  // against the transcript (transcriptSupport >= 0.6, check.ts:428). An
  // "on screen" brand quote is display evidence, not speech — it keeps the
  // bool honest but does not pass the transcript gate on its own.
  const quoteSupport = (q: unknown) => (typeof q === "string" && transcript ? transcriptSupport(q, transcript) : 0);
  const brandQ = quoteSupport(o.brand_quote);
  const sugarQ = quoteSupport(o.low_sugar_quote);
  const brandOnScreen = typeof o.brand_quote === "string" && /^on screen/i.test(o.brand_quote.trim());
  const row = {
    brand: { api: v("must_say_1") === "pass", open: !!o.brand_mentioned && (brandQ >= 0.6 || brandOnScreen), quoteSupport: Math.round(brandQ * 100) / 100 },
    disclosure: { api: v("ad_disclosure") === "pass", open: !!o.disclosure_present },
    product: { api: v("product_on_screen"), open: !!o.product_on_screen },
    lowSugar: { api: v("must_say_2") === "pass", open: !!o.low_sugar_said && sugarQ >= 0.6, quoteSupport: Math.round(sugarQ * 100) / 100 },
    otherBrands: { api: apiOther, open: o.other_brands ?? [] },
    tokens: r.usage,
    ms: r.ms,
    apiMs: a.ms,
  };
  out[name] = { ...row, raw: o };
  const apiSet = new Set(apiOther.map(norm));
  const overlap = (o.other_brands ?? []).filter((b: string) => apiSet.has(norm(b))).length;
  console.log(`${name.slice(8, 40).padEnd(32)} brand ${row.brand.api}/${row.brand.open} (q${row.brand.quoteSupport})  disc ${row.disclosure.api}/${row.disclosure.open}  product ${row.product.api}/${row.product.open}  lowSugar ${row.lowSugar.api}/${row.lowSugar.open} (q${row.lowSugar.quoteSupport})  brands ${overlap}/${apiOther.length} (open listed ${(o.other_brands ?? []).length})  ${(r.ms / 1000).toFixed(1)}s ${JSON.stringify(r.usage)}`);
}
writeFileSync(join(dirname(resultsPath), outName), JSON.stringify(out, null, 1));
