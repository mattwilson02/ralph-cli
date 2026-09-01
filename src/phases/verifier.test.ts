import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the agent so no real Claude calls happen
vi.mock("../core/agent.js", () => ({
  runAgent: vi.fn(async () => "fix attempt summary"),
}));

import { runAgent } from "../core/agent.js";
import { verifyAndFix, countFailures, madeProgress } from "./verifier.js";
import type { ProjectContext } from "../context/types.js";

let root: string;
let specPath: string;

function makeCtx(checkCmds: { name: string; cmd: string }[]): ProjectContext {
  return {
    root,
    name: "test-app",
    description: "",
    isMonorepo: false,
    packageManager: "npm",
    workspaces: [
      {
        name: "app",
        path: ".",
        type: "backend",
        checks: checkCmds.map((c) => ({ ...c, cwd: "." })),
        dependencies: [],
      },
    ],
    stack: { languages: ["typescript"], frameworks: [] },
    git: { baseBranch: "main", remote: "origin", provider: "github" },
    productSpec: "",
    sprintsDir: join(root, "docs/sprints"),
    docs: [],
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ralph-verifier-"));
  specPath = join(root, "spec.md");
  writeFileSync(specPath, "# Sprint spec\nDo the thing.");
  vi.mocked(runAgent).mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("verifyAndFix", () => {
  it("returns passed result without running the fix agent when checks pass", async () => {
    const ctx = makeCtx([{ name: "Always OK", cmd: "true" }]);
    const result = await verifyAndFix(ctx, "full", specPath, "model", 3);

    expect(result.passed).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("escalates early when the same check fails twice with no progress", async () => {
    const ctx = makeCtx([{ name: "Always Fails", cmd: "false" }]);
    const escalations: string[] = [];
    const ledger = {
      recordCheck: vi.fn(),
      recordFixAttempt: vi.fn(),
      escalate: (reason: string) => escalations.push(reason),
    };

    const result = await verifyAndFix(
      ctx,
      "full",
      specPath,
      "model",
      5,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ledger as any,
    );

    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(["Always Fails"]);
    // One verify, one fix attempt, one re-verify showing no progress — stop.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("Fix loop stalled");
    expect(escalations[0]).toContain("Always Fails");
  });

  it("records check results and fix attempts in the ledger", async () => {
    const ctx = makeCtx([{ name: "Always Fails", cmd: "false" }]);
    const ledger = {
      recordCheck: vi.fn(),
      recordFixAttempt: vi.fn(),
      escalate: vi.fn(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await verifyAndFix(ctx, "full", specPath, "model", 5, ledger as any);

    expect(ledger.recordCheck).toHaveBeenCalledWith(
      0,
      "Always Fails",
      "false",
      false,
      expect.any(String),
    );
    expect(ledger.recordFixAttempt).toHaveBeenCalledWith(
      0,
      ["Always Fails"],
      "fix attempt summary",
    );
  });

  it("returns failed result after exhausting attempts", async () => {
    // Without a ledger there is still a stall guard — use 0 attempts to
    // test pure exhaustion (no fix agent run at all).
    const ctx = makeCtx([{ name: "Always Fails", cmd: "false" }]);
    const result = await verifyAndFix(ctx, "full", specPath, "model", 0);

    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(["Always Fails"]);
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("countFailures", () => {
  it("reads vitest and jest summary counts", () => {
    expect(countFailures("Tests  12 failed | 40 passed (52)")).toBe(12);
    expect(countFailures("Tests: 3 failed, 9 passed, 12 total")).toBe(3);
  });

  it("reads tsc and eslint counts", () => {
    expect(countFailures("Found 7 errors in 3 files.")).toBe(7);
    expect(countFailures("\u2716 12 problems (12 errors, 0 warnings)")).toBe(12);
  });

  it("falls back to counting failure markers", () => {
    const out = ["\u2715 a.test.ts > adds", "\u2715 b.test.ts > subtracts"].join("\n");
    expect(countFailures(out)).toBe(2);
  });

  it("never reports zero for output it cannot parse", () => {
    // A failure it cannot count must still read as failing, never as progress.
    expect(countFailures("something went wrong")).toBe(1);
    expect(countFailures("")).toBe(1);
  });
});

describe("madeProgress", () => {
  const res = (counts: Record<string, number>) => ({
    passed: Object.keys(counts).length === 0,
    output: "",
    failedChecks: Object.keys(counts),
    failureCounts: counts,
  });

  it("counts a recovered check as progress", () => {
    expect(madeProgress(res({ Build: 1, Tests: 4 }), res({ Tests: 4 }))).toBe(true);
  });

  it("counts a falling failure count as progress — the regression", () => {
    // 40 failing tests down to 1 leaves "Tests" in failedChecks either way.
    // Comparing names alone scored this as stalled and quit the fix loop
    // after 1 of 3 attempts.
    expect(madeProgress(res({ Tests: 40 }), res({ Tests: 1 }))).toBe(true);
  });

  it("is stalled when the same failures persist", () => {
    expect(madeProgress(res({ Tests: 4 }), res({ Tests: 4 }))).toBe(false);
  });

  it("is stalled when a fix trades one failure for another", () => {
    expect(madeProgress(res({ Tests: 4 }), res({ Tests: 3, Lint: 1 }))).toBe(false);
  });

  it("is stalled when the fix makes things worse", () => {
    expect(madeProgress(res({ Tests: 2 }), res({ Tests: 9 }))).toBe(false);
  });
});

describe("verifyAndFix progress detection", () => {
  it("keeps fixing while the failure count is falling", async () => {
    // Emits "N failed" and decrements N each run: the check name never
    // changes, so only the counts reveal that the loop is working.
    const counter = join(root, "fail-count");
    writeFileSync(counter, "4");
    const cmd = `sh -c 'n=$(cat ${counter}); echo "$n failed"; echo $((n-1)) > ${counter}; exit 1'`;

    const ctx = makeCtx([{ name: "Unit Tests", cmd }]);
    const escalations: string[] = [];
    const ledger = {
      recordCheck: vi.fn(),
      recordFixAttempt: vi.fn(),
      noteProgress: vi.fn(),
      escalate: (reason: string) => escalations.push(reason),
    };

    const result = await verifyAndFix(
      ctx,
      "full",
      specPath,
      "model",
      3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ledger as any,
    );

    // Three fix attempts used, not one — the old name-only comparison
    // stopped after the first because "Unit Tests" was still failing.
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(result.passed).toBe(false);
    expect(escalations).toHaveLength(0);
    expect(ledger.noteProgress).toHaveBeenCalled();
  });
});
