import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EvidenceRecord } from "../types.js";

/**
 * Cross-job handoffs — structured artifacts passed between phases and
 * between sprints, instead of each agent re-deriving (or never learning)
 * what the previous one did.
 *
 * Lives in .ralph/handoff/ (local, gitignored): builder reports feed the
 * auditor within a sprint; outcome summaries feed the next sprint's spec
 * writer so it can pivot around escalated, unmerged work.
 */

export function handoffDir(root: string): string {
  return join(root, ".ralph", "handoff");
}

/**
 * Where a builder writes its handoff report. Relative path (for agent
 * prompts) — scoped per builder so backend/frontend runs don't clobber
 * each other.
 */
export function buildReportRelPath(
  sprint: number,
  scope: "backend" | "frontend" | "all",
): string {
  return join(".ralph", "handoff", `sprint-${sprint}-build-report-${scope}.md`);
}

/** All builder reports for a sprint, concatenated. Null if none exist. */
export function readBuildReports(root: string, sprint: number): string | null {
  const dir = handoffDir(root);
  if (!existsSync(dir)) return null;
  const reports = readdirSync(dir)
    .filter(
      (f) =>
        f.startsWith(`sprint-${sprint}-build-report-`) && f.endsWith(".md"),
    )
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf-8").trim())
    .filter(Boolean);
  return reports.length > 0 ? reports.join("\n\n---\n\n") : null;
}

/**
 * Persist the sprint's final outcome as a handoff to future sprints.
 * The next spec writer reads these to know what actually landed — and,
 * critically, what escalated and must not be built upon.
 */
export function writeOutcomeSummary(root: string, record: EvidenceRecord): string {
  const dir = handoffDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const outcome = record.outcome || "unknown";
  const lines = [
    `## Sprint ${record.sprint} — ${outcome.toUpperCase()}`,
    `- Spec: \`${record.specName || "(none)"}\``,
    `- Branch: \`${record.branchName || "(none)"}\``,
  ];

  if (record.escalations.length > 0) {
    lines.push("- Escalation reasons:");
    lines.push(...record.escalations.map((e) => `  - ${e}`));
  }

  if (outcome === "escalated" || outcome === "blocked") {
    lines.push(
      "",
      `**This sprint's work is NOT merged** — it sits on \`${record.branchName || "its branch"}\` awaiting human review. Later sprints must not assume this work exists in the codebase.`,
    );
  }

  const path = join(dir, `sprint-${record.sprint}-outcome.md`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/**
 * Outcome summaries of recent sprints (oldest → newest), for the spec
 * writer's context. Null when no sprints have completed yet.
 */
export function readOutcomeSummaries(root: string, limit = 5): string | null {
  const dir = handoffDir(root);
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir)
    .map((f) => {
      const match = f.match(/^sprint-(\d+)-outcome\.md$/);
      return match ? { n: parseInt(match[1], 10), f } : null;
    })
    .filter((x): x is { n: number; f: string } => x !== null)
    .sort((a, b) => a.n - b.n)
    .slice(-limit);

  if (files.length === 0) return null;
  return files
    .map((x) => readFileSync(join(dir, x.f), "utf-8").trim())
    .join("\n\n");
}
