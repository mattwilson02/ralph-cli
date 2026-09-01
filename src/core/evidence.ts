import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { runSafe } from "../util/exec.js";
import { log } from "../util/logger.js";
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

    // `finishedAt` marks a COMPLETED pass. Re-running the same sprint starts
    // a new one, and the previous verdict must not be inherited: escalations
    // are conclusions about a finished attempt, so carrying them forward
    // means a sprint that escalated once can never ship again however clean
    // the re-run — the engine keeps branching the next sprint off older work
    // and the good result is stranded. Archive the old pass (it is an audit
    // trail; it is not discarded) and begin a fresh record.
    //
    // A record WITHOUT `finishedAt` is a crash mid-pass. That is exactly what
    // the on-disk ledger exists for, so it is resumed untouched.
    if (existing?.finishedAt) {
      const archived = archiveEvidence(root, sprint, existing);
      this.record = freshRecord(sprint, archived + 1);
    } else {
      this.record = existing ?? freshRecord(sprint, 1);
    }
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

  recordRisk(risk: { level: string; reasons: string[] }): void {
    this.record.risk = risk;
    this.save();
  }

  recordScope(scope: {
    declared: string[];
    changed: string[];
    outOfScope: string[];
  }): void {
    this.record.scope = scope;
    this.save();
  }

  /**
   * Append a tool-use audit entry to the sprint's .jsonl side file —
   * every agent Write/Edit/Bash call (and every guardrail denial) is
   * reconstructable without bloating the main evidence record.
   */
  recordToolUse(entry: {
    role: string;
    tool: string;
    detail: string;
    denied: boolean;
    reason?: string;
    at: string;
  }): void {
    // The effort meter. Tool calls are the sprint's unit of work: unlike
    // wall-clock minutes they do not move when the API is slow, and they
    // correlate with what the sprint actually costs.
    //
    // Persisted on every call, not just at phase boundaries: the budget is
    // what stops a runaway sprint, so a crash-resumed one that forgot how
    // much it had already spent would start again with a full allowance.
    this.record.toolCalls = (this.record.toolCalls ?? 0) + 1;
    try {
      this.save();
    } catch {
      // Never let audit bookkeeping break the pipeline.
    }

    try {
      const dir = join(this.root, ".ralph", "evidence");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, `sprint-${this.record.sprint}-tools.jsonl`),
        JSON.stringify(entry) + "\n",
      );
    } catch {
      // Audit logging must never break the pipeline
    }
  }

  /**
   * Mark that the sprint advanced. Resets the stall window, so a slow sprint
   * that is genuinely progressing is never killed for being slow — only a
   * sprint that has stopped advancing is.
   */
  noteProgress(reason: string): void {
    this.record.lastProgressAtCall = this.record.toolCalls ?? 0;
    log(`  progress: ${reason} (at ${this.record.lastProgressAtCall} tool calls)`);
    this.save();
  }

  /** Agent tool calls consumed so far — the effort spent. */
  get toolCallCount(): number {
    return this.record.toolCalls ?? 0;
  }

  /** Tool calls since the last progress signal — the stall measure. */
  get callsSinceProgress(): number {
    return (this.record.toolCalls ?? 0) - (this.record.lastProgressAtCall ?? 0);
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

    const planLines = [
      `Sprint spec: \`${r.specPath || "(none)"}\` (committed on this branch)`,
    ];
    if (r.risk) {
      planLines.push(
        "",
        `**Risk assessment:** ${r.risk.level}`,
        ...r.risk.reasons.map((reason) => `- ${reason}`),
      );
    }
    sections.push(`## Plan\n${planLines.join("\n")}`);

    sections.push(`## Evidence\n${this.renderEvidenceSection()}`);

    if (r.risk && r.risk.level !== "low") {
      sections.push(
        `## Risks & Rollback\nThis change was assessed **${r.risk.level}** risk — review the affected areas carefully.\nRollback: revert the merge commit, or delete branch \`${r.branchName || "<branch>"}\` before merging.`,
      );
    }

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

    if (r.scope) {
      parts.push(
        r.scope.outOfScope.length === 0
          ? `**Scope check:** all ${r.scope.changed.length} changed file(s) within the spec's declared scope`
          : `**Scope check:** ⚠️ ${r.scope.outOfScope.length} file(s) changed outside declared scope:\n${r.scope.outOfScope.map((f) => `- \`${f}\``).join("\n")}`,
      );
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

    if ((r.pass ?? 1) > 1) {
      parts.push(
        `**Pass ${r.pass} of this sprint.** Earlier passes are archived at \`.ralph/evidence/sprint-${r.sprint}.pass-*.json\`; the evidence above is this pass only.`,
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

function freshRecord(sprint: number, pass: number): EvidenceRecord {
  return {
    sprint,
    pass,
    checks: [],
    fixAttempts: [],
    escalations: [],
    toolCalls: 0,
    lastProgressAtCall: 0,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Move a completed pass aside as `sprint-N.pass-K.json` and return K.
 * Nothing is deleted — the point of the ledger is that the trail survives.
 */
function archiveEvidence(
  root: string,
  sprint: number,
  record: EvidenceRecord,
): number {
  const dir = join(root, ".ralph", "evidence");
  let pass = record.pass ?? 1;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    while (existsSync(join(dir, `sprint-${sprint}.pass-${pass}.json`))) pass++;
    writeFileSync(
      join(dir, `sprint-${sprint}.pass-${pass}.json`),
      JSON.stringify({ ...record, pass }, null, 2),
    );
  } catch {
    // Archiving must never break the pipeline
  }
  return pass;
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
