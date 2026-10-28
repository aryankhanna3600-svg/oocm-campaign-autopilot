/**
 * Turn a campaign's free-text brief into the checkable Brief the draft checker
 * needs: the product as it looks on camera, the lines the creator must say,
 * what must be shown, and the competitors that must not appear.
 *
 * Brands write briefs as prose ("talk about the 10% code, no other skincare
 * brands, keep it fun"). Muse Spark reads the prose once per brief version;
 * the result is cached by the caller against a hash of the source text.
 *
 * Built during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).
 */
import { createHash } from "node:crypto";
import { respond } from "../meta/client.ts";
import type { Brief } from "./check.ts";

export interface BriefSource {
  brand: string;
  campaign: string;
  offer?: string | null;
  whatGiving?: string | null;
  whatDoing?: string | null;
  dos?: string | null;
  donts?: string | null;
  productLink?: string | null;
}

export function briefHash(src: BriefSource): string {
  return createHash("sha256").update(JSON.stringify(src)).digest("hex").slice(0, 16);
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["product", "must_say", "must_show", "competitors", "disclosure_required", "language", "checkable"],
  properties: {
    product: { type: "string", description: "The product as a plain object, 1 to 3 generic words with no brand name (\"serum bottle\", \"protein bar\", \"sneakers\"). Empty if the brief is not about a physical product." },
    must_say: { type: "array", maxItems: 5, items: { type: "string" }, description: "What the creator is told to say: discount codes, offers, claims. Write the content itself, not the instruction (\"fragrance free\", not \"Say it is fragrance free\"). Short, one per item." },
    must_show: { type: "array", maxItems: 4, items: { type: "string" }, description: "Things the brief says must be visible, other than the product itself and other than the ad disclosure (#ad is checked separately)." },
    competitors: { type: "array", maxItems: 10, items: { type: "string" }, description: "Brand names the brief forbids. Only names written in the brief." },
    disclosure_required: { type: "boolean", description: "False only if the brief explicitly says no ad disclosure is needed." },
    language: { type: "string", description: "The language the brief asks the video to be in, or empty." },
    checkable: { type: "boolean", description: "False if there is nothing in the brief a video could be checked against." },
  },
};

const INSTRUCTIONS = `You turn an influencer-marketing brief into a short checklist for reviewing the creator's video.
Use only what the brief says. Never invent codes, claims or competitor names.
Keep must-say items to what the brief actually asks the creator to say or mention; skip tone and style advice.
Write every item in the brief's own words where possible.`;

export async function briefFromText(src: BriefSource, model?: string): Promise<{ brief: Brief; checkable: boolean; usage: { input_tokens?: number; output_tokens?: number } }> {
  const text = [
    `Brand: ${src.brand}`,
    `Campaign: ${src.campaign}`,
    src.offer && `Offer: ${src.offer}`,
    src.whatGiving && `What the brand gives the creator: ${src.whatGiving}`,
    src.whatDoing && `What the creator does: ${src.whatDoing}`,
    src.dos && `Do's: ${src.dos}`,
    src.donts && `Don'ts: ${src.donts}`,
    src.productLink && `Product link: ${src.productLink}`,
  ].filter(Boolean).join("\n");
  const r = await respond<{ product: string; must_say: string[]; must_show: string[]; competitors: string[]; disclosure_required: boolean; language: string; checkable: boolean }>({
    model,
    instructions: INSTRUCTIONS,
    content: [{ type: "input_text", text }],
    schema: { name: "brief", schema: SCHEMA },
    maxOutputTokens: 2000,
    effort: "low",
  });
  const d = r.data;
  return {
    brief: {
      brand: src.brand,
      product: d.product.trim(),
      mustSay: d.must_say.map((s) => s.trim()).filter(Boolean),
      mustShow: d.must_show.map((s) => s.trim()).filter(Boolean),
      competitors: d.competitors.map((s) => s.trim()).filter(Boolean),
      disclosureRequired: d.disclosure_required,
      dos: src.dos ?? undefined,
      donts: src.donts ?? undefined,
      language: d.language.trim() || undefined,
    },
    checkable: d.checkable,
    usage: r.usage,
  };
}
