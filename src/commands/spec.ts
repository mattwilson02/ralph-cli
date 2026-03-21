import { resolve } from "node:path";
import { scanProject } from "../context/scanner.js";
import { buildDraftSpecPrompt } from "../context/prompts.js";
import { runAgent } from "../core/agent.js";
import { log } from "../util/logger.js";

export async function spec(dir?: string): Promise<void> {

  const root = resolve(dir || ".");
  const ctx = scanProject(root);

  if (ctx.productSpec) {
    log(`Product spec already exists at ${ctx.productSpec}`);
    log("Delete it first if you want to regenerate.");
    return;
  }

  log("Analyzing codebase to generate draft product spec...\n");

  const prompt = buildDraftSpecPrompt(ctx);

  await runAgent(prompt, {
    cwd: root,
    model: "claude-opus-4-6",
    allowedTools: ["Read", "Glob", "Grep"],
    maxTurns: 50,
    systemPromptAppend:
      "You are a product analyst. Read the entire codebase and generate a comprehensive but concise product spec. Be specific about what exists and what should be built.",
  });

  log("\nDraft spec written to PRODUCT_SPEC.md");
  log("Review and edit it, then run `ralph init --spec PRODUCT_SPEC.md`");
}
