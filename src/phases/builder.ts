import { readFileSync } from "node:fs";
import type { ProjectContext } from "../context/types.js";
import { buildBuilderPrompt } from "../context/prompts.js";
import { runAgent } from "../core/agent.js";
import type { EvidenceLedger } from "../core/evidence.js";
import { parseDeclaredFiles } from "../core/risk.js";
import { log } from "../util/logger.js";

export async function runBuilders(
  ctx: ProjectContext,
  specPath: string,
  model: string,
  ledger?: EvidenceLedger,
): Promise<void> {
  const specContent = readFileSync(specPath, "utf-8");

  const hasBackend = ctx.workspaces.some(
    (w) => w.type === "backend" || w.type === "shared",
  );
  const hasFrontend = ctx.workspaces.some((w) => w.type === "frontend");

  if (hasBackend && hasFrontend) {
    // Monorepo with both — run backend first, then frontend
    await runScopedBuilder(ctx, specContent, "backend", model, ledger);
    await runScopedBuilder(ctx, specContent, "frontend", model, ledger);
  } else {
    // Single scope — run everything
    await runScopedBuilder(ctx, specContent, "all", model, ledger);
  }
}

async function runScopedBuilder(
  ctx: ProjectContext,
  specContent: string,
  scope: "backend" | "frontend" | "all",
  model: string,
  ledger?: EvidenceLedger,
): Promise<void> {
  log(`Running ${scope} builder...`);

  const prompt = buildBuilderPrompt(ctx, specContent, scope);

  const scopedWorkspaces = ctx.workspaces.filter((w) => {
    if (scope === "all") return true;
    if (scope === "backend") return w.type === "backend" || w.type === "shared";
    return w.type === "frontend";
  });

  await runAgent(prompt, {
    cwd: ctx.root,
    model,
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "Agent",
    ],
    maxTurns: 200,
    systemPromptAppend:
      "You are a builder agent. Implement the spec precisely. Follow existing patterns. Write all tests. Do not commit — just write code.",
    guardrails: {
      role: "builder",
      root: ctx.root,
      writePaths: scopedWorkspaces.map((w) => w.path),
      declaredPaths: parseDeclaredFiles(specContent),
      onToolUse: ledger ? (entry) => ledger.recordToolUse(entry) : undefined,
    },
  });
}
