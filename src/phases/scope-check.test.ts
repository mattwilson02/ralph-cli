import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { checkScope } from "./scope-check.js";
import type { ProjectContext } from "../context/types.js";

let root: string;

function git(cmd: string): void {
  execSync(cmd, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

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
  root = mkdtempSync(join(tmpdir(), "ralph-scope-"));
  git("git init -q");
  writeFileSync(join(root, "README.md"), "# test\n");
  git("git add -A && git commit -q -m init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SPEC = [
  "## Declared Files",
  "- `src/api/users.ts`",
  "- `src/components/`",
].join("\n");

describe("checkScope", () => {
  it("passes when all changes are declared", () => {
    mkdirSync(join(root, "src/api"), { recursive: true });
    mkdirSync(join(root, "src/components/List"), { recursive: true });
    writeFileSync(join(root, "src/api/users.ts"), "export {};");
    writeFileSync(join(root, "src/components/List/index.ts"), "export {};");

    const result = checkScope(makeCtx(), SPEC);
    expect(result.outOfScope).toEqual([]);
    expect(result.changed.length).toBe(2);
  });

  it("flags undeclared changes as out of scope", () => {
    mkdirSync(join(root, "src/api"), { recursive: true });
    writeFileSync(join(root, "src/api/users.ts"), "export {};");
    writeFileSync(join(root, "README.md"), "# tampered\n");

    const result = checkScope(makeCtx(), SPEC);
    expect(result.outOfScope).toEqual(["README.md"]);
  });

  it("always allows dependency manifests and Ralph working files", () => {
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "package-lock.json"), "{}");
    mkdirSync(join(root, "docs/sprints"), { recursive: true });
    writeFileSync(join(root, "docs/sprints/sprint-1-x.md"), "spec");

    const result = checkScope(makeCtx(), SPEC);
    expect(result.outOfScope).toEqual([]);
  });

  it("allows nested workspace manifests", () => {
    mkdirSync(join(root, "apps/api"), { recursive: true });
    writeFileSync(join(root, "apps/api/package.json"), "{}");

    const result = checkScope(makeCtx(), SPEC);
    expect(result.outOfScope).toEqual([]);
  });
});
