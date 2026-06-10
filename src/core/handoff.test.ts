import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReportRelPath,
  readBuildReports,
  writeOutcomeSummary,
  readOutcomeSummaries,
  handoffDir,
} from "./handoff.js";
import type { EvidenceRecord } from "../types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ralph-handoff-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    sprint: 3,
    specName: "sprint-3-users-api",
    branchName: "sprint/sprint-3-users-api",
    checks: [],
    fixAttempts: [],
    escalations: [],
    startedAt: new Date().toISOString(),
    outcome: "shipped",
    ...overrides,
  };
}

describe("build reports", () => {
  it("readBuildReports returns null when none exist", () => {
    expect(readBuildReports(root, 3)).toBeNull();
  });

  it("concatenates all scoped reports for a sprint", () => {
    const dir = handoffDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sprint-3-build-report-backend.md"), "backend work");
    writeFileSync(join(dir, "sprint-3-build-report-frontend.md"), "frontend work");
    writeFileSync(join(dir, "sprint-4-build-report-all.md"), "other sprint");

    const reports = readBuildReports(root, 3);
    expect(reports).toContain("backend work");
    expect(reports).toContain("frontend work");
    expect(reports).not.toContain("other sprint");
  });

  it("buildReportRelPath stays inside .ralph/handoff", () => {
    expect(buildReportRelPath(5, "all")).toBe(
      join(".ralph", "handoff", "sprint-5-build-report-all.md"),
    );
  });
});

describe("outcome summaries", () => {
  it("returns null when no sprints have completed", () => {
    expect(readOutcomeSummaries(root)).toBeNull();
  });

  it("round-trips a shipped outcome", () => {
    writeOutcomeSummary(root, record());
    const summary = readOutcomeSummaries(root);
    expect(summary).toContain("Sprint 3 — SHIPPED");
    expect(summary).toContain("sprint-3-users-api");
    expect(summary).not.toContain("NOT merged");
  });

  it("escalated outcomes carry the do-not-build-on-this warning", () => {
    writeOutcomeSummary(
      root,
      record({
        outcome: "escalated",
        escalations: ["Full verification failed after 3 fix attempts: Tests"],
      }),
    );
    const summary = readOutcomeSummaries(root);
    expect(summary).toContain("ESCALATED");
    expect(summary).toContain("Full verification failed");
    expect(summary).toContain("NOT merged");
  });

  it("orders by sprint number and respects the limit", () => {
    for (const n of [10, 2, 1, 3]) {
      writeOutcomeSummary(root, record({ sprint: n, specName: `sprint-${n}-x` }));
    }
    const summary = readOutcomeSummaries(root, 2);
    expect(summary).not.toContain("Sprint 2 —");
    expect(summary).toContain("Sprint 3 —");
    expect(summary).toContain("Sprint 10 —");
    // Oldest first
    expect(summary!.indexOf("Sprint 3 —")).toBeLessThan(summary!.indexOf("Sprint 10 —"));
  });
});
