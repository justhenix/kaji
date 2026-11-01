import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
export const MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
const root = resolve(import.meta.dir, "..");
export async function ensureModel() {
  await mkdir(resolve(root, "assets"), { recursive: true });
  const path = resolve(root, "assets/face_landmarker.task");
  let bytes: Uint8Array;
  if (await Bun.file(path).exists()) bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  else {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== MODEL_SHA256) throw new Error("Face model SHA256 mismatch");
  await Bun.write(path, bytes);
  return path;
}
if (import.meta.main) console.log(await ensureModel());
