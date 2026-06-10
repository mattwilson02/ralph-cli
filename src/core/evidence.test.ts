import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EvidenceLedger } from "./evidence.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ralph-evidence-"));
  execSync("git init -q && git commit --allow-empty -q -m init", {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("EvidenceLedger", () => {
  it("persists to .ralph/evidence/sprint-N.json", () => {
    const ledger = new EvidenceLedger(root, 3);
    ledger.setGoal("test goal");

    const path = join(root, ".ralph", "evidence", "sprint-3.json");
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf-8"));
    expect(saved.sprint).toBe(3);
    expect(saved.goal).toBe("test goal");
  });

  it("reloads existing evidence for the same sprint (crash recovery)", () => {
    const first = new EvidenceLedger(root, 1);
    first.setGoal("original goal");
    first.escalate("something failed");

    const resumed = new EvidenceLedger(root, 1);
    expect(resumed.data.goal).toBe("original goal");
    expect(resumed.hasEscalations).toBe(true);
    expect(resumed.escalations).toEqual(["something failed"]);
  });

  it("pins check results to a commit", () => {
    const ledger = new EvidenceLedger(root, 1);
    ledger.recordCheck(0, "Unit Tests", "npm test", false, "boom");

    const check = ledger.data.checks[0];
    expect(check.commit).not.toBe("unknown");
    expect(check.commit.length).toBeGreaterThanOrEqual(7);
    expect(check.output).toBe("boom");
  });

  it("does not keep output for passing checks", () => {
    const ledger = new EvidenceLedger(root, 1);
    ledger.recordCheck(0, "Build", "npm run build", true, "lots of output");
    expect(ledger.data.checks[0].output).toBeUndefined();
  });

  it("renders Goal / Plan / Evidence / Outcome sections", () => {
    const ledger = new EvidenceLedger(root, 1);
    ledger.setGoal("ship the widget");
    ledger.setSpec("sprint-1-widget", join(root, "docs/sprints/sprint-1-widget.md"));
    ledger.recordCheck(0, "Unit Tests", "npm test", true);
    ledger.setOutcome("shipped");

    const md = ledger.renderMarkdown();
    expect(md).toContain("## Goal");
    expect(md).toContain("ship the widget");
    expect(md).toContain("## Plan");
    expect(md).toContain("docs/sprints/sprint-1-widget.md");
    expect(md).toContain("## Evidence");
    expect(md).toContain("Unit Tests");
    expect(md).toContain("## Outcome");
    expect(md).toContain("**shipped**");
    expect(md).not.toContain("WARNING");
  });

  it("leads with a warning and escalation reasons when escalated", () => {
    const ledger = new EvidenceLedger(root, 1);
    ledger.setGoal("goal");
    ledger.recordCheck(0, "Unit Tests", "npm test", false, "assertion failed");
    ledger.escalate("Full verification failed after 3 fix attempts: Unit Tests");
    ledger.setOutcome("escalated");

    const md = ledger.renderMarkdown();
    expect(md.indexOf("WARNING")).toBeLessThan(md.indexOf("## Goal"));
    expect(md).toContain("do not merge as-is");
    expect(md).toContain("Full verification failed after 3 fix attempts");
    expect(md).toContain("assertion failed");
    expect(md).toContain("Suggested next steps");
  });

  it("records fix attempts with truncated summaries", () => {
    const ledger = new EvidenceLedger(root, 1);
    ledger.recordFixAttempt(0, ["Lint"], "x".repeat(5000));
    expect(ledger.data.fixAttempts[0].summary.length).toBe(1000);
    expect(ledger.data.fixAttempts[0].failedChecks).toEqual(["Lint"]);
  });
});
