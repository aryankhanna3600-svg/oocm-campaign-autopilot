import { readFileSync } from "node:fs";
import { uploadFile, segment, deleteFile } from "../src/meta/client.ts";
const id = await uploadFile(readFileSync(process.argv[2]), "clip.mp4", "video/mp4", 3600);
for (const p of process.argv.slice(3)) { const r = await segment({ file_id: id }, p); const fr = [...new Set(r.boxes.map(b => b.frame))]; console.log(JSON.stringify(p), "frames", fr.length, "range", fr[0], fr[fr.length-1], JSON.stringify(r.boxes[0] ?? null)); }
await deleteFile(id);
