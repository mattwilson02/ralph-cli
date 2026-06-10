import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runSafe } from "../util/exec.js";
import type {
  EvidenceRecord,
  SprintOutcome,
  CheckAttemptRecord,
} from "../types.js";

const MAX_OUTPUT_CHARS = 2000;
const MAX_SUMMARY_CHARS = 1000;

/**
 * Per-sprint evidence ledger — the audit trail for an agent contribution.
 *
 * Accumulates check results, fix attempts, audit findings, and escalations
 * during a sprint, persists them to .ralph/evidence/sprint-N.json (so crash
 * recovery keeps the trail), and renders the markdown that becomes the PR
 * body: Goal / Plan / Evidence / Outcome.
 *
 * Every check result is pinned to the commit it ran against so evidence is
 * reconstructable after the fact.
 */
export class EvidenceLedger {
  private readonly root: string;
  private readonly record: EvidenceRecord;

  constructor(root: string, sprint: number) {
    this.root = root;
    const existing = loadEvidence(root, sprint);
    this.record =
      existing ??
      ({
        sprint,
        checks: [],
        fixAttempts: [],
        escalations: [],
        startedAt: new Date().toISOString(),
      } satisfies EvidenceRecord);
  }

  setGoal(goal: string): void {
    this.record.goal = goal;
    this.save();
  }

  setSpec(name: string, path: string): void {
    this.record.specName = name;
    this.record.specPath = relative(this.root, path);
    this.save();
  }

  setBranch(branch: string): void {
    this.record.branchName = branch;
    this.save();
  }

  recordCheck(
    attempt: number,
    check: string,
    cmd: string,
    passed: boolean,
    output?: string,
  ): void {
    const entry: CheckAttemptRecord = {
      check,
      cmd,
      passed,
      attempt,
      commit: currentCommit(this.root),
    };
    if (!passed && output) {
      entry.output = output.slice(-MAX_OUTPUT_CHARS);
    }
    this.record.checks.push(entry);
    this.save();
  }

  recordFixAttempt(
    attempt: number,
    failedChecks: string[],
    summary: string,
  ): void {
    this.record.fixAttempts.push({
      attempt,
      failedChecks,
      summary: summary.slice(0, MAX_SUMMARY_CHARS),
    });
    this.save();
  }

  recordAudit(audit: {
    completed: string[];
    missing: string[];
    issues: string[];
  }): void {
    this.record.audit = audit;
    this.save();
  }

  /** Record a reason this sprint cannot ship as a normal PR. */
  escalate(reason: string): void {
    this.record.escalations.push(reason);
    this.save();
  }

  get hasEscalations(): boolean {
    return this.record.escalations.length > 0;
  }

  get escalations(): string[] {
    return [...this.record.escalations];
  }

  setOutcome(outcome: SprintOutcome): void {
    this.record.outcome = outcome;
    this.record.finishedAt = new Date().toISOString();
    this.save();
  }

  get data(): EvidenceRecord {
    return this.record;
  }

  save(): void {
    const dir = join(this.root, ".ralph", "evidence");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `sprint-${this.record.sprint}.json`),
      JSON.stringify(this.record, null, 2),
    );
  }

  /**
   * Render the audit-trail PR body: Goal / Plan / Evidence / Outcome.
   * When the sprint escalated, the failure report leads the body so
   * reviewers cannot miss it.
   */
  renderMarkdown(): string {
    const r = this.record;
    const sections: string[] = [];

    if (r.escalations.length > 0) {
      sections.push(
        `> [!WARNING]\n> **This sprint escalated to human review — do not merge as-is.**\n${r.escalations.map((e) => `> - ${e}`).join("\n")}`,
      );
    }

    sections.push(`## Goal\n${r.goal || "(no goal recorded)"}`);

    sections.push(
      `## Plan\nSprint spec: \`${r.specPath || "(none)"}\` (committed on this branch)`,
    );

    sections.push(`## Evidence\n${this.renderEvidenceSection()}`);

    const outcomeLines = [`**${r.outcome || "unknown"}**`];
    if (r.escalations.length > 0) {
      outcomeLines.push("", "Escalation reasons:");
      outcomeLines.push(...r.escalations.map((e) => `- ${e}`));
      outcomeLines.push("", this.renderNextSteps());
    }
    sections.push(`## Outcome\n${outcomeLines.join("\n")}`);

    return sections.join("\n\n");
  }

  private renderEvidenceSection(): string {
    const r = this.record;
    const parts: string[] = [];

    if (r.checks.length > 0) {
      // Show the latest result per check, plus how many attempts it took
      const latest = new Map<string, CheckAttemptRecord>();
      const attempts = new Map<string, number>();
      for (const c of r.checks) {
        latest.set(c.check, c);
        attempts.set(c.check, (attempts.get(c.check) || 0) + 1);
      }
      const rows = [...latest.values()].map(
        (c) =>
          `| ${c.check} | ${c.passed ? "✅ pass" : "❌ fail"} | ${attempts.get(c.check)} | \`${c.commit}\` |`,
      );
      parts.push(
        ["| Check | Result | Runs | Commit |", "|---|---|---|---|", ...rows].join(
          "\n",
        ),
      );

      const failing = [...latest.values()].filter((c) => !c.passed);
      for (const f of failing) {
        if (f.output) {
          parts.push(
            `<details><summary>Failure output: ${f.check}</summary>\n\n\`\`\`\n${f.output}\n\`\`\`\n\n</details>`,
          );
        }
      }
    } else {
      parts.push("No verification checks were run.");
    }

    if (r.fixAttempts.length > 0) {
      const lines = r.fixAttempts.map(
        (f) =>
          `- Attempt ${f.attempt + 1} (${f.failedChecks.join(", ")}): ${f.summary || "(no summary)"}`,
      );
      parts.push(`**Fix attempts:**\n${lines.join("\n")}`);
    }

    if (r.audit) {
      parts.push(
        `**Spec audit:** ${r.audit.completed.length} completed, ${r.audit.missing.length} missing, ${r.audit.issues.length} issues` +
          (r.audit.missing.length > 0
            ? `\nMissing: ${r.audit.missing.map((m) => `\`${m}\``).join(", ")}`
            : "") +
          (r.audit.issues.length > 0
            ? `\nIssues: ${r.audit.issues.map((i) => `\`${i}\``).join(", ")}`
            : ""),
      );
    }

    parts.push(`Full evidence: \`.ralph/evidence/sprint-${r.sprint}.json\` (local, not committed)`);

    return parts.join("\n\n");
  }

  private renderNextSteps(): string {
    return [
      "Suggested next steps:",
      "- Review the failure output above and the fix attempts that were made",
      "- Fix manually, or re-run `ralph run` on this branch after addressing the cause",
      `- To roll back: delete this branch (\`git branch -D ${this.record.branchName || "<branch>"}\`)`,
    ].join("\n");
  }
}

function loadEvidence(root: string, sprint: number): EvidenceRecord | null {
  const path = join(root, ".ralph", "evidence", `sprint-${sprint}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as EvidenceRecord;
  } catch {
    return null;
  }
}

function currentCommit(root: string): string {
  const { ok, output } = runSafe("git rev-parse --short HEAD", root);
  return ok ? output : "unknown";
}
