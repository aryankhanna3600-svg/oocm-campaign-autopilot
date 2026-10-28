/**
 * Creator fit demo: profile every reel in a folder (one creator per file name
 * prefix "<tag>_<username>_<code>.mp4"), then score each creator against briefs.
 *
 *   node scripts/fit.ts <folder> [briefs.json]
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProfile, fitScore, profileReel, type FitBrief, type ReelProfile } from "../src/creatorFit/fit.ts";

const dir = process.argv[2];
const briefs: FitBrief[] = process.argv[3] ? (await import(join(process.cwd(), process.argv[3]), { with: { type: "json" } })).default : [];
const ffmpeg = process.env.FFMPEG_BIN;

const byCreator = new Map<string, string[]>();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".mp4"))) {
  // Instagram codes are 11 characters and may themselves contain "_".
  const m = f.match(/^[a-z]+_(.+)_([A-Za-z0-9_-]{11})\.mp4$/);
  const user = m ? m[1] : f.replace(/\.mp4$/, "");
  byCreator.set(user, [...(byCreator.get(user) ?? []), join(dir, f)]);
}

const out: Record<string, any> = {};
const queue = [...byCreator.entries()];
await Promise.all(
  [0, 1, 2, 3].map(async () => {
    while (queue.length) {
      const [user, files] = queue.shift()!;
      const reels: ReelProfile[] = [];
      for (const f of files) {
        try {
          reels.push((await profileReel({ path: f }, { ffmpeg })).profile);
        } catch (e: any) {
          console.error(`${user}: ${f}: ${e.message}`);
        }
      }
      if (!reels.length) continue;
      const profile = buildProfile(reels);
      const fits: Record<string, any> = {};
      for (const b of briefs) fits[b.brand] = (await fitScore(profile, b)).fit;
      out[user] = { profile, reels, fits };
      console.log(`\n== @${user}  ${profile.niches.map((n) => n.tag).join(", ")} | ${profile.formats.map((x) => x.format).join(", ")} | ${profile.languages.join(", ")} | hook ${profile.hook_strength} quality ${profile.production_quality}`);
      for (const [brand, f] of Object.entries(fits)) console.log(`   ${brand.padEnd(14)} ${String(f.score).padStart(3)} ${f.verdict.padEnd(6)} ${f.reasons[0] ?? ""}`);
    }
  }),
);
writeFileSync(join(dir, "fit-results.json"), JSON.stringify(out, null, 1));
