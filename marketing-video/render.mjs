import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(root, "src/index.tsx");
const out = path.join(root, "out");
const compositions = [
  ["MusterLaunch16x9", "muster-launch-16x9.mp4"],
  ["MusterLaunch9x16", "muster-launch-9x16.mp4"],
  ["MusterLaunch1x1", "muster-launch-1x1.mp4"],
];

const serveUrl = await bundle({ entryPoint: entry, webpackOverride: (config) => config });
for (const [id, filename] of compositions) {
  const composition = await selectComposition({ serveUrl, id, inputProps: { aspect: id.includes("9x16") ? "portrait" : id.includes("1x1") ? "square" : "landscape" } });
  const outputLocation = path.join(out, filename);
  console.log(`Rendering ${id} -> ${outputLocation}`);
  await renderMedia({ composition, serveUrl, codec: "h264", outputLocation, inputProps: composition.defaultProps, audioCodec: "aac", crf: 18, pixelFormat: "yuv420p" });
}
console.log("Rendered all Muster launch film compositions.");
