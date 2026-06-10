import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectContext } from "../context/types.js";
import { runAgent } from "../core/agent.js";
import { ask } from "../util/prompt.js";
import { log } from "../util/logger.js";

/**
 * Greenfield human-in-the-loop: Ralph never invents an architecture on
 * his own. A short terminal interview captures the codeowner's intent,
 * an agent drafts ARCHITECTURE.md (status: draft), and Ralph exits for
 * human review. Only an approved architecture unlocks scaffolding.
 */

export interface ArchitectureInfo {
  path: string;
  status: "draft" | "approved";
  content: string;
}

export function loadArchitecture(root: string): ArchitectureInfo | null {
  const path = join(root, "ARCHITECTURE.md");
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  return { path, status: parseStatus(content), content };
}

/**
 * A file without frontmatter status is treated as approved — a
 * human-authored ARCHITECTURE.md carries its own authority. Only
 * Ralph-drafted files are gated behind `status: draft`.
 */
function parseStatus(content: string): "draft" | "approved" {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return "approved";
  const status = fm[1].match(/status:\s*(draft|approved)/)?.[1];
  return status === "draft" ? "draft" : "approved";
}

/** Flip a draft ARCHITECTURE.md to approved. Returns false if there was nothing to approve. */
export function approveArchitecture(root: string): boolean {
  const arch = loadArchitecture(root);
  if (!arch || arch.status !== "draft") return false;
  writeFileSync(
    arch.path,
    arch.content.replace(/(^---\s*\n[\s\S]*?)status:\s*draft/, "$1status: approved"),
  );
  return true;
}

const INTERVIEW_QUESTIONS: { key: string; question: string }[] = [
  { key: "Purpose", question: "What is this project? (one or two sentences) " },
  { key: "Users", question: "Who uses it, and how? " },
  {
    key: "Stack preferences",
    question: "Stack preferences — language, framework, database? (Enter = Ralph recommends) ",
  },
  { key: "Core data", question: "What are the core entities/things it stores? " },
  { key: "Hosting", question: "Where will it run/deploy? " },
  {
    key: "Testing",
    question: "Testing expectations — unit only, integration, e2e? ",
  },
];

/**
 * Conduct the interview and have an agent draft ARCHITECTURE.md
 * (status: draft). Caller exits afterwards so the human can review.
 */
export async function runArchitectInterview(
  ctx: ProjectContext,
  model: string,
): Promise<string> {
  log("Greenfield project — Ralph interviews you before designing anything.");
  log("Answer briefly; Enter skips a question.\n");

  const answers: string[] = [];
  for (const q of INTERVIEW_QUESTIONS) {
    const answer = await ask(`  ${q.question}`);
    answers.push(`**${q.key}:** ${answer || "(no preference — use your judgment)"}`);
  }

  log("\nDrafting ARCHITECTURE.md from the interview...");

  const hasProductSpec = ctx.productSpec && existsSync(ctx.productSpec);
  const archPath = join(ctx.root, "ARCHITECTURE.md");

  await runAgent(buildArchitectPrompt(ctx, answers, archPath, !hasProductSpec), {
    cwd: ctx.root,
    model,
    allowedTools: ["Read", "Write", "Glob", "Grep"],
    maxTurns: 30,
    systemPromptAppend:
      "You are an architecture agent designing a new project from a codeowner interview. Be pragmatic and concise — design for what was asked, not for hypothetical scale. Never write implementation code.",
    guardrails: {
      role: "spec-writer",
      root: ctx.root,
      writePaths: ["ARCHITECTURE.md", "PRODUCT_SPEC.md"],
    },
  });

  if (!existsSync(archPath)) {
    throw new Error("Architect agent did not write ARCHITECTURE.md");
  }

  // The draft gate is enforced by frontmatter — make sure it's there even
  // if the agent forgot.
  const content = readFileSync(archPath, "utf-8");
  if (!content.match(/^---\s*\n[\s\S]*?status:/)) {
    writeFileSync(archPath, `---\nstatus: draft\n---\n\n${content}`);
  }

  return archPath;
}

function buildArchitectPrompt(
  ctx: ProjectContext,
  answers: string[],
  archPath: string,
  draftProductSpec: boolean,
): string {
  return `You are designing the architecture for a brand-new project: ${ctx.name}.

## Codeowner Interview
${answers.join("\n")}

## Instructions

1. Design a pragmatic, buildable architecture that serves the interview answers. Where the codeowner gave no preference, choose mainstream, well-supported technology and say why.
2. Write ${archPath} starting with EXACTLY this frontmatter:

---
status: draft
---

3. Include these sections:
   - **Purpose** — what the project is, restated from the interview
   - **Stack** — language, framework, database, key libraries, each with one line of rationale
   - **Directory Structure** — the intended layout, as a tree
   - **Data Model** — core entities and their relationships
   - **Patterns & Conventions** — error handling, naming, module boundaries future sprints must follow
   - **Testing Strategy** — what gets tested and how, matching the codeowner's expectations
   - **Out of Scope** — what this architecture deliberately does not cover

4. Keep it under ~150 lines. This document governs every future sprint — every line must be a real decision, not filler.
${draftProductSpec ? `\n5. No product spec exists yet — also write a draft PRODUCT_SPEC.md (vision, initial features, out of scope) consistent with the architecture.\n` : ""}
This is a DRAFT for human review. The codeowner will edit and approve it before any code is built.`;
}
