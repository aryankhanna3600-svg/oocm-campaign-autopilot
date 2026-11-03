/**
 * Which model serves the builder's four structured calls (research, options,
 * reviewWords, references), and the per-call Claude fallback.
 *
 * BUILDER_MODEL=meta routes to Muse Spark through the mirrored modules in
 * src/services/meta/ (Meta hackathon, 27 Oct to 4 Nov). Anything else — or
 * unset — keeps the Claude path byte-for-byte identical.
 *
 * A failed Meta call falls back to Claude under the same contract, so the
 * brand never sees a Meta outage as a failed session. The serving path rides
 * on the result ({path:"meta"|"claude"}) and every fallback is logged, so the
 * eval can tell the two models apart and a dead Meta key cannot hide.
 *
 * The Claude client is lazy-imported (it pulls the usage logger, which pulls
 * entities; the rulebook test stays pure) — same pattern as options.ts.
 *
 * Product-side file: not mirrored to the public repo.
 */

import type { AiResult, RunStructuredArgs } from "../ai/client";
import { runStructuredMeta } from "../meta/runStructuredMeta";
import { logUsage as logMetaUsage, metaOverBudget } from "../meta/usage";
import logger from "../../utils/logger";

/** Muse needs about 45s on a good options run; the 50s default in
 *  runStructuredMeta sent any slower run to Claude without a trace. */
export const BUILDER_META_BUDGET_MS = 150_000;

export const builderModelIsMeta = (): boolean => process.env.BUILDER_MODEL === "meta";

export type BuilderPath = "meta" | "claude";

/** AiResult plus which model served it. Assignable wherever AiResult is expected. */
export type BuilderResult<T> = AiResult<T> & { path: BuilderPath };

const claude = async <T>(args: RunStructuredArgs<T>): Promise<BuilderResult<T>> => {
  const { runStructured } = await import("../ai/client");
  const r = await runStructured<T>(args);
  return { ...r, path: "claude" } as BuilderResult<T>;
};

const systemText = (system: RunStructuredArgs<unknown>["system"]): string =>
  typeof system === "string" ? system : system.filter((b) => b?.type === "text").map((b) => String((b as any).text ?? "")).join("\n");

/**
 * Drop-in for runStructured at the four builder call sites: same args, same
 * result shape, plus `path`. Meta failure kinds are identical to
 * AiFailureKind, so a Meta failure maps without translation.
 */
export async function runBuilderStructured<T>(args: RunStructuredArgs<T>): Promise<BuilderResult<T>> {
  if (!builderModelIsMeta()) return claude(args);
  if (await metaOverBudget()) {
    logger.warn(`builder meta skipped: monthly Meta spend hit the cap; serving ${args.feature} from Claude.`);
    return claude(args);
  }
  const single = (args.messages?.length === 1 ? args.messages[0] : null) as any;
  const content = typeof single?.content === "string"
    ? single.content
    : Array.isArray(single?.content)
      ? single.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n")
      : "";
  try {
    const m = await runStructuredMeta<T>({
      feature: args.feature,
      system: systemText(args.system),
      messages: [{ role: "user", content }],
      schema: args.schema as any,
      schemaName: args.feature.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64) || "builder",
      maxOutputTokens: args.maxTokens,
      effort: args.effort,
      refId: args.refId,
      tools: (args.tools as Array<Record<string, unknown>> | undefined),
      timeoutMs: BUILDER_META_BUDGET_MS,
      budgetMs: BUILDER_META_BUDGET_MS,
      logUsage: (u) => {
        void logMetaUsage(
          u.feature, u.model,
          { input_tokens: u.inputTokens ?? 0, output_tokens: u.outputTokens ?? 0, ...(u.searches ? { web_searches: u.searches } : {}) },
          u.costUsd, u.refId ?? null,
        );
      },
    });
    if (m.ok) {
      return {
        ok: true, data: m.data, model: m.model,
        usage: { input_tokens: m.usage.input_tokens ?? 0, output_tokens: m.usage.output_tokens ?? 0 } as any,
        costUsd: m.costUsd, stopReason: "meta_structured", path: "meta",
      };
    }
    logger.warn(`builder meta fallback: ${args.feature} failed on Meta (${m.failure.kind}); serving from Claude.`);
  } catch (e: any) {
    // Programmer errors (an unconvertible schema, an unknown tool) throw loud
    // inside runStructuredMeta — the session still serves from Claude, and
    // this warn is the loud part: fix the schema, don't ship the fallback.
    logger.warn(`builder meta fallback: ${args.feature} threw (${String(e?.message ?? e).slice(0, 200)}); serving from Claude.`);
  }
  return claude(args);
}
