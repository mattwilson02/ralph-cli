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

describe("re-running a sprint", () => {
  it("does not inherit a completed pass's escalations", () => {
    const first = new EvidenceLedger(root, 9);
    first.escalate("Spec audit output could not be parsed");
    first.escalate("Sprint timed out after 48.7 min");
    first.setOutcome("escalated");

    // Same sprint run again — e.g. after the cause was fixed
    const second = new EvidenceLedger(root, 9);

    expect(second.hasEscalations).toBe(false);
    expect(second.escalations).toEqual([]);
    expect(second.data.outcome).toBeUndefined();
    expect(second.data.pass).toBe(2);
  });

  it("archives the completed pass rather than discarding it", () => {
    const first = new EvidenceLedger(root, 9);
    first.escalate("timed out");
    first.setOutcome("escalated");

    new EvidenceLedger(root, 9);

    const archived = join(root, ".ralph", "evidence", "sprint-9.pass-1.json");
    expect(existsSync(archived)).toBe(true);
    const record = JSON.parse(readFileSync(archived, "utf-8"));
    expect(record.escalations).toEqual(["timed out"]);
    expect(record.outcome).toBe("escalated");
  });

  it("keeps numbering passes upward across repeated re-runs", () => {
    for (let i = 0; i < 3; i++) {
      const ledger = new EvidenceLedger(root, 4);
      ledger.escalate(`attempt ${i + 1} failed`);
      ledger.setOutcome("escalated");
    }

    const fourth = new EvidenceLedger(root, 4);
    expect(fourth.data.pass).toBe(4);
    for (const n of [1, 2, 3]) {
      expect(
        existsSync(join(root, ".ralph", "evidence", `sprint-4.pass-${n}.json`)),
      ).toBe(true);
    }
  });

  it("resumes an unfinished pass untouched — that is what crash recovery needs", () => {
    const crashed = new EvidenceLedger(root, 5);
    crashed.escalate("scope violation");
    crashed.recordCheck(0, "Build", "npm run build", false, "boom");
    // no setOutcome — the process died mid-sprint

    const resumed = new EvidenceLedger(root, 5);

    expect(resumed.escalations).toEqual(["scope violation"]);
    expect(resumed.data.checks).toHaveLength(1);
    expect(resumed.data.pass).toBe(1);
    expect(
      existsSync(join(root, ".ralph", "evidence", "sprint-5.pass-1.json")),
    ).toBe(false);
  });

  it("notes the pass number in the PR body only when it is a re-run", () => {
    const first = new EvidenceLedger(root, 7);
    expect(first.renderMarkdown()).not.toContain("Pass 2 of this sprint");
    first.setOutcome("shipped");

    const second = new EvidenceLedger(root, 7);
    expect(second.renderMarkdown()).toContain("**Pass 2 of this sprint.**");
  });
});
