import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scanProject } from "./scanner.js";

// Helper to create fixture directories
function createFixture(base: string) {
  const root = join("/tmp", `ralph-test-${base}-${Date.now()}`);
  mkdirSync(root, { recursive: true });

  // Init a git repo so scanner doesn't crash
  const { execSync } = require("node:child_process");
  execSync(
    'git init && git config user.email "test@test.com" && git config user.name "test" && git commit --allow-empty -m init',
    { cwd: root, stdio: "ignore" },
  );

  return {
    root,
    file(path: string, content: string) {
      const full = join(root, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
      return this;
    },
    dir(path: string) {
      mkdirSync(join(root, path), { recursive: true });
      return this;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ── Package manager detection ──

describe("package manager detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("detects npm from package-lock.json", () => {
    fix = createFixture("npm");
    fix.file("package.json", JSON.stringify({ name: "test" }));
    fix.file("package-lock.json", "{}");
    const ctx = scanProject(fix.root);
    expect(ctx.packageManager).toBe("npm");
  });

  it("detects pnpm from pnpm-lock.yaml", () => {
    fix = createFixture("pnpm");
    fix.file("package.json", JSON.stringify({ name: "test" }));
    fix.file("pnpm-lock.yaml", "lockfileVersion: 5.4");
    const ctx = scanProject(fix.root);
    expect(ctx.packageManager).toBe("pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    fix = createFixture("yarn");
    fix.file("package.json", JSON.stringify({ name: "test" }));
    fix.file("yarn.lock", "# yarn lockfile");
    const ctx = scanProject(fix.root);
    expect(ctx.packageManager).toBe("yarn");
  });

  it("detects bun from bun.lockb", () => {
    fix = createFixture("bun");
    fix.file("package.json", JSON.stringify({ name: "test" }));
    fix.file("bun.lockb", "binary");
    const ctx = scanProject(fix.root);
    expect(ctx.packageManager).toBe("bun");
  });

  it("detects pip from requirements.txt", () => {
    fix = createFixture("pip");
    fix.file("requirements.txt", "flask==2.0\n");
    const ctx = scanProject(fix.root);
    expect(ctx.packageManager).toBe("pip");
  });

  it("returns none when no markers found", () => {
    fix = createFixture("none");
    const ctx = scanProject(fix.root);
    expect(ctx.packageManager).toBe("none");
  });
});

// ── Node.js project detection ──

describe("node.js single app detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("detects a NestJS backend", () => {
    fix = createFixture("nestjs");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "@my/api",
        dependencies: { "@nestjs/core": "^10.0.0" },
        scripts: { build: "nest build", test: "jest" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces).toHaveLength(1);
    expect(ctx.workspaces[0].type).toBe("backend");
    expect(ctx.workspaces[0].framework).toBe("nestjs");
  });

  it("detects a Next.js frontend", () => {
    fix = createFixture("nextjs");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "web",
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
        scripts: { build: "next build", lint: "eslint ." },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces[0].type).toBe("frontend");
    expect(ctx.workspaces[0].framework).toBe("nextjs");
  });

  it("detects TypeScript language from tsconfig.json", () => {
    fix = createFixture("ts");
    fix.file(
      "package.json",
      JSON.stringify({ name: "app", dependencies: { express: "^4" } }),
    );
    fix.file("tsconfig.json", "{}");
    const ctx = scanProject(fix.root);
    expect(ctx.stack.languages).toContain("typescript");
  });

  it("detects TypeScript from devDependencies", () => {
    fix = createFixture("ts-dep");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: { express: "^4" },
        devDependencies: { typescript: "^5" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.stack.languages).toContain("typescript");
  });

  it("detects JavaScript when no TypeScript markers", () => {
    fix = createFixture("js");
    fix.file(
      "package.json",
      JSON.stringify({ name: "app", dependencies: { express: "^4" } }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.stack.languages).toContain("javascript");
  });
});

// ── Node checks detection ──

describe("node checks detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("detects build, test, lint scripts", () => {
    fix = createFixture("checks");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: { express: "^4" },
        scripts: {
          build: "tsc",
          test: "vitest run",
          lint: "eslint .",
        },
      }),
    );
    const ctx = scanProject(fix.root);
    const checkNames = ctx.workspaces[0].checks.map((c) => c.name);
    expect(checkNames).toContain("Build");
    expect(checkNames).toContain("Unit Tests");
    expect(checkNames).toContain("Lint");
  });

  it("deduplicates test and test:unit", () => {
    fix = createFixture("dedup");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: { express: "^4" },
        scripts: {
          test: "vitest run",
          "test:unit": "vitest run --coverage",
          "test:e2e": "playwright test",
        },
      }),
    );
    const ctx = scanProject(fix.root);
    const checkNames = ctx.workspaces[0].checks.map((c) => c.name);
    const unitTestCount = checkNames.filter((n) => n === "Unit Tests").length;
    expect(unitTestCount).toBe(1);
    expect(checkNames).toContain("E2E Tests");
  });
});

// ── Monorepo detection ──

describe("monorepo detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("detects npm workspaces", () => {
    fix = createFixture("monorepo");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "monorepo",
        workspaces: ["apps/*"],
      }),
    );
    fix.file(
      "apps/api/package.json",
      JSON.stringify({
        name: "@mono/api",
        dependencies: { "@nestjs/core": "^10" },
        scripts: { build: "nest build" },
      }),
    );
    fix.file(
      "apps/web/package.json",
      JSON.stringify({
        name: "@mono/web",
        dependencies: { next: "^14" },
        scripts: { build: "next build" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.isMonorepo).toBe(true);
    expect(ctx.workspaces).toHaveLength(2);
    expect(ctx.workspaces.map((w) => w.type).sort()).toEqual([
      "backend",
      "frontend",
    ]);
  });

  it("detects pnpm-workspace.yaml", () => {
    fix = createFixture("pnpm-mono");
    fix.file("package.json", JSON.stringify({ name: "root" }));
    fix.file(
      "pnpm-workspace.yaml",
      "packages:\n  - apps/*\n",
    );
    fix.file(
      "apps/api/package.json",
      JSON.stringify({
        name: "@mono/api",
        dependencies: { express: "^4" },
      }),
    );
    fix.file("pnpm-lock.yaml", "lockfileVersion: 5.4");
    const ctx = scanProject(fix.root);
    expect(ctx.isMonorepo).toBe(true);
    expect(ctx.workspaces).toHaveLength(1);
    expect(ctx.packageManager).toBe("pnpm");
  });

  it("detects turbo.json monorepo", () => {
    fix = createFixture("turbo-mono");
    fix.file("package.json", JSON.stringify({ name: "root" }));
    fix.file("turbo.json", "{}");
    fix.file(
      "apps/api/package.json",
      JSON.stringify({
        name: "@mono/api",
        dependencies: { fastify: "^4" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.isMonorepo).toBe(true);
    expect(ctx.workspaces.length).toBeGreaterThan(0);
  });
});

// ── Python detection ──

describe("python project detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("detects root-level Flask project", () => {
    fix = createFixture("flask-root");
    fix.file("requirements.txt", "flask==2.3.0\ngunicorn==21.2.0\n");
    fix.dir("tests");
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces).toHaveLength(1);
    expect(ctx.workspaces[0].type).toBe("backend");
    expect(ctx.workspaces[0].framework).toBe("flask");
    expect(ctx.workspaces[0].path).toBe(".");
    expect(ctx.stack.languages).toContain("python");
  });

  it("detects root-level FastAPI with pytest and ruff", () => {
    fix = createFixture("fastapi-root");
    fix.file("requirements.txt", "fastapi==0.100\nuvicorn==0.23\n");
    fix.file("requirements-dev.txt", "pytest==7.4\nruff==0.1.0\n");
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces[0].framework).toBe("fastapi");
    const checkNames = ctx.workspaces[0].checks.map((c) => c.name);
    expect(checkNames).toContain("Unit Tests");
    expect(checkNames).toContain("Lint");
    expect(ctx.stack.testRunner).toBe("pytest");
    expect(ctx.stack.linter).toBe("ruff");
  });

  it("detects Python in a subdirectory workspace", () => {
    fix = createFixture("py-subdir");
    fix.file("backend/requirements.txt", "django==4.2\npytest==7.0\n");
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces.some((w) => w.path === "backend")).toBe(true);
    const backend = ctx.workspaces.find((w) => w.path === "backend")!;
    expect(backend.framework).toBe("django");
    expect(backend.type).toBe("backend");
  });

  it("detects pyproject.toml dependencies", () => {
    fix = createFixture("pyproject");
    fix.file(
      "pyproject.toml",
      `[project]
name = "myapp"

dependencies = [
  "flask>=2.0",
  "sqlalchemy>=2.0",
]
`,
    );
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces[0].framework).toBe("flask");
    expect(ctx.stack.languages).toContain("python");
  });

  it("detects root Python + subdirectory Node (polyglot)", () => {
    fix = createFixture("polyglot-py-node");
    fix.file("requirements.txt", "flask==2.3\npytest==7.4\nruff==0.1\n");
    fix.file(
      "cockpit/package.json",
      JSON.stringify({
        name: "cockpit",
        dependencies: { react: "^18", "react-dom": "^18" },
        scripts: { build: "vite build" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces.length).toBe(2);
    const pyWs = ctx.workspaces.find((w) => w.path === ".")!;
    const nodeWs = ctx.workspaces.find((w) => w.path === "cockpit")!;
    expect(pyWs.framework).toBe("flask");
    expect(pyWs.type).toBe("backend");
    expect(nodeWs.type).toBe("frontend");
    expect(ctx.isMonorepo).toBe(true);
    expect(ctx.stack.languages).toContain("python");
  });

  it("parses requirements.txt filtering -r lines and comments", () => {
    fix = createFixture("py-reqs-filter");
    fix.file(
      "requirements.txt",
      `-r requirements-base.txt
# Core
flask==2.3.0
gunicorn>=21.0
# this is a comment
`,
    );
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces[0].framework).toBe("flask");
  });
});

// ── Go detection ──

describe("go project detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("detects root-level Go project with Gin", () => {
    fix = createFixture("go-gin");
    fix.file(
      "go.mod",
      `module github.com/user/myapp

go 1.21

require (
\tgithub.com/gin-gonic/gin v1.9.1
)
`,
    );
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces).toHaveLength(1);
    expect(ctx.workspaces[0].framework).toBe("gin");
    expect(ctx.workspaces[0].type).toBe("backend");
    expect(ctx.workspaces[0].path).toBe(".");
    expect(ctx.stack.languages).toContain("go");
    const checkNames = ctx.workspaces[0].checks.map((c) => c.name);
    expect(checkNames).toContain("Build");
    expect(checkNames).toContain("Unit Tests");
  });

  it("detects Go in subdirectory", () => {
    fix = createFixture("go-subdir");
    fix.file(
      "api/go.mod",
      `module github.com/user/api

go 1.21

require (
\tgithub.com/gofiber/fiber v2.0.0
)
`,
    );
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces.some((w) => w.path === "api")).toBe(true);
    const api = ctx.workspaces.find((w) => w.path === "api")!;
    expect(api.framework).toBe("fiber");
  });

  it("detects golangci-lint config", () => {
    fix = createFixture("go-lint");
    fix.file("go.mod", "module myapp\n\ngo 1.21\n");
    fix.file(".golangci.yml", "linters:\n  enable:\n    - govet\n");
    const ctx = scanProject(fix.root);
    const checkNames = ctx.workspaces[0].checks.map((c) => c.name);
    expect(checkNames).toContain("Lint");
  });
});

// ── Rust detection ──

describe("rust project detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("detects root-level Rust project with Axum", () => {
    fix = createFixture("rust-axum");
    fix.file(
      "Cargo.toml",
      `[package]
name = "my-service"
version = "0.1.0"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
`,
    );
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces).toHaveLength(1);
    expect(ctx.workspaces[0].name).toBe("my-service");
    expect(ctx.workspaces[0].framework).toBe("axum");
    expect(ctx.workspaces[0].type).toBe("backend");
    expect(ctx.stack.languages).toContain("rust");
  });

  it("detects Rust in subdirectory", () => {
    fix = createFixture("rust-subdir");
    fix.file(
      "service/Cargo.toml",
      `[package]
name = "svc"

[dependencies]
actix-web = "4"
`,
    );
    const ctx = scanProject(fix.root);
    const svc = ctx.workspaces.find((w) => w.path === "service")!;
    expect(svc.framework).toBe("actix");
    expect(svc.type).toBe("backend");
  });

  it("detects clippy and rustfmt checks", () => {
    fix = createFixture("rust-checks");
    fix.file(
      "Cargo.toml",
      `[package]
name = "app"

[dependencies]
serde = "1"
`,
    );
    fix.file("rustfmt.toml", "max_width = 100\n");
    const ctx = scanProject(fix.root);
    const checkNames = ctx.workspaces[0].checks.map((c) => c.name);
    expect(checkNames).toContain("Lint");
    expect(checkNames).toContain("Format");
  });
});

// ── Stack detection ──

describe("stack detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("detects database from Node deps", () => {
    fix = createFixture("db-prisma");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: { "@prisma/client": "^5" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.stack.database).toBe("prisma");
  });

  it("detects database from Python deps", () => {
    fix = createFixture("db-sqlalchemy");
    fix.file("requirements.txt", "flask==2.3\nsqlalchemy==2.0\n");
    const ctx = scanProject(fix.root);
    expect(ctx.stack.database).toBe("sqlalchemy");
  });

  it("detects test runner (vitest)", () => {
    fix = createFixture("vitest");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "app",
        devDependencies: { vitest: "^1" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.stack.testRunner).toBe("vitest");
  });

  it("detects linter (biome)", () => {
    fix = createFixture("biome");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "app",
        devDependencies: { "@biomejs/biome": "^1" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.stack.linter).toBe("biome");
  });

  it("detects build tool (turbo)", () => {
    fix = createFixture("turbo");
    fix.file(
      "package.json",
      JSON.stringify({
        name: "app",
        devDependencies: { turbo: "^2" },
      }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.stack.buildTool).toBe("turbo");
  });

  it("detects docker-compose as build tool", () => {
    fix = createFixture("docker");
    fix.file("requirements.txt", "flask==2.3\n");
    fix.file("docker-compose.yml", "version: '3'\nservices:\n  app:\n");
    const ctx = scanProject(fix.root);
    expect(ctx.stack.buildTool).toContain("docker-compose");
  });

  it("detects multiple languages in polyglot project", () => {
    fix = createFixture("polyglot");
    fix.file(
      "frontend/package.json",
      JSON.stringify({
        name: "web",
        dependencies: { svelte: "^4" },
      }),
    );
    fix.file("backend/requirements.txt", "fastapi==0.100\n");
    const ctx = scanProject(fix.root);
    expect(ctx.stack.languages).toContain("javascript");
    expect(ctx.stack.languages).toContain("python");
  });
});

// ── Product spec detection ──

describe("product spec detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("finds PRODUCT_SPEC.md", () => {
    fix = createFixture("spec1");
    fix.file("package.json", JSON.stringify({ name: "app" }));
    fix.file("PRODUCT_SPEC.md", "# My Spec");
    const ctx = scanProject(fix.root);
    expect(ctx.productSpec).toContain("PRODUCT_SPEC.md");
  });

  it("finds VISION.md as fallback", () => {
    fix = createFixture("spec-vision");
    fix.file("package.json", JSON.stringify({ name: "app" }));
    fix.file("VISION.md", "# Vision");
    const ctx = scanProject(fix.root);
    expect(ctx.productSpec).toContain("VISION.md");
  });

  it("returns empty string when no spec found", () => {
    fix = createFixture("no-spec");
    fix.file("package.json", JSON.stringify({ name: "app" }));
    const ctx = scanProject(fix.root);
    expect(ctx.productSpec).toBe("");
  });
});

// ── Project name and description ──

describe("project name detection", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("reads name from package.json", () => {
    fix = createFixture("name-pkg");
    fix.file(
      "package.json",
      JSON.stringify({ name: "my-awesome-app", description: "Does things" }),
    );
    const ctx = scanProject(fix.root);
    expect(ctx.name).toBe("my-awesome-app");
    expect(ctx.description).toBe("Does things");
  });

  it("reads name from pyproject.toml", () => {
    fix = createFixture("name-py");
    fix.file(
      "pyproject.toml",
      `[project]\nname = "cool-service"\n\ndependencies = ["flask"]\n`,
    );
    const ctx = scanProject(fix.root);
    expect(ctx.name).toBe("cool-service");
  });

  it("falls back to directory name", () => {
    fix = createFixture("name-fallback");
    const ctx = scanProject(fix.root);
    expect(ctx.name).toContain("ralph-test-name-fallback");
  });
});

// ── Edge cases ──

describe("edge cases", () => {
  let fix: ReturnType<typeof createFixture>;
  afterEach(() => fix?.cleanup());

  it("handles empty project gracefully", () => {
    fix = createFixture("empty");
    const ctx = scanProject(fix.root);
    expect(ctx.workspaces).toHaveLength(0);
    expect(ctx.packageManager).toBe("none");
    expect(ctx.stack.languages).toEqual(["unknown"]);
  });

  it("skips node_modules and .git directories", () => {
    fix = createFixture("skip-dirs");
    fix.file(
      "node_modules/express/package.json",
      JSON.stringify({ name: "express" }),
    );
    fix.file(".git/config", "bare = false");
    const ctx = scanProject(fix.root);
    // Should not have picked up express from node_modules
    expect(ctx.workspaces.every((w) => w.name !== "express")).toBe(true);
  });

  it("handles root Python project that also has tests dir", () => {
    fix = createFixture("py-tests-dir");
    fix.file("requirements.txt", "flask==2.3\n");
    fix.dir("tests");
    fix.file("tests/test_app.py", "def test_hello(): pass\n");
    const ctx = scanProject(fix.root);
    const checks = ctx.workspaces[0].checks.map((c) => c.name);
    expect(checks).toContain("Unit Tests");
  });
});
