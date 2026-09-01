import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scanProject } from "../context/scanner.js";
import { rescanProject, countChecks } from "./engine.js";

function greenfieldRepo(): { root: string; cleanup(): void } {
  const root = join("/tmp", `ralph-rescan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  execSync(
    'git init && git config user.email "t@t.com" && git config user.name "t" && git commit --allow-empty -m init',
    { cwd: root, stdio: "ignore" },
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("rescanProject — a greenfield run must see the checks it acquires", () => {
  let repo: ReturnType<typeof greenfieldRepo>;
  afterEach(() => repo?.cleanup());

  it("picks up a test script that did not exist at launch", () => {
    repo = greenfieldRepo();
    const atLaunch = scanProject(repo.root);
    expect(countChecks(atLaunch)).toBe(0);

    // What sprint 1 does on a greenfield build.
    writeFileSync(
      join(repo.root, "package.json"),
      JSON.stringify({ name: "app", scripts: { test: "vitest run", build: "tsup" } }),
    );

    expect(countChecks(rescanProject(atLaunch))).toBeGreaterThan(0);
  });

  it("never lets the base branch drift onto the sprint branch it is scanned from", () => {
    repo = greenfieldRepo();
    const atLaunch = scanProject(repo.root);
    execSync("git checkout -b sprint/2", { cwd: repo.root, stdio: "ignore" });

    // The base branch is what later sprints branch from and what the PR
    // targets — re-detecting it here would point Ralph at its own work.
    expect(rescanProject(atLaunch).git.baseBranch).toBe(atLaunch.git.baseBranch);
    expect(rescanProject(atLaunch).git.baseBranch).not.toBe("sprint/2");
  });

  it("keeps the root it was given", () => {
    repo = greenfieldRepo();
    const atLaunch = scanProject(repo.root);

    expect(rescanProject(atLaunch).root).toBe(repo.root);
  });
});
