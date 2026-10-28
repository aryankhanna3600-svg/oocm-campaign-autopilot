/**
 * Muse Spark Open (Meta's open-weight model) through any OpenAI-compatible
 * host: Fireworks, Baseten, Together, Groq, or our own vLLM server.
 *
 * Hosted providers document image input but (except Baseten) not video, so a
 * reel goes in as frames plus what is said: ffmpeg samples one frame a second
 * (up to 16, 512 px), and the transcript comes from Muse Voice Transcribe.
 * Output is JSON mode, validated here against the same field list the
 * Muse Spark API path uses, so the two lanes can be compared field by field.
 *
 *   OPEN_BASE_URL  e.g. https://api.fireworks.ai/inference/v1
 *   OPEN_API_KEY
 *   OPEN_MODEL     e.g. accounts/fireworks/models/muse-spark-open
 *
 * Built during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface OpenConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function openConfigFromEnv(): OpenConfig {
  const baseUrl = process.env.OPEN_BASE_URL;
  const apiKey = process.env.OPEN_API_KEY;
  const model = process.env.OPEN_MODEL;
  if (!baseUrl || !apiKey || !model) throw new Error("Set OPEN_BASE_URL, OPEN_API_KEY and OPEN_MODEL");
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
}

/** One frame a second, at most `max`, 512 px wide, as JPEG data URLs in time order. */
export async function sampleFrames(videoPath: string, o: { ffmpeg?: string; max?: number } = {}): Promise<{ t: number; dataUrl: string }[]> {
  const dir = await mkdtemp(join(tmpdir(), "frames-"));
  try {
    await run(o.ffmpeg ?? "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-i", videoPath, "-vf", "fps=1,scale=512:-2", "-q:v", "5", join(dir, "f%03d.jpg")], { timeout: 120_000, killSignal: "SIGKILL" });
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
    const max = o.max ?? 16;
    const step = Math.max(1, Math.ceil(files.length / max));
    const picked = files.filter((_, i) => i % step === 0).slice(0, max);
    return Promise.all(picked.map(async (f) => ({ t: Number(f.slice(1, 4)) - 1, dataUrl: `data:image/jpeg;base64,${(await readFile(join(dir, f))).toString("base64")}` })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface OpenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Ask the open model for JSON. `required` lists the keys the answer must have;
 * a missing key is an error (JSON mode guarantees JSON, not the shape).
 */
export async function openJson<T>(cfg: OpenConfig, a: { instructions: string; text: string; frames?: { t: number; dataUrl: string }[]; required: string[]; maxTokens?: number }): Promise<{ data: T; usage: OpenUsage; ms: number }> {
  const t0 = Date.now();
  const content: any[] = [{ type: "text", text: a.text }];
  for (const f of a.frames ?? []) {
    content.push({ type: "text", text: `Frame at ${f.t}s:` });
    content.push({ type: "image_url", image_url: { url: f.dataUrl } });
  }
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: `${a.instructions}\nAnswer with one JSON object only, with exactly these keys: ${a.required.join(", ")}.` },
          { role: "user", content },
        ],
        max_tokens: a.maxTokens ?? 4096,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const body = await res.text();
    if (!res.ok) {
      lastErr = `${res.status}: ${body.slice(0, 300)}`;
      if ([429, 500, 502, 503].includes(res.status)) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error(`open model ${lastErr}`);
    }
    const j = JSON.parse(body);
    const text: string = j.choices?.[0]?.message?.content ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
      const data = JSON.parse(json);
      const missing = a.required.filter((k) => !(k in data));
      if (missing.length) throw new Error(`missing keys: ${missing.join(", ")}`);
      return { data: data as T, usage: j.usage ?? {}, ms: Date.now() - t0 };
    } catch (e: any) {
      lastErr = `bad JSON (${e.message}): ${text.slice(0, 200)}`;
    }
  }
  throw new Error(`open model failed after 3 tries: ${lastErr}`);
}
