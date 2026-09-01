import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  scaffoldGovernance,
  judgeScript,
  RALPH_TEMPLATE_VERSION,
} from "./governance.js";
import type { ProjectContext } from "../context/types.js";

const JUDGE = ".github/scripts/ralph-judge.mjs";

function ctx(): ProjectContext {
  return {
    root: "/repo",
    name: "app",
    description: "",
    isMonorepo: false,
    packageManager: "npm",
    workspaces: [
      { name: "app", path: ".", type: "backend", checks: [{ name: "test", cmd: "npm test", cwd: "." }], dependencies: [] },
    ],
    stack: { languages: ["ts"], frameworks: [] },
    git: { baseBranch: "main", remote: "origin", provider: "github" },
    productSpec: "",
    sprintsDir: "docs/sprints",
    docs: [],
  };
}

function repo(): { root: string; write(p: string, c: string): void; read(p: string): string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "ralph-gov-"));
  return {
    root,
    write(p, c) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), c);
    },
    read: (p) => readFileSync(join(root, p), "utf-8"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("the generated judge", () => {
  let dir: ReturnType<typeof repo>;
  afterEach(() => dir?.cleanup());

  it("is valid JavaScript — it runs in CI where a syntax error is silent until a PR opens", () => {
    dir = repo();
    dir.write("judge.mjs", judgeScript());

    expect(() =>
      execFileSync(process.execPath, ["--check", join(dir.root, "judge.mjs")], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("cross-checks the ledger rather than trusting it", () => {
    const script = judgeScript();

    // The claims that must not come from the thing being judged.
    expect(script).toContain("Evidence ledger belongs to this branch");
    expect(script).toContain("Evidence commits are in this PR");
    expect(script).toContain("CI independently confirms the verification");
    expect(script).toContain("recomputed from the PR");
  });

  it("pages the file list, so a large PR is judged on all of it", () => {
    expect(judgeScript()).toContain("--paginate");
  });
});

describe("scaffoldGovernance — upgrading repositories that already adopted it", () => {
  let dir: ReturnType<typeof repo>;
  afterEach(() => dir?.cleanup());

  it("writes the files on a fresh repo", () => {
    dir = repo();

    const result = scaffoldGovernance(ctx(), dir.root);

    expect(result.created).toContain(JUDGE);
    expect(result.updated).toEqual([]);
    expect(dir.read(JUDGE)).toContain(`ralph-template v${RALPH_TEMPLATE_VERSION}`);
  });

  it("replaces its own older output, so a fix reaches repos already using it", () => {
    dir = repo();
    dir.write(JUDGE, "// ralph-judge.mjs — ralph-template v1\nconsole.log('old');\n");

    const result = scaffoldGovernance(ctx(), dir.root);

    expect(result.updated).toContain(JUDGE);
    expect(dir.read(JUDGE)).toContain("CI independently confirms the verification");
  });

  it("leaves a hand-written file alone — governance files are the team's to edit", () => {
    dir = repo();
    dir.write(JUDGE, "// our own judge, no marker\n");

    const result = scaffoldGovernance(ctx(), dir.root);

    expect(result.skipped).toContain(JUDGE);
    expect(dir.read(JUDGE)).toBe("// our own judge, no marker\n");
  });

  it("is idempotent — a second run at the same version changes nothing", () => {
    dir = repo();
    scaffoldGovernance(ctx(), dir.root);
    const before = dir.read(JUDGE);

    const result = scaffoldGovernance(ctx(), dir.root);

    expect(result.updated).toEqual([]);
    expect(result.created).toEqual([]);
    expect(dir.read(JUDGE)).toBe(before);
  });
});
