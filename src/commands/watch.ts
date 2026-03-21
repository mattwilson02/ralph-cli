import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { TUIRenderer } from "../tui/renderer.js";

export async function watchCommand(dir?: string): Promise<void> {
  const root = resolve(dir || ".");

  const hasLog = existsSync(resolve(root, "ralph.log"));
  const hasState = existsSync(resolve(root, ".ralph-state.json"));

  if (!hasLog && !hasState) {
    console.log("No Ralph activity found in this directory.");
    console.log("Start a sprint first:  ralph run --single");
    console.log("Then run:              ralph watch");
    process.exit(1);
  }

  const renderer = new TUIRenderer(root);
  await renderer.start();
}
