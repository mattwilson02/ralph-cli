import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../core/agent.js", () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from "../core/agent.js";
import { auditSpec, tryParseAudit, AUDIT_PARSE_FAILURE } from "./auditor.js";
import type { ProjectContext } from "../context/types.js";

let root: string;
let specPath: string;

function makeCtx(): ProjectContext {
  return {
    root,
    name: "test-app",
    description: "",
    isMonorepo: false,
    packageManager: "npm",
    workspaces: [],
    stack: { languages: ["typescript"], frameworks: [] },
    git: { baseBranch: "main", remote: "origin", provider: "github" },
    productSpec: "",
    sprintsDir: join(root, "docs/sprints"),
    docs: [],
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ralph-auditor-"));
  specPath = join(root, "spec.md");
  writeFileSync(specPath, "# Sprint spec");
  vi.mocked(runAgent).mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("auditSpec", () => {
  it("parses a valid audit result on the first attempt", async () => {
    vi.mocked(runAgent).mockResolvedValueOnce(
      'Done. {"completed": ["a"], "missing": ["b"], "issues": []}',
    );

    const audit = await auditSpec(makeCtx(), specPath, "model");
    expect(audit).toEqual({ completed: ["a"], missing: ["b"], issues: [] });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("retries once with a corrective prompt on parse failure", async () => {
    vi.mocked(runAgent)
      .mockResolvedValueOnce("I could not produce JSON, sorry!")
      .mockResolvedValueOnce('{"completed": [], "missing": [], "issues": []}');

    const audit = await auditSpec(makeCtx(), specPath, "model");
    expect(audit.issues).toEqual([]);
    expect(runAgent).toHaveBeenCalledTimes(2);
    const retryPrompt = vi.mocked(runAgent).mock.calls[1][0] as string;
    expect(retryPrompt).toContain("could not be parsed");
  });

  it("returns audit-parse-failure issue when both attempts are unparseable", async () => {
    vi.mocked(runAgent).mockResolvedValue("still not json");

    const audit = await auditSpec(makeCtx(), specPath, "model");
    expect(audit.completed).toEqual([]);
    expect(audit.missing).toEqual([]);
    expect(audit.issues).toEqual([AUDIT_PARSE_FAILURE]);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });
});

describe("tryParseAudit", () => {
  it("rejects JSON missing required arrays", () => {
    expect(tryParseAudit('{"completed": []}')).toBeNull();
    expect(tryParseAudit('{"completed": "x", "missing": [], "issues": []}')).toBeNull();
  });

  it("extracts JSON embedded in prose", () => {
    const result = tryParseAudit(
      'Here you go: {"completed": ["x"], "missing": [], "issues": []} hope that helps',
    );
    expect(result?.completed).toEqual(["x"]);
  });

  it("returns null for no JSON at all", () => {
    expect(tryParseAudit("no json here")).toBeNull();
  });
});
