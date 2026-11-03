// Mirrored from the public hackathon repo (oocm-campaign-autopilot, src/meta/client.ts). Edit there first.
/**
 * Meta Model API client: the four calls the draft checker needs.
 *
 *  - respond():     Muse Spark through the Responses API, with JSON-schema output.
 *  - uploadFile():  the Files API, for videos too big to send inline.
 *  - transcribe():  Muse Voice Transcribe (WAV in, transcript + timed turns out).
 *  - segment():     SAM 3.1 on a video, parsed into per-frame boxes.
 *
 * Built during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).
 * Retries follow Meta's error guide: 429, 500 and 503 back off and retry;
 * 4xx never retry.
 */

const BASE = process.env.META_API_BASE ?? "https://api.meta.ai/v1";

export class MetaApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Meta API ${status}: ${body.slice(0, 300)}`);
    this.name = "MetaApiError";
    this.status = status;
    this.body = body;
  }
}

/** The response stopped before completing (usually max_output_tokens on a reasoning model). Carries a retry decision, not just text. */
export class MetaIncompleteError extends MetaApiError {
  readonly reason: string;
  constructor(reason: string, body: string) {
    super(200, `incomplete (${reason}): ${body.slice(0, 300)}`);
    this.name = "MetaIncompleteError";
    this.reason = reason;
  }
}

export interface MetaUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  video_frames_processed?: number;
  /** Web-search tool calls on the response, counted from web_search_call
   * output items (1-Nov probe: usage never carries web_search_calls, even
   * on calls that searched). */
  web_search_calls?: number;
}

function key(): string {
  const k = process.env.META_MODEL_API_KEY;
  if (!k) throw new Error("META_MODEL_API_KEY is not set");
  return k;
}

const RETRYABLE = new Set([429, 500, 503]);

async function call(path: string, init: RequestInit, timeoutMs = 180_000, outer?: AbortSignal): Promise<Response> {
  let wait = 800;
  for (let attempt = 0; ; attempt++) {
    // An aborted caller never starts another attempt — the audit already moved
    // on (Haiku fallback), so a retry would be pure spend.
    outer?.throwIfAborted();
    const ctl = new AbortController();
    const onOuter = () => ctl.abort();
    if (outer && !outer.aborted) outer.addEventListener("abort", onOuter, { once: true });
    else if (outer) ctl.abort();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${key()}`, ...(init.headers ?? {}) },
      });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
    if (res.ok) return res;
    const body = await res.text();
    if (!RETRYABLE.has(res.status) || attempt >= 3 || outer?.aborted) {
      if (outer?.aborted) outer.throwIfAborted();
      throw new MetaApiError(res.status, body);
    }
    const after = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(after) && after > 0 ? after * 1000 : wait + Math.random() * 400;
    await sleepOrAbort(delay, outer);
    wait *= 2;
  }
}

/** Backoff sleep that wakes early when the caller aborts — no sleeping into a retry nobody wants. */
function sleepOrAbort(ms: number, outer?: AbortSignal): Promise<void> {
  if (!outer || outer.aborted) {
    outer?.throwIfAborted();
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      outer.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject((outer as AbortSignal).reason ?? new DOMException("Aborted", "AbortError"));
    };
    outer.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Muse Spark (Responses API) ─────────────────────────────────────────────

export type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_video"; file_id?: string; video_url?: string; fps?: number }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: "auto" | "low" | "high" };

export interface RespondArgs {
  model?: string;
  instructions: string;
  content: InputPart[];
  /** JSON schema for the answer. Output is constrained to it. */
  schema: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  effort?: "minimal" | "low" | "medium" | "high";
  /** Caller abort (the 25s Spark race): aborts the fetch, never retried. */
  signal?: AbortSignal;
  /** Structured-output strictness. strict:false + local parse is the retry lane. */
  strict?: boolean;
  /** Responses API tools, e.g. [{type:"web_search"}] ($2.50/1k queries). */
  tools?: Array<Record<string, unknown>>;
  timeoutMs?: number;
}

export interface RespondResult<T> {
  data: T;
  model: string;
  usage: MetaUsage;
  responseId: string;
}

export async function respond<T>(a: RespondArgs): Promise<RespondResult<T>> {
  const res = await call("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: a.model ?? "muse-spark-1.3",
      instructions: a.instructions,
      input: [{ type: "message", role: "user", content: a.content }],
      max_output_tokens: a.maxOutputTokens ?? 8000,
      ...(a.effort ? { reasoning: { effort: a.effort } } : {}),
      ...(a.tools?.length ? { tools: a.tools } : {}),
      text: { format: { type: "json_schema", name: a.schema.name, schema: a.schema.schema, strict: a.strict ?? true } },
      store: false,
    }),
    // Second review 31-Oct: the caller's abort (the 25s Spark race) reaches
    // fetch — the timed-out call stops, it doesn't bill behind our back.
  }, a.timeoutMs ?? 180_000, a.signal);
  const json: any = await res.json();
  if (json.status === "incomplete") {
    const reason = String(json.incomplete_details?.reason ?? "unknown");
    throw new MetaIncompleteError(reason, JSON.stringify(json.incomplete_details ?? {}));
  }
  if (json.status && json.status !== "completed") {
    throw new MetaApiError(200, `response ${json.status}: ${JSON.stringify(json.incomplete_details ?? json.error ?? {})}`);
  }
  // Reasoning items can come first, and a search run writes progress notes
  // ("I'll search...") between its calls: the answer is the last message.
  const msg = (json.output ?? []).filter((o: any) => o.type === "message").at(-1);
  const refusal = msg?.content?.find((c: any) => c.type === "refusal");
  if (refusal) throw new MetaApiError(200, `refusal: ${refusal.refusal ?? ""}`);
  const text = (msg?.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
  if (!text) throw new MetaApiError(200, "empty output_text");
  // usage never reports searches (probed 1-Nov: two web_search_call items,
  // no web_search_calls in usage) — count the items so search spend is logged.
  const searchCalls = (json.output ?? []).filter((o: any) => o?.type === "web_search_call").length;
  return { data: JSON.parse(text) as T, model: json.model, usage: { ...(json.usage ?? {}), ...(searchCalls ? { web_search_calls: searchCalls } : {}) }, responseId: json.id };
}

// ── Files ──────────────────────────────────────────────────────────────────

export async function uploadFile(bytes: Uint8Array, filename: string, mime: string, ttlSeconds = 86_400): Promise<string> {
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("expires_after[anchor]", "created_at");
  form.append("expires_after[seconds]", String(Math.max(3600, ttlSeconds)));
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const res = await call("/files", { method: "POST", body: form }, 300_000);
  const json: any = await res.json();
  return json.id as string;
}

export async function deleteFile(id: string): Promise<void> {
  await call(`/files/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
}

// ── Muse Voice Transcribe ──────────────────────────────────────────────────

export interface Transcript {
  transcript: string;
  durationMs: number;
  turns: { startMs: number; endMs: number; text: string }[];
}

/** wav: mono 16-bit PCM, 16 or 24 kHz, at most 10 minutes. */
export async function transcribe(wav: Uint8Array, languages: string[] = ["English", "Hindi"], keywords: string[] = []): Promise<Transcript> {
  const form = new FormData();
  form.append(
    "request",
    new Blob([JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "ENDPOINTING", languageBias: languages, ...(keywords.length ? { keywords: keywords.slice(0, 50) } : {}) })], {
      type: "application/json",
    }),
  );
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  const res = await call("/asr/transcribe", { method: "POST", body: form, headers: { Accept: "application/json" } }, 300_000);
  const json: any = await res.json();
  return {
    transcript: String(json.transcript ?? ""),
    durationMs: Number(json.audioDurationMs ?? 0),
    turns: (json.turns ?? []).map((t: any) => ({ startMs: Number(t.startMs), endMs: Number(t.endMs), text: String(t.transcript ?? "") })),
  };
}

// ── SAM 3.1 ────────────────────────────────────────────────────────────────

export interface SamBox {
  frame: number;
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
  conf: number | null;
}

/** Parse SAM's text lanes: `<Nf>id<|box;x1=..;...|><|mask;...|>,id<|box;...|>...` per frame. */
export function parseSam(text: string): SamBox[] {
  const out: SamBox[] = [];
  for (const line of text.split("\n")) {
    const fm = line.match(/^<(\d+)f>/);
    if (!fm) continue;
    const frame = Number(fm[1]);
    const re = /(\d+)<\|box;([^|]*)\|>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const kv: Record<string, number> = {};
      for (const p of m[2].split(";")) {
        const [k, v] = p.split("=");
        if (k && v !== undefined) kv[k] = Number(v);
      }
      out.push({ frame, id: Number(m[1]), x1: kv.x1, y1: kv.y1, x2: kv.x2, y2: kv.y2, w: kv.w, h: kv.h, conf: Number.isFinite(kv.c) ? kv.c : null });
    }
  }
  return out;
}

/** One short noun phrase per call ("serum bottle"). Zero matches = []. */
export async function segment(video: { file_id?: string; video_url?: string }, phrase: string): Promise<{ boxes: SamBox[]; usage: MetaUsage }> {
  const res = await call(
    "/responses",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sam-3.1",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: phrase }, { type: "input_video", ...video }] }],
        metadata: { mask_encoding: "one_bit", include_confidence: "true" },
        store: false,
      }),
    },
    300_000,
  );
  const json: any = await res.json();
  const msg = (json.output ?? []).find((o: any) => o.type === "message");
  const text = (msg?.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
  return { boxes: parseSam(text), usage: json.usage ?? {} };
}

export const isMetaOutage = (e: unknown): boolean => {
  if (!(e instanceof MetaApiError)) return false;
  const re = /credit|billing|insufficient|quota/i;
  const msg = (e as any).message ?? "";
  const body = (e as any).body ?? "";
  if (re.test(msg) || re.test(body)) return true;
  const status = (e as any).status as number;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  if (typeof status === "number" && status >= 500 && status <= 599) return true;
  return false;
};
