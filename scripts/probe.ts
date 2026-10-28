import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { respond, uploadFile, transcribe, segment, deleteFile } from "../src/meta/client.ts";
const clip = process.argv[2];
const bytes = readFileSync(clip);
const t0 = Date.now();
const fileId = await uploadFile(bytes, "clip.mp4", "video/mp4", 3600);
console.log("upload", fileId, Date.now() - t0, "ms");
const wav = execFileSync("ffmpeg", ["-loglevel", "error", "-i", clip, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-f", "wav", "-"]);
const [tr, sp, sam] = await Promise.allSettled([
  transcribe(wav),
  respond<any>({
    instructions: "You watch short creator videos. Answer only from what is seen and heard.",
    content: [{ type: "input_text", text: "List what products are visible (with first and last second on screen), any on-screen text, and whether an ad disclosure is said or shown." }, { type: "input_video", file_id: fileId }],
    schema: { name: "probe", schema: { type: "object", additionalProperties: false, required: ["products", "on_screen_text", "disclosure"],
      properties: { products: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "first_s", "last_s"], properties: { name: { type: "string" }, first_s: { type: "number" }, last_s: { type: "number" } } } },
        on_screen_text: { type: "array", items: { type: "string" } }, disclosure: { type: "string" } } } },
    effort: "low",
  }),
  segment({ file_id: fileId }, "serum bottle"),
]);
console.log("TRANSCRIBE", tr.status === "fulfilled" ? JSON.stringify(tr.value).slice(0, 700) : String(tr.reason).slice(0, 400));
console.log("SPARK", sp.status === "fulfilled" ? JSON.stringify(sp.value.data) + " usage=" + JSON.stringify(sp.value.usage) : String(sp.reason).slice(0, 400));
if (sam.status === "fulfilled") { const b = sam.value.boxes; console.log("SAM frames", b.length, "first", JSON.stringify(b[0]), "last", JSON.stringify(b[b.length-1]), "usage", JSON.stringify(sam.value.usage)); } else console.log("SAM", String(sam.reason).slice(0, 400));
await deleteFile(fileId);
console.log("total", Date.now() - t0, "ms");
