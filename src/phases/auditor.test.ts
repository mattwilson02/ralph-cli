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

describe("tryParseAudit — responses the greedy matcher used to break on", () => {
  const shape = { completed: ["a"], missing: [], issues: [] };

  it("parses a bare JSON object", () => {
    expect(tryParseAudit(JSON.stringify(shape))).toEqual(shape);
  });

  it("parses JSON inside a fenced block", () => {
    const raw = "```json\n" + JSON.stringify(shape) + "\n```";
    expect(tryParseAudit(raw)).toEqual(shape);
  });

  it("parses JSON followed by a closing remark", () => {
    // The old /\{[\s\S]*\}/ ran to the LAST brace in the response, so any
    // trailing brace swallowed the object and the audit was recorded as
    // unparseable — three of six escalations on the IoM CIS run.
    const raw = JSON.stringify(shape) + "\n\nNote: see handler() { ... } for detail.";
    expect(tryParseAudit(raw)).toEqual(shape);
  });

  it("parses JSON preceded by prose containing braces", () => {
    const raw = "I checked the spec (the `{id}` route too). Here it is:\n" + JSON.stringify(shape);
    expect(tryParseAudit(raw)).toEqual(shape);
  });

  it("picks the audit object when the response contains two objects", () => {
    const raw = '{"unrelated": true}\n' + JSON.stringify(shape);
    expect(tryParseAudit(raw)).toEqual(shape);
  });

  it("is not confused by braces inside strings", () => {
    const withBraces = { completed: ["route {id} done"], missing: [], issues: [] };
    expect(tryParseAudit("prose\n" + JSON.stringify(withBraces))).toEqual(withBraces);
  });

  it("still returns null when there is no audit object", () => {
    expect(tryParseAudit("I could not complete the audit.")).toBeNull();
    expect(tryParseAudit('{"completed": "not an array"}')).toBeNull();
    expect(tryParseAudit("")).toBeNull();
  });
});
