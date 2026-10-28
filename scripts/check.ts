import { readFileSync } from "node:fs";
import { checkDraft, type Brief } from "../src/draftCheck/check.ts";
const brief: Brief = {
  brand: "Dewdrop", product: "Dewdrop Glow Serum",
  mustSay: ["You have used it for two weeks", "Use code DEW10 for 10% off"],
  mustShow: [], competitors: ["Lumen Skin"], disclosureRequired: true,
  donts: "Do not say anything negative about the product.",
};
for (const f of process.argv.slice(2)) {
  const r = await checkDraft(readFileSync(f), brief);
  console.log(`\n=== ${f.split("/").pop()}  ${r.ms}ms  ${r.durationS.toFixed(1)}s  models=${r.models.join(",")}  spark=${JSON.stringify(r.usage.spark.total_tokens)} sam=${r.usage.samFrames}`);
  for (const it of r.items) console.log(`  ${it.verdict.padEnd(12)} ${it.label.padEnd(42).slice(0,42)} ${it.detail}  [${it.sources.join("+")}]`);
  console.log("  SUMMARY:", r.summary);
}
