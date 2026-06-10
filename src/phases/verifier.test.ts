import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the agent so no real Claude calls happen
vi.mock("../core/agent.js", () => ({
  runAgent: vi.fn(async () => "fix attempt summary"),
}));

import { runAgent } from "../core/agent.js";
import { verifyAndFix } from "./verifier.js";
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
