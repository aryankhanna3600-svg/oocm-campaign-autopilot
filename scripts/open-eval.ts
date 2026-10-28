/**
 * Open-weight lane vs the Muse Spark API on the same reels.
 *
 *   node scripts/open-eval.ts <results-v2.json> <reel.mp4>...
 *
 * The open model (Muse Spark Open, via OPEN_BASE_URL/OPEN_API_KEY/OPEN_MODEL)
 * sees 16 frames plus the transcript the API run already made, so both lanes
 * judge the same evidence. Prints a field-by-field table and writes
 * open-results.json next to the API results.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { openConfigFromEnv, openJson, sampleFrames } from "../src/meta/openWeight.ts";

const BRIEF = {
  brand: "Sorry Sugar",
  product: "Sorry Sugar coffee cup",
  mustSay: ["Sorry Sugar", "it is low in sugar"],
};

const INSTRUCTIONS = `You check a creator's draft video against a brand's brief before the brand sees it.
You get frames sampled one a second (with their time) and the transcript of what is said.
Answer only from what is in the frames and the transcript. Never assume.
A must-say line counts as said if the meaning is said, in any language. A brand name also counts if it is visible on screen.
An ad disclosure is "#ad", "ad", "advertisement", "paid partnership", "sponsored", or the same in Hindi, said or on screen.
List every brand other than ${BRIEF.brand} that is named in the transcript or visible in a frame.`;

const REQUIRED = ["brand_mentioned", "brand_at_s", "product_on_screen", "product_from_s", "low_sugar_said", "disclosure_present", "other_brands"];

const [resultsPath, ...reels] = process.argv.slice(2);
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
    text: `THE BRIEF\nBrand: ${BRIEF.brand}\nProduct: ${BRIEF.product}\nMust say: 1. ${BRIEF.mustSay[0]} 2. ${BRIEF.mustSay[1]}\nAd disclosure required: yes\n\nTRANSCRIPT\n${transcript || "(no speech)"}\n\nKeys: brand_mentioned (bool), brand_at_s (number|null), product_on_screen (bool), product_from_s (number|null), low_sugar_said (bool), disclosure_present (bool), other_brands (array of names).`,
    frames,
    required: REQUIRED,
    maxTokens: 8000,
  });
  const v = (k: string) => a.items.find((i: any) => i.key === k)?.verdict;
  const apiOther = (a.items.find((i: any) => i.key === "other_brands")?.detail ?? "").replace(/^Also (shown|named): /, "").replace(/\. Not on.*$/, "").split(/,\s*/).filter(Boolean);
  const o = r.data;
  const row = {
    brand: { api: v("must_say_1") === "pass", open: !!o.brand_mentioned },
    disclosure: { api: v("ad_disclosure") === "pass", open: !!o.disclosure_present },
    product: { api: v("product_on_screen"), open: !!o.product_on_screen },
    lowSugar: { api: v("must_say_2") === "pass", open: !!o.low_sugar_said },
    otherBrands: { api: apiOther, open: o.other_brands ?? [] },
    tokens: r.usage,
    ms: r.ms,
    apiMs: a.ms,
  };
  out[name] = { ...row, raw: o };
  const apiSet = new Set(apiOther.map(norm));
  const overlap = (o.other_brands ?? []).filter((b: string) => apiSet.has(norm(b))).length;
  console.log(`${name.slice(8, 40).padEnd(32)} brand ${row.brand.api}/${row.brand.open}  disc ${row.disclosure.api}/${row.disclosure.open}  product ${row.product.api}/${row.product.open}  lowSugar ${row.lowSugar.api}/${row.lowSugar.open}  brands ${overlap}/${apiOther.length} (open listed ${(o.other_brands ?? []).length})  ${(r.ms / 1000).toFixed(1)}s ${JSON.stringify(r.usage)}`);
}
writeFileSync(join(dirname(resultsPath), "open-results.json"), JSON.stringify(out, null, 1));
