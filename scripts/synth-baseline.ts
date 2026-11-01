/**
 * Step 8: API-lane baselines for the synthetic reels (good/bad/hindi), which
 * have no entry in results-v2.json. Same Sorry Sugar brief the open lane is
 * judged against, so open-eval can compare field by field.
 *
 *   META_MODEL_API_KEY=... node scripts/synth-baseline.ts <out.json> <reel.mp4>...
 */
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { checkDraft } from "../src/draftCheck/check.ts";

const BRIEF = {
  brand: "Sorry Sugar",
  product: "Sorry Sugar coffee cup",
  mustSay: ["Sorry Sugar", "it is low in sugar"],
  mustShow: [],
  competitors: [],
  disclosureRequired: true,
};

const [outPath, ...reels] = process.argv.slice(2);
const out: Record<string, any> = {};
for (const reel of reels) {
  const { readFile } = await import("node:fs/promises");
  const r = await checkDraft(await readFile(reel), BRIEF);
  console.log(`${basename(reel)}: ${r.items.map((i) => `${i.key.split("_").pop()}=${i.verdict}`).join(" ")} | spark=${r.usage.spark.total_tokens} sam=${r.usage.samFrames} ${r.durationS.toFixed(1)}s`);
  out[basename(reel)] = r;
}
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`wrote ${outPath}`);
