import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldGovernance, detectOwner } from "./governance.js";
import type { ProjectContext } from "../context/types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ralph-gov-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
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
        checks: [
          { name: "Tests", cmd: "npm test", cwd: "." },
          { name: "Typecheck", cmd: "npm run typecheck", cwd: "apps/api" },
        ],
        dependencies: [],
      },
    ],
    stack: { languages: ["typescript"], frameworks: [] },
    git: { baseBranch: "main", remote: "origin", provider: "github" },
    productSpec: "",
    sprintsDir: join(root, "docs/sprints"),
    docs: [],
    ...overrides,
  };
}

describe("scaffoldGovernance", () => {
  it("creates the PR template, CODEOWNERS, and checks workflow", () => {
    const result = scaffoldGovernance(makeCtx(), root);

    expect(result.created).toContain(".github/pull_request_template.md");
    expect(result.created).toContain(".github/CODEOWNERS");
    expect(result.created).toContain(".github/workflows/ralph-checks.yml");
    expect(result.skipped).toEqual([]);

    const template = readFileSync(join(root, ".github/pull_request_template.md"), "utf-8");
    for (const section of ["## Goal", "## Plan", "## Evidence", "## Risks & Rollback", "## Review checklist"]) {
      expect(template).toContain(section);
    }
  });

  it("workflow runs the project's detected checks", () => {
    scaffoldGovernance(makeCtx(), root);
    const workflow = readFileSync(join(root, ".github/workflows/ralph-checks.yml"), "utf-8");
    expect(workflow).toContain("run: npm test");
    expect(workflow).toContain("run: npm run typecheck");
    expect(workflow).toContain("working-directory: apps/api");
    expect(workflow).toContain("npm ci");
  });

  it("skips the workflow when no checks are detected", () => {
    const ctx = makeCtx({
      workspaces: [
        { name: "app", path: ".", type: "backend", checks: [], dependencies: [] },
      ],
    });
    const result = scaffoldGovernance(ctx, root);
    expect(result.created).not.toContain(".github/workflows/ralph-checks.yml");
    expect(existsSync(join(root, ".github/workflows/ralph-checks.yml"))).toBe(false);
  });

  it("never overwrites existing files", () => {
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github/CODEOWNERS"), "/custom @someone\n");

    const result = scaffoldGovernance(makeCtx(), root);
    expect(result.skipped).toContain(".github/CODEOWNERS");
    expect(readFileSync(join(root, ".github/CODEOWNERS"), "utf-8")).toBe("/custom @someone\n");
  });
});

describe("detectOwner", () => {
  it("falls back to a placeholder outside a git repo with a remote", () => {
    expect(detectOwner(root)).toBe("@your-github-username");
  });
});
