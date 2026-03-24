import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildProjectSummary,
  isEarlyStage,
  buildSpecWriterPrompt,
  buildImprovementPrompt,
  buildTaskPrompt,
  buildBuilderPrompt,
  buildFixPrompt,
  buildAuditPrompt,
  getExistingSpecs,
} from "./prompts.js";
import type { ProjectContext, Workspace } from "./types.js";

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    root: "/tmp/test-project",
    name: "test-app",
    description: "A test application",
    isMonorepo: false,
    packageManager: "npm",
    workspaces: [
      {
        name: "app",
        path: ".",
        type: "backend",
        framework: "express",
        checks: [
          { name: "Build", cmd: "npm run build", cwd: "." },
          { name: "Unit Tests", cmd: "npm run test", cwd: "." },
        ],
        dependencies: [],
      },
    ],
    stack: {
      languages: ["typescript"],
      frameworks: ["express"],
      database: "prisma",
      testRunner: "vitest",
      linter: "eslint",
      buildTool: "tsup",
    },
    git: {
      baseBranch: "main",
      remote: "origin",
      provider: "github",
    },
    productSpec: "",
    sprintsDir: "/tmp/test-project/docs/sprints",
    docs: [],
    ...overrides,
  };
}

// ── buildProjectSummary ──

describe("buildProjectSummary", () => {
  it("includes project name and stack", () => {
    const ctx = makeCtx();
    const summary = buildProjectSummary(ctx);
    expect(summary).toContain("test-app");
    expect(summary).toContain("typescript");
    expect(summary).toContain("express");
    expect(summary).toContain("prisma");
  });

  it("includes description when present", () => {
    const ctx = makeCtx({ description: "My cool app" });
    const summary = buildProjectSummary(ctx);
    expect(summary).toContain("My cool app");
  });

  it("shows monorepo workspaces", () => {
    const ctx = makeCtx({
      isMonorepo: true,
      workspaces: [
        {
          name: "api",
          path: "apps/api",
          type: "backend",
          framework: "nestjs",
          checks: [],
          dependencies: [],
        },
        {
          name: "web",
          path: "apps/web",
          type: "frontend",
          framework: "nextjs",
          checks: [],
          dependencies: [],
        },
      ],
    });
    const summary = buildProjectSummary(ctx);
    expect(summary).toContain("Monorepo");
    expect(summary).toContain("apps/api");
    expect(summary).toContain("apps/web");
  });

  it("shows Single app for non-monorepo", () => {
    const ctx = makeCtx({ isMonorepo: false });
    const summary = buildProjectSummary(ctx);
    expect(summary).toContain("Single app");
  });
});

// ── isEarlyStage ──

describe("isEarlyStage", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for empty workspaces", () => {
    const ctx = makeCtx({ workspaces: [] });
    expect(isEarlyStage(ctx)).toBe(true);
  });

  it("returns true for workspace with few source files", () => {
    tmpDir = join("/tmp", `ralph-early-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), "export {}");
    writeFileSync(join(tmpDir, "src", "app.ts"), "export {}");

    const ctx = makeCtx({
      root: tmpDir,
      workspaces: [
        {
          name: "app",
          path: ".",
          type: "backend",
          checks: [],
          dependencies: [],
        },
      ],
    });
    expect(isEarlyStage(ctx)).toBe(true);
  });

  it("returns false for workspace with many source files", () => {
    tmpDir = join("/tmp", `ralph-mature-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(tmpDir, "src", `file${i}.ts`), `export const x${i} = ${i}`);
    }

    const ctx = makeCtx({
      root: tmpDir,
      workspaces: [
        {
          name: "app",
          path: ".",
          type: "backend",
          checks: [],
          dependencies: [],
        },
      ],
    });
    expect(isEarlyStage(ctx)).toBe(false);
  });
});

// ── getExistingSpecs ──

describe("getExistingSpecs", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for missing directory", () => {
    expect(getExistingSpecs("/tmp/nonexistent-dir-xyz")).toEqual([]);
  });

  it("finds and sorts sprint spec files", () => {
    tmpDir = join("/tmp", `ralph-specs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "sprint-2-feature-b.md"), "# Sprint 2");
    writeFileSync(join(tmpDir, "sprint-1-feature-a.md"), "# Sprint 1");
    writeFileSync(join(tmpDir, "sprint-3-feature-c.md"), "# Sprint 3");
    writeFileSync(join(tmpDir, "README.md"), "Not a sprint");

    const specs = getExistingSpecs(tmpDir);
    expect(specs).toHaveLength(3);
    expect(specs[0].number).toBe(1);
    expect(specs[1].number).toBe(2);
    expect(specs[2].number).toBe(3);
    expect(specs[0].content).toBe("# Sprint 1");
  });
});

// ── Prompt builders ──

describe("buildSpecWriterPrompt", () => {
  it("includes project context and instructions", () => {
    const ctx = makeCtx();
    const prompt = buildSpecWriterPrompt(ctx, 1);
    expect(prompt).toContain("sprint planning agent");
    expect(prompt).toContain("test-app");
    expect(prompt).toContain("sprint-1-");
    expect(prompt).toContain("Maximum **15 new files**");
    expect(prompt).toContain("Maximum **5 tasks**");
  });

  it("includes greenfield scaffolding instructions when flag set", () => {
    const ctx = makeCtx();
    const prompt = buildSpecWriterPrompt(ctx, 1, true);
    expect(prompt).toContain("new project");
    expect(prompt).toContain("scaffolding");
  });

  it("does not include greenfield instructions when not set", () => {
    const ctx = makeCtx();
    const prompt = buildSpecWriterPrompt(ctx, 1, false);
    expect(prompt).not.toContain("This is a new project");
  });

  it("includes verification commands", () => {
    const ctx = makeCtx();
    const prompt = buildSpecWriterPrompt(ctx, 1);
    expect(prompt).toContain("npm run build");
    expect(prompt).toContain("npm run test");
  });
});

describe("buildImprovementPrompt", () => {
  it("mentions improvement mode", () => {
    const ctx = makeCtx();
    const prompt = buildImprovementPrompt(ctx, 1);
    expect(prompt).toContain("improvement mode");
    expect(prompt).toContain("no product spec");
    expect(prompt).toContain("Do NOT add new features");
  });
});

describe("buildTaskPrompt", () => {
  it("includes task description", () => {
    const ctx = makeCtx();
    const prompt = buildTaskPrompt(ctx, 1, "add rate limiting to API");
    expect(prompt).toContain("directed task");
    expect(prompt).toContain("add rate limiting to API");
  });
});

describe("buildBuilderPrompt", () => {
  it("scopes to backend workspaces", () => {
    const ctx = makeCtx({
      workspaces: [
        { name: "api", path: "apps/api", type: "backend", framework: "nestjs", checks: [], dependencies: [] },
        { name: "web", path: "apps/web", type: "frontend", framework: "nextjs", checks: [], dependencies: [] },
      ],
    });
    const prompt = buildBuilderPrompt(ctx, "# Sprint spec content", "backend");
    expect(prompt).toContain("apps/api");
    expect(prompt).not.toContain("apps/web");
  });

  it("scopes to frontend workspaces", () => {
    const ctx = makeCtx({
      workspaces: [
        { name: "api", path: "apps/api", type: "backend", checks: [], dependencies: [] },
        { name: "web", path: "apps/web", type: "frontend", checks: [], dependencies: [] },
      ],
    });
    const prompt = buildBuilderPrompt(ctx, "# Spec", "frontend");
    expect(prompt).toContain("apps/web");
    expect(prompt).not.toContain("apps/api");
  });

  it("includes all workspaces for scope=all", () => {
    const ctx = makeCtx({
      workspaces: [
        { name: "api", path: "apps/api", type: "backend", checks: [], dependencies: [] },
        { name: "web", path: "apps/web", type: "frontend", checks: [], dependencies: [] },
      ],
    });
    const prompt = buildBuilderPrompt(ctx, "# Spec", "all");
    expect(prompt).toContain("apps/api");
    expect(prompt).toContain("apps/web");
  });
});

describe("buildFixPrompt", () => {
  it("includes failures and spec", () => {
    const ctx = makeCtx();
    const prompt = buildFixPrompt(ctx, "TypeError: x is not a function", "# Sprint Spec");
    expect(prompt).toContain("TypeError: x is not a function");
    expect(prompt).toContain("Sprint Spec");
    expect(prompt).toContain("Do NOT modify test expectations");
  });
});

describe("buildAuditPrompt", () => {
  it("includes spec and JSON output format", () => {
    const ctx = makeCtx();
    const prompt = buildAuditPrompt(ctx, "# My Sprint Spec");
    expect(prompt).toContain("My Sprint Spec");
    expect(prompt).toContain('"completed"');
    expect(prompt).toContain('"missing"');
  });
});
