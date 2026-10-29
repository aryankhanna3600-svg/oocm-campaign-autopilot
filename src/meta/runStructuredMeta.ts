/**
 * runStructuredMeta: the builder's structured calls on Muse Spark.
 *
 * Same return contract as the Claude path (`runStructured` in oocm-api
 * src/services/ai/client.ts): `{ok, data | failure}`, never throws for a
 * model problem. Programmer errors (a schema the converter cannot express,
 * an unknown tool, a multi-turn conversation) throw loud — see zodJson.ts
 * for why silence is worse.
 *
 * Builder calls are single-turn (one user message: research, options, review,
 * references all call with messages:[{role:"user"}]). This is asserted, not
 * assumed: roles flatten to one input_text, and a second turn would silently
 * change meaning, so multi-turn input throws instead of flattening.
 *
 * Attempt order per call (the one retry the builder path allows):
 *   1. strict:true structured output + local zod safeParse (strict JSON
 *      schema cannot carry .min/.max/.refine/.default/transforms, so the
 *      raw answer is NEVER trusted — both paths parse),
 *   2. strict parse failure or 5xx → strict:false + local safeParse,
 *   3. billing/auth/429 → fail immediately, never retried (a second call
 *      cannot fix the account or the key, and 429 already backed off
 *      inside the client),
 *   4. truncation (incomplete/max_output_tokens) → one retry at 1.5x cap,
 *      then kind "max_tokens".
 *
 * Spend is logged through the caller's logUsage (the oocm-api mirror writes
 * meta_usage_log). Pricing: Muse Spark $1.25/$4.25 per M tokens.
 *
 * Built during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).
 */
import { respond, MetaApiError, MetaIncompleteError } from "./client.ts";
import { zodToJsonSchema } from "./zodJson.ts";

export type MetaFailureKind = "disabled" | "refusal" | "max_tokens" | "parse" | "api" | "billing";

export interface MetaFailure {
  kind: MetaFailureKind;
  feature: string;
  model: string;
  message: string;
}

export type MetaEffort = "minimal" | "low" | "medium" | "high";

export interface MetaMessage {
  role: "user";
  /** Plain string, or Anthropic content blocks (text blocks are concatenated). */
  content: string | Array<{ type: string; text?: string }>;
}

export interface RunStructuredMetaArgs<T> {
  feature: string;
  system: string;
  /** Single-turn only: exactly one {role:"user"} message. Anything else throws. */
  messages: MetaMessage[];
  /** A zod v4 object schema (duck-typed; only convert + safeParse are touched). */
  schema: { safeParse: (d: unknown) => { success: boolean; data?: T; error?: unknown } };
  schemaName: string;
  maxOutputTokens?: number;
  /** Maps to reasoning effort. Spark is a reasoning model: keep ≥1500 tokens. */
  effort?: MetaEffort;
  refId?: number;
  /** Anthropic web_search tools are mapped to Meta's {"type":"web_search"}. */
  tools?: Array<Record<string, unknown>>;
  model?: string;
  /** Default 60s for builder text calls. */
  timeoutMs?: number;
  logUsage?: (u: { feature: string; model: string; inputTokens?: number; outputTokens?: number; costUsd: number; refId?: number }) => void | Promise<void>;
}

export type MetaResult<T> =
  | { ok: true; data: T; model: string; usage: { input_tokens?: number; output_tokens?: number }; costUsd: number; strict: boolean }
  | { ok: false; failure: MetaFailure };

export const SPARK_INPUT_PER_M = 1.25;
export const SPARK_OUTPUT_PER_M = 4.25;

export const estimateSparkCostUsd = (input?: number, output?: number): number =>
  (Number(input ?? 0) / 1e6) * SPARK_INPUT_PER_M + (Number(output ?? 0) / 1e6) * SPARK_OUTPUT_PER_M;

const textOf = (m: MetaMessage): string =>
  typeof m.content === "string" ? m.content : m.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => String(b.text)).join("\n");

const mapTools = (tools: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> | undefined => {
  if (!tools?.length) return undefined;
  return tools.map((t) => {
    const type = String((t as any)?.type ?? "");
    if (type === "web_search" || type.startsWith("web_search_")) return { type: "web_search" };
    throw new Error(`runStructuredMeta: unsupported tool "${type}". Map it or remove it.`);
  });
};

const NO_RETRY = (e: any): MetaFailureKind | null => {
  const msg = String(e?.message ?? e);
  if (/credit balance|billing|purchase credits|insufficient/i.test(msg)) return "billing";
  const status = Number((e as MetaApiError)?.status ?? 0);
  if (status === 401 || status === 403) return "api"; // key/auth: retrying cannot fix it
  if (status === 429) return "api"; // already backed off 3x inside the client
  return null;
};

export async function runStructuredMeta<T>(args: RunStructuredMetaArgs<T>): Promise<MetaResult<T>> {
  const model = args.model ?? "muse-spark-1.3";
  if (!process.env.META_MODEL_API_KEY) {
    return { ok: false, failure: { kind: "disabled", feature: args.feature, model, message: "META_MODEL_API_KEY is not set." } };
  }
  if (!Array.isArray(args.messages) || args.messages.length !== 1 || args.messages[0]?.role !== "user") {
    throw new Error("runStructuredMeta: single-turn only — pass exactly one {role:\"user\"} message. Multi-turn would flatten roles and change meaning.");
  }
  const jsonSchema = zodToJsonSchema(args.schema); // throws loud on unsupported constructs
  const content = [{ type: "input_text" as const, text: textOf(args.messages[0]) }];
  const tools = mapTools(args.tools); // throws loud on unknown tools
  const timeoutMs = args.timeoutMs ?? 60_000;
  let cap = Math.max(args.maxOutputTokens ?? 4000, 1500);

  const fail = (kind: MetaFailureKind, message: string): MetaResult<T> => ({
    ok: false, failure: { kind, feature: args.feature, model, message: message.slice(0, 500) },
  });

  // One call at the given strictness. Returns "retry-relaxed" / "retry-cap" /
  // a finished result.
  const attempt = async (strict: boolean): Promise<MetaResult<T> | "retry-relaxed" | "retry-cap"> => {
    let r;
    try {
      r = await respond<unknown>({
        model,
        instructions: args.system,
        content,
        schema: { name: args.schemaName, schema: jsonSchema },
        maxOutputTokens: cap,
        effort: args.effort,
        ...(tools ? { tools } : {}),
        timeoutMs,
        strict,
      });
    } catch (e: any) {
      if (e instanceof MetaIncompleteError) {
        return e.reason === "max_output_tokens" ? "retry-cap" : fail("refusal", `Stopped: ${e.reason}.`);
      }
      const terminal = NO_RETRY(e);
      if (terminal) return fail(terminal, String(e?.message ?? e));
      if (/refusal/i.test(String(e?.message ?? e))) return fail("refusal", "The model refused this request.");
      return strict ? "retry-relaxed" : fail("api", String(e?.message ?? e));
    }
    const costUsd = estimateSparkCostUsd(r.usage.input_tokens, r.usage.output_tokens);
    try {
      await args.logUsage?.({ feature: args.feature, model: r.model || model, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, costUsd, refId: args.refId });
    } catch { /* usage logging never fails the call */ }
    const parsed = args.schema.safeParse(r.data) as { success: boolean; data?: T; error?: unknown };
    if (!parsed.success) {
      return strict ? "retry-relaxed" : fail("parse", `Relaxed output failed local zod parse: ${String(parsed?.error ?? "unknown")}`);
    }
    return { ok: true, data: parsed.data as T, model: r.model || model, usage: r.usage, costUsd, strict };
  };

  let raisedCap = false;
  let strict = true;
  for (;;) {
    const out = await attempt(strict);
    if (out === "retry-relaxed") { strict = false; continue; }
    if (out === "retry-cap") {
      if (raisedCap) return fail("max_tokens", `Output hit max_output_tokens (${cap}).`);
      cap = Math.floor(cap * 1.5);
      raisedCap = true;
      continue; // same strictness, higher cap
    }
    return out;
  }
}
