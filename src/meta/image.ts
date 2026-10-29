/**
 * Storyboard frames on Muse Image (muse-image-1.0, ~$0.01/frame).
 *
 * Two doors, verified live against the Meta Model API on 29-Oct-2026:
 *   - storyboardEdit():   POST /v1/images/edits (multipart: image + prompt +
 *                          model) when the brand's site gave us the product's
 *                          own photo — the frame keeps the product's look.
 *   - storyboardGenerate(): POST /v1/images/generations (JSON) when there is
 *                          no product photo (service/event/app brands) — the
 *                          frame is drawn from the option card's concept text.
 *
 * Both answer {created, data:[{b64_json}]}. Both return {ok,...} and never
 * throw for a model problem, so a storyboard failure can never fail the
 * builder run: the card ships without its frame and the failure is logged.
 *
 * Built during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).
 */

const BASE = process.env.META_API_BASE ?? "https://api.meta.ai/v1";
const MODEL = "muse-image-1.0";

export interface Storyboard {
  ok: true;
  /** Raw image bytes (PNG/WEBP as returned). The caller uploads to storage. */
  bytes: Uint8Array;
  prompt: string;
  model: string;
  door: "edit" | "generate";
}

export interface StoryboardFailure {
  ok: false;
  door: "edit" | "generate";
  message: string;
}

const key = (): string => {
  const k = process.env.META_MODEL_API_KEY;
  if (!k) throw new Error("META_MODEL_API_KEY is not set");
  return k;
};

async function readImage(res: Response, door: "edit" | "generate", prompt: string): Promise<Storyboard | StoryboardFailure> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, door, message: `Meta images ${door} ${res.status}: ${body.slice(0, 300)}` };
  }
  const json: any = await res.json().catch(() => null);
  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64.length) {
    return { ok: false, door, message: `Meta images ${door}: no b64_json in response.` };
  }
  return { ok: true, bytes: Uint8Array.from(Buffer.from(b64, "base64")), prompt, model: MODEL, door };
}

/** Reference product photo in, storyboard frame out. image.mime like image/png. */
export async function storyboardEdit(
  image: { bytes: Uint8Array; mime: string; filename?: string },
  prompt: string,
  timeoutMs = 90_000,
): Promise<Storyboard | StoryboardFailure> {
  if (!process.env.META_MODEL_API_KEY) return { ok: false, door: "edit", message: "META_MODEL_API_KEY is not set." };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append("model", MODEL);
    form.append("prompt", prompt);
    form.append("image", new Blob([image.bytes], { type: image.mime }), image.filename ?? "reference.png");
    const res = await fetch(`${BASE}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key()}` },
      body: form,
      signal: ctl.signal,
    });
    return await readImage(res, "edit", prompt);
  } catch (e: any) {
    return { ok: false, door: "edit", message: `Meta images edit failed: ${String(e?.message ?? e).slice(0, 300)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** No product photo: draw the frame from the option card's concept text. */
export async function storyboardGenerate(
  prompt: string,
  opts: { timeoutMs?: number; size?: string } = {},
): Promise<Storyboard | StoryboardFailure> {
  if (!process.env.META_MODEL_API_KEY) return { ok: false, door: "generate", message: "META_MODEL_API_KEY is not set." };
  // Vertical phone frame; square only as fallback (verified 29-Oct: 1024x1536 accepted).
  const size = opts.size ?? "1024x1536";
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, size }),
      signal: ctl.signal,
    });
    return await readImage(res, "generate", prompt);
  } catch (e: any) {
    return { ok: false, door: "generate", message: `Meta images generate failed: ${String(e?.message ?? e).slice(0, 300)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Concept prompt for a frame, from an option card's own words. Product name
 * goes in so the frame is about the right thing; India style cues only when
 * the brief says India; never real faces or celebrities (no likeness to copy).
 */
export const storyboardPromptFor = (o: { name?: string; idea?: string; brief?: string; productName?: string; india?: boolean }): string =>
  [
    `Vertical phone-shot storyboard frame for an Instagram reel ad, photorealistic, bright, natural light, filmed-on-a-phone look.`,
    o.productName ? `Featuring: ${o.productName}.` : "",
    o.name ? `Campaign: ${o.name}.` : "",
    o.idea ? `Idea: ${o.idea}` : "",
    o.brief ? `Opening: ${o.brief.split(".")[0]}.` : "",
    o.india ? `Indian creator's home, everyday Indian setting.` : "",
    `No text overlays, no watermark, no real or celebrity faces.`,
  ].filter(Boolean).join(" ");
