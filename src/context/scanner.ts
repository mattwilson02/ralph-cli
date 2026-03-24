import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { detectBaseBranch, detectRemoteUrl, detectGitProvider, parseGiteaRemote } from "../util/git.js";
import type {
  ProjectContext,
  Workspace,
  Check,
  StackInfo,
  GitInfo,
} from "./types.js";

interface PackageJson {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages: string[] };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function fileExists(...segments: string[]): boolean {
  return existsSync(join(...segments));
}

// ── Package manager detection ──

function detectPackageManager(root: string): ProjectContext["packageManager"] {
  if (fileExists(root, "bun.lockb") || fileExists(root, "bun.lock"))
    return "bun";
  if (fileExists(root, "pnpm-lock.yaml")) return "pnpm";
  if (fileExists(root, "yarn.lock")) return "yarn";
  if (fileExists(root, "package-lock.json") || fileExists(root, "package.json"))
    return "npm";
  if (
    fileExists(root, "requirements.txt") ||
    fileExists(root, "pyproject.toml") ||
    fileExists(root, "Pipfile")
  )
    return "pip";
  return "none";
}

// ── Node monorepo workspace detection ──

function detectMonorepoWorkspaces(
  root: string,
  pkg: PackageJson,
): string[] | null {
  if (pkg.workspaces) {
    const patterns = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces.packages;
    return resolveGlobs(root, patterns);
  }

  if (fileExists(root, "pnpm-workspace.yaml")) {
    const content = readFileSync(join(root, "pnpm-workspace.yaml"), "utf-8");
    const match = content.match(/packages:\s*\n((?:\s*-\s*.+\n?)*)/);
    if (match) {
      const patterns = match[1]
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
      return resolveGlobs(root, patterns);
    }
  }

  if (fileExists(root, "turbo.json") || fileExists(root, "nx.json")) {
    const dirs: string[] = [];
    for (const dir of ["apps", "packages", "libs"]) {
      if (fileExists(root, dir)) {
        const entries = readdirSync(join(root, dir)).filter((e) =>
          statSync(join(root, dir, e)).isDirectory(),
        );
        dirs.push(...entries.map((e) => `${dir}/${e}`));
      }
    }
    if (dirs.length > 0) return dirs;
  }

  return null;
}

function resolveGlobs(root: string, patterns: string[]): string[] {
  const results: string[] = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/\*$/, "").replace(/['"]/g, "");
    const dir = join(root, clean);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      if (fileExists(dir, "package.json")) {
        results.push(clean);
      } else {
        const entries = readdirSync(dir).filter(
          (e) =>
            statSync(join(dir, e)).isDirectory() &&
            fileExists(dir, e, "package.json"),
        );
        results.push(...entries.map((e) => `${clean}/${e}`));
      }
    }
  }
  return results;
}

// ── Polyglot workspace detection ──

/** Scan top-level subdirs for code projects (Python, Node, etc.) */
function detectPolyglotWorkspaces(root: string): Workspace[] {
  const workspaces: Workspace[] = [];
  const skip = new Set([
    "node_modules",
    ".git",
    ".ralph",
    "dist",
    "build",
    "deployment",
    "scripts",
    "docs",
    "vault",
    "__pycache__",
  ]);

  const entries = readdirSync(root).filter(
    (e) =>
      !e.startsWith(".") &&
      !skip.has(e) &&
      statSync(join(root, e)).isDirectory(),
  );

  for (const dir of entries) {
    const absDir = join(root, dir);

    // Python workspace
    if (
      fileExists(absDir, "requirements.txt") ||
      fileExists(absDir, "pyproject.toml") ||
      fileExists(absDir, "Pipfile") ||
      fileExists(absDir, "setup.py")
    ) {
      workspaces.push(scanPythonWorkspace(root, dir));
      continue;
    }

    // Node workspace
    if (fileExists(absDir, "package.json")) {
      const pkg = readJson<PackageJson>(join(absDir, "package.json"));
      if (pkg) {
        const deps = getAllDeps(pkg);
        workspaces.push({
          name: pkg.name || dir,
          path: dir,
          type: detectNodeWorkspaceType(deps),
          framework: detectNodeFramework(deps),
          checks: detectNodeChecks(pkg.scripts || {}, dir, "npm run"),
          dependencies: [],
        });
      }
      continue;
    }

    // Go workspace
    if (fileExists(absDir, "go.mod")) {
      workspaces.push(scanGoWorkspace(root, dir));
      continue;
    }

    // Rust workspace
    if (fileExists(absDir, "Cargo.toml")) {
      workspaces.push(scanRustWorkspace(root, dir));
      continue;
    }
  }

  // Also check root-level projects (single-app, not in subdirectory)
  // Run even if subdirectory workspaces were found (e.g. root Python + cockpit React)
  const hasRootWorkspace = workspaces.some((w) => w.path === ".");
  if (!hasRootWorkspace) {
    if (
      fileExists(root, "requirements.txt") ||
      fileExists(root, "pyproject.toml") ||
      fileExists(root, "Pipfile") ||
      fileExists(root, "setup.py")
    ) {
      workspaces.push(scanPythonWorkspace(root, "."));
    } else if (fileExists(root, "go.mod")) {
      workspaces.push(scanGoWorkspace(root, "."));
    } else if (fileExists(root, "Cargo.toml")) {
      workspaces.push(scanRustWorkspace(root, "."));
    }
  }

  return workspaces;
}

// ── Python detection ──

const PYTHON_BACKEND_MARKERS = [
  "flask",
  "fastapi",
  "django",
  "sanic",
  "starlette",
  "tornado",
  "aiohttp",
  "bottle",
  "falcon",
  "litestar",
];
const PYTHON_FRAMEWORK_MAP: Record<string, string> = {
  flask: "flask",
  fastapi: "fastapi",
  django: "django",
  sanic: "sanic",
  starlette: "starlette",
  tornado: "tornado",
  aiohttp: "aiohttp",
  litestar: "litestar",
};
const PYTHON_DB_MARKERS: Record<string, string> = {
  sqlalchemy: "sqlalchemy",
  "sqlalchemy[asyncio]": "sqlalchemy",
  django: "django-orm",
  peewee: "peewee",
  tortoise: "tortoise",
  mongoengine: "mongoengine",
  chromadb: "chromadb",
  pinecone: "pinecone",
  weaviate: "weaviate",
};
const PYTHON_TEST_MARKERS: Record<string, string> = {
  pytest: "pytest",
  unittest: "unittest",
  nose2: "nose2",
};
const PYTHON_LINT_MARKERS: Record<string, string> = {
  ruff: "ruff",
  flake8: "flake8",
  pylint: "pylint",
  black: "black",
  mypy: "mypy",
};

function parseRequirementsTxt(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l && !l.startsWith("-"))
    .map((l) => l.split(/[=<>~![\s]/)[0].toLowerCase());
}

function parsePythonDeps(absDir: string): string[] {
  // requirements.txt + requirements-dev.txt
  const deps: string[] = [];
  for (const file of ["requirements.txt", "requirements-dev.txt"]) {
    const content = readFile(join(absDir, file));
    if (content) deps.push(...parseRequirementsTxt(content));
  }
  if (deps.length > 0) return deps;

  // pyproject.toml — rough parse of dependencies list
  const pyproject = readFile(join(absDir, "pyproject.toml"));
  if (pyproject) {
    const depSection = pyproject.match(
      /\[(?:project\.)?dependencies\]\s*\n([\s\S]*?)(?:\n\[|\n$)/,
    );
    if (depSection) {
      return depSection[1]
        .split("\n")
        .map((l) => l.replace(/#.*/, "").replace(/['"]/g, "").trim())
        .filter(Boolean)
        .map((l) => l.split(/[=<>~![\s]/)[0].toLowerCase());
    }
    // Also try dependencies = [...] format
    const depList = pyproject.match(
      /dependencies\s*=\s*\[([\s\S]*?)\]/,
    );
    if (depList) {
      return depList[1]
        .split("\n")
        .map((l) =>
          l
            .replace(/#.*/, "")
            .replace(/['"",]/g, "")
            .trim(),
        )
        .filter(Boolean)
        .map((l) => l.split(/[=<>~![\s]/)[0].toLowerCase());
    }
  }

  // Pipfile — rough parse
  const pipfile = readFile(join(absDir, "Pipfile"));
  if (pipfile) {
    const packagesSection = pipfile.match(
      /\[packages\]\s*\n([\s\S]*?)(?:\n\[|\n$)/,
    );
    if (packagesSection) {
      return packagesSection[1]
        .split("\n")
        .map((l) => l.split("=")[0].trim().toLowerCase())
        .filter(Boolean);
    }
  }

  return [];
}

function scanPythonWorkspace(root: string, dir: string): Workspace {
  const absDir = join(root, dir);
  const deps = parsePythonDeps(absDir);

  // Detect type
  let type: Workspace["type"] = "unknown";
  for (const marker of PYTHON_BACKEND_MARKERS) {
    if (deps.includes(marker)) {
      type = "backend";
      break;
    }
  }

  // Detect framework
  let framework: string | undefined;
  for (const [dep, name] of Object.entries(PYTHON_FRAMEWORK_MAP)) {
    if (deps.includes(dep)) {
      framework = name;
      break;
    }
  }

  // Detect checks
  const checks: Check[] = [];
  const hasPytest = deps.includes("pytest") || fileExists(absDir, "tests");
  const hasMypy = deps.includes("mypy");
  const hasRuff = deps.includes("ruff");
  const hasBlack = deps.includes("black");
  const hasFlake8 = deps.includes("flake8");

  if (hasPytest)
    checks.push({ name: "Unit Tests", cmd: "python -m pytest", cwd: dir });
  if (hasMypy)
    checks.push({ name: "Type Check", cmd: "python -m mypy .", cwd: dir });
  if (hasRuff)
    checks.push({ name: "Lint", cmd: "ruff check .", cwd: dir });
  else if (hasFlake8)
    checks.push({ name: "Lint", cmd: "flake8 .", cwd: dir });
  if (hasBlack)
    checks.push({ name: "Format", cmd: "black --check .", cwd: dir });

  return {
    name: dir === "." ? basename(absDir) : dir,
    path: dir,
    type,
    framework,
    checks,
    dependencies: [],
  };
}

// ── Go detection ──

const GO_FRAMEWORK_MAP: Record<string, string> = {
  "github.com/gin-gonic/gin": "gin",
  "github.com/gofiber/fiber": "fiber",
  "github.com/labstack/echo": "echo",
  "github.com/gorilla/mux": "gorilla",
  "github.com/go-chi/chi": "chi",
  "net/http": "stdlib",
};

function parseGoMod(absDir: string): string[] {
  const goMod = readFile(join(absDir, "go.mod"));
  if (!goMod) return [];
  return goMod
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//") && !l.startsWith("module") && l.length > 0)
    .map((l) => l.replace(/\s+v.*/, "").trim());
}

function scanGoWorkspace(root: string, dir: string): Workspace {
  const absDir = dir === "." ? root : join(root, dir);
  const deps = parseGoMod(absDir);

  let framework: string | undefined;
  for (const [dep, name] of Object.entries(GO_FRAMEWORK_MAP)) {
    if (deps.some((d) => d.includes(dep))) {
      framework = name;
      break;
    }
  }

  const checks: Check[] = [
    { name: "Build", cmd: "go build ./...", cwd: dir },
    { name: "Unit Tests", cmd: "go test ./...", cwd: dir },
  ];

  // Check if golangci-lint config exists
  if (
    fileExists(absDir, ".golangci.yml") ||
    fileExists(absDir, ".golangci.yaml") ||
    fileExists(absDir, ".golangci.toml")
  ) {
    checks.push({ name: "Lint", cmd: "golangci-lint run", cwd: dir });
  }

  const name = dir === "." ? basename(root) : dir;

  return {
    name,
    path: dir,
    type: "backend",
    framework: framework || "go",
    checks,
    dependencies: [],
  };
}

// ── Rust detection ──

const RUST_FRAMEWORK_MAP: Record<string, string> = {
  actix: "actix",
  "actix-web": "actix",
  axum: "axum",
  rocket: "rocket",
  warp: "warp",
  tide: "tide",
};
const RUST_DB_MARKERS: Record<string, string> = {
  diesel: "diesel",
  sqlx: "sqlx",
  "sea-orm": "sea-orm",
  mongodb: "mongodb",
};

interface CargoToml {
  package?: { name?: string };
  dependencies?: Record<string, unknown>;
  "dev-dependencies"?: Record<string, unknown>;
  workspace?: { members?: string[] };
}

function parseCargoToml(absDir: string): { name: string; deps: string[] } {
  const content = readFile(join(absDir, "Cargo.toml"));
  if (!content) return { name: "", deps: [] };

  // Rough TOML parse — get package name
  const nameMatch = content.match(
    /\[package\][\s\S]*?name\s*=\s*["']([^"']+)["']/,
  );
  const name = nameMatch ? nameMatch[1] : "";

  // Extract dependency names from [dependencies] and [dev-dependencies]
  const deps: string[] = [];
  const depSections = content.matchAll(
    /\[(?:dev-)?dependencies\]\s*\n([\s\S]*?)(?=\n\[|$)/g,
  );
  for (const match of depSections) {
    const lines = match[1].split("\n");
    for (const line of lines) {
      const depMatch = line.match(/^(\S+)\s*=/);
      if (depMatch) deps.push(depMatch[1]);
    }
  }

  return { name: name || "", deps };
}

function scanRustWorkspace(root: string, dir: string): Workspace {
  const absDir = dir === "." ? root : join(root, dir);
  const { name: crateName, deps } = parseCargoToml(absDir);

  // Detect framework
  let framework: string | undefined;
  for (const [dep, name] of Object.entries(RUST_FRAMEWORK_MAP)) {
    if (deps.includes(dep)) {
      framework = name;
      break;
    }
  }

  // Detect type — if it has a web framework it's backend, otherwise unknown
  const type: Workspace["type"] = framework ? "backend" : "unknown";

  const checks: Check[] = [
    { name: "Build", cmd: "cargo build", cwd: dir },
    { name: "Unit Tests", cmd: "cargo test", cwd: dir },
  ];

  // clippy for linting
  if (
    fileExists(absDir, "clippy.toml") ||
    fileExists(absDir, ".clippy.toml") ||
    deps.length > 0 // clippy is built-in, always available
  ) {
    checks.push({ name: "Lint", cmd: "cargo clippy -- -D warnings", cwd: dir });
  }

  // rustfmt
  if (fileExists(absDir, "rustfmt.toml") || fileExists(absDir, ".rustfmt.toml")) {
    checks.push({ name: "Format", cmd: "cargo fmt -- --check", cwd: dir });
  }

  const name = crateName || (dir === "." ? basename(root) : dir);

  return {
    name,
    path: dir,
    type,
    framework,
    checks,
    dependencies: [],
  };
}

// ── Node detection (existing logic) ──

const NODE_BACKEND_MARKERS = [
  "@nestjs/core",
  "express",
  "fastify",
  "hono",
  "koa",
  "@hapi/hapi",
];
const NODE_FRONTEND_WEB_MARKERS = [
  "next",
  "nuxt",
  "remix",
  "react-dom",
  "@angular/core",
  "svelte",
  "vue",
  "solid-js",
  "astro",
];
const NODE_FRONTEND_MOBILE_MARKERS = ["expo", "react-native"];
const NODE_DATABASE_MARKERS: Record<string, string> = {
  prisma: "prisma",
  "@prisma/client": "prisma",
  drizzle: "drizzle",
  "drizzle-orm": "drizzle",
  typeorm: "typeorm",
  mongoose: "mongoose",
  knex: "knex",
  sequelize: "sequelize",
};
const NODE_TEST_MARKERS: Record<string, string> = {
  vitest: "vitest",
  jest: "jest",
  mocha: "mocha",
  playwright: "playwright",
  "@playwright/test": "playwright",
  cypress: "cypress",
};
const NODE_LINTER_MARKERS: Record<string, string> = {
  "@biomejs/biome": "biome",
  eslint: "eslint",
  prettier: "prettier",
};
const NODE_FRAMEWORK_MARKERS: Record<string, string> = {
  "@nestjs/core": "nestjs",
  express: "express",
  fastify: "fastify",
  hono: "hono",
  next: "nextjs",
  nuxt: "nuxt",
  remix: "remix",
  expo: "expo",
  "react-native": "react-native",
  "@angular/core": "angular",
  svelte: "svelte",
  vue: "vue",
  "solid-js": "solid",
  astro: "astro",
};

function getAllDeps(pkg: PackageJson): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

function detectNodeWorkspaceType(
  deps: Record<string, string>,
): Workspace["type"] {
  for (const marker of NODE_BACKEND_MARKERS) {
    if (marker in deps) return "backend";
  }
  for (const marker of [
    ...NODE_FRONTEND_WEB_MARKERS,
    ...NODE_FRONTEND_MOBILE_MARKERS,
  ]) {
    if (marker in deps) return "frontend";
  }
  return "unknown";
}

function detectNodeFramework(
  deps: Record<string, string>,
): string | undefined {
  for (const [dep, framework] of Object.entries(NODE_FRAMEWORK_MARKERS)) {
    if (dep in deps) return framework;
  }
  return undefined;
}

function detectNodeChecks(
  scripts: Record<string, string>,
  cwd: string,
  runCmd = "npm run",
): Check[] {
  const checks: Check[] = [];
  const mapping: Record<string, string> = {
    build: "Build",
    "type-check": "Type Check",
    typecheck: "Type Check",
    test: "Unit Tests",
    "test:unit": "Unit Tests",
    "test:e2e": "E2E Tests",
    lint: "Lint",
    format: "Format",
  };

  const seen = new Set<string>();
  for (const [script, label] of Object.entries(mapping)) {
    if (scripts[script] && !seen.has(label)) {
      checks.push({ name: label, cmd: `${runCmd} ${script}`, cwd });
      seen.add(label);
    }
  }

  if (
    !scripts["type-check"] &&
    !scripts["typecheck"] &&
    !checks.some((c) => c.name === "Build")
  ) {
    checks.push({ name: "Type Check", cmd: "npx tsc --noEmit", cwd });
  }

  return checks;
}

function detectNodeWorkspaceDeps(
  workspacePath: string,
  pkg: PackageJson,
  allWorkspaces: string[],
): string[] {
  const deps = getAllDeps(pkg);
  const internal: string[] = [];
  for (const ws of allWorkspaces) {
    if (ws === workspacePath) continue;
    for (const depName of Object.keys(deps)) {
      if (depName.includes(ws.split("/").pop() || "")) {
        internal.push(ws);
        break;
      }
    }
  }
  return internal;
}

// ── Stack detection (polyglot) ──

function detectStack(
  root: string,
  workspaces: Workspace[],
  allNodePkgs: PackageJson[],
  allPythonDeps: string[],
): StackInfo {
  const languages: string[] = [];

  // Node languages
  const allNodeDeps: Record<string, string> = {};
  for (const pkg of allNodePkgs) {
    Object.assign(allNodeDeps, getAllDeps(pkg));
  }
  if (allNodePkgs.length > 0) {
    if (
      fileExists(root, "tsconfig.json") ||
      "typescript" in allNodeDeps ||
      workspaces.some((w) =>
        fileExists(root, w.path, "tsconfig.json"),
      )
    ) {
      languages.push("typescript");
    } else {
      languages.push("javascript");
    }
  }

  // Python
  if (
    allPythonDeps.length > 0 ||
    workspaces.some(
      (w) =>
        fileExists(root, w.path, "requirements.txt") ||
        fileExists(root, w.path, "pyproject.toml"),
    )
  ) {
    languages.push("python");
  }

  // Go
  if (
    workspaces.some((w) => fileExists(root, w.path, "go.mod")) ||
    fileExists(root, "go.mod")
  ) {
    languages.push("go");
  }

  // Rust
  if (
    workspaces.some((w) => fileExists(root, w.path, "Cargo.toml")) ||
    fileExists(root, "Cargo.toml")
  ) {
    languages.push("rust");
  }

  // Frameworks — combine Node + Python
  const frameworks: string[] = [];
  for (const [dep, name] of Object.entries(NODE_FRAMEWORK_MARKERS)) {
    if (dep in allNodeDeps) frameworks.push(name);
  }
  for (const [dep, name] of Object.entries(PYTHON_FRAMEWORK_MAP)) {
    if (allPythonDeps.includes(dep)) frameworks.push(name);
  }

  // Frameworks — Go + Rust (detected via workspace scan, add to list)
  for (const ws of workspaces) {
    if (ws.framework && !frameworks.includes(ws.framework)) {
      frameworks.push(ws.framework);
    }
  }

  // Database — Node
  let database: string | undefined;
  for (const [dep, name] of Object.entries(NODE_DATABASE_MARKERS)) {
    if (dep in allNodeDeps) {
      database = name;
      break;
    }
  }
  // Database — Python (if not found in Node)
  if (!database) {
    for (const [dep, name] of Object.entries(PYTHON_DB_MARKERS)) {
      if (allPythonDeps.includes(dep)) {
        database = name;
        break;
      }
    }
  }

  // Test runner
  let testRunner: string | undefined;
  for (const [dep, name] of Object.entries(NODE_TEST_MARKERS)) {
    if (dep in allNodeDeps) {
      testRunner = name;
      break;
    }
  }
  if (!testRunner) {
    for (const [dep, name] of Object.entries(PYTHON_TEST_MARKERS)) {
      if (allPythonDeps.includes(dep)) {
        testRunner = name;
        break;
      }
    }
  }

  // Linter
  let linter: string | undefined;
  for (const [dep, name] of Object.entries(NODE_LINTER_MARKERS)) {
    if (dep in allNodeDeps) {
      linter = name;
      break;
    }
  }
  if (!linter) {
    for (const [dep, name] of Object.entries(PYTHON_LINT_MARKERS)) {
      if (allPythonDeps.includes(dep)) {
        linter = name;
        break;
      }
    }
  }

  // Build tool
  let buildTool: string | undefined;
  if ("turbo" in allNodeDeps || fileExists(root, "turbo.json"))
    buildTool = "turbo";
  else if ("nx" in allNodeDeps || fileExists(root, "nx.json")) buildTool = "nx";
  else if ("tsup" in allNodeDeps) buildTool = "tsup";
  else if ("vite" in allNodeDeps) buildTool = "vite";
  if (fileExists(root, "docker-compose.yml") || fileExists(root, "docker-compose.yaml")) {
    buildTool = buildTool ? `${buildTool}, docker-compose` : "docker-compose";
  }

  return {
    languages: languages.length > 0 ? languages : ["unknown"],
    frameworks,
    database,
    testRunner,
    linter,
    buildTool,
  };
}

// ── Shared helpers ──

function findProductSpec(root: string): string | undefined {
  const candidates = [
    "PRODUCT_SPEC.md",
    "SPEC.md",
    "spec.md",
    "docs/PRODUCT_SPEC.md",
    "docs/spec.md",
    "docs/product-spec.md",
    "PRODUCT_SPEC.txt",
    "VISION.md",
    "docs/VISION.md",
  ];
  for (const candidate of candidates) {
    if (fileExists(root, candidate)) return join(root, candidate);
  }
  return undefined;
}

function findSprintsDir(root: string): string {
  const candidates = ["docs/sprints", "sprints", ".ralph/sprints"];
  for (const candidate of candidates) {
    if (fileExists(root, candidate)) return join(root, candidate);
  }
  return join(root, "docs", "sprints");
}

function findDocs(root: string): string[] {
  const candidates = [
    "CLAUDE.md",
    "README.md",
    "ARCHITECTURE.md",
    "CONTRIBUTING.md",
    "SOUL.md",
    "docs/architecture.md",
  ];
  return candidates
    .filter((c) => fileExists(root, c))
    .map((c) => join(root, c));
}

// ── Project name detection ──

function detectProjectName(root: string): string {
  const rootPkg = readJson<PackageJson>(join(root, "package.json"));
  if (rootPkg?.name) return rootPkg.name;

  const pyproject = readFile(join(root, "pyproject.toml"));
  if (pyproject) {
    const nameMatch = pyproject.match(/name\s*=\s*["']([^"']+)["']/);
    if (nameMatch) return nameMatch[1];
  }

  return basename(root);
}

function detectProjectDescription(root: string): string {
  const rootPkg = readJson<PackageJson>(join(root, "package.json"));
  if (rootPkg?.description) return rootPkg.description;

  // Try to get first line from README
  const readme = readFile(join(root, "README.md"));
  if (readme) {
    const firstContent = readme
      .split("\n")
      .find((l) => l.trim() && !l.startsWith("#"));
    if (firstContent) return firstContent.trim().slice(0, 120);
  }

  return "";
}

// ── Main scanner ──

export function scanProject(root: string): ProjectContext {
  const rootPkg = readJson<PackageJson>(join(root, "package.json"));

  const packageManager = detectPackageManager(root);
  const runCmd =
    packageManager === "yarn"
      ? "yarn"
      : packageManager === "pip" || packageManager === "none"
        ? "npm run"
        : `${packageManager} run`;

  const allNodePkgs: PackageJson[] = [];
  const allPythonDeps: string[] = [];
  const workspaces: Workspace[] = [];
  let isMonorepo = false;

  if (rootPkg) {
    allNodePkgs.push(rootPkg);

    // Try Node monorepo detection
    const workspacePaths = detectMonorepoWorkspaces(root, rootPkg);
    isMonorepo = workspacePaths !== null && workspacePaths.length > 0;

    if (isMonorepo && workspacePaths) {
      for (const wsPath of workspacePaths) {
        const wsPkg = readJson<PackageJson>(
          join(root, wsPath, "package.json"),
        );
        if (!wsPkg) continue;
        allNodePkgs.push(wsPkg);

        const deps = getAllDeps(wsPkg);
        workspaces.push({
          name: wsPkg.name || wsPath,
          path: wsPath,
          type: detectNodeWorkspaceType(deps),
          framework: detectNodeFramework(deps),
          checks: detectNodeChecks(wsPkg.scripts || {}, wsPath, runCmd),
          dependencies: detectNodeWorkspaceDeps(
            wsPath,
            wsPkg,
            workspacePaths,
          ),
        });
      }

      const depPaths = new Set(workspaces.flatMap((w) => w.dependencies));
      for (const ws of workspaces) {
        if (ws.type === "unknown" && depPaths.has(ws.path)) {
          ws.type = "shared";
        }
      }
    } else {
      // Single Node app
      const deps = getAllDeps(rootPkg);
      workspaces.push({
        name: rootPkg.name || "app",
        path: ".",
        type: detectNodeWorkspaceType(deps),
        framework: detectNodeFramework(deps),
        checks: detectNodeChecks(rootPkg.scripts || {}, ".", runCmd),
        dependencies: [],
      });
    }
  } else {
    // No root package.json — polyglot project
    // Scan subdirectories for workspaces
    const polyWorkspaces = detectPolyglotWorkspaces(root);
    workspaces.push(...polyWorkspaces);
    isMonorepo = workspaces.length > 1;

    // Collect Python deps for stack detection
    for (const ws of polyWorkspaces) {
      if (
        fileExists(root, ws.path, "requirements.txt") ||
        fileExists(root, ws.path, "pyproject.toml")
      ) {
        allPythonDeps.push(...parsePythonDeps(join(root, ws.path)));
      }
      // If it has a package.json, add to allNodePkgs
      const pkg = readJson<PackageJson>(
        join(root, ws.path, "package.json"),
      );
      if (pkg) allNodePkgs.push(pkg);
    }
  }

  // Also check root-level Python deps
  const rootPyDeps = parsePythonDeps(root);
  allPythonDeps.push(...rootPyDeps);

  const repoUrl = detectRemoteUrl(root);
  const provider = detectGitProvider(repoUrl);
  const giteaInfo = provider === "gitea" && repoUrl ? parseGiteaRemote(repoUrl) : undefined;

  const git: GitInfo = {
    baseBranch: detectBaseBranch(root),
    remote: "origin",
    repoUrl,
    provider,
    giteaApiUrl: giteaInfo?.apiUrl,
    giteaRepo: giteaInfo?.repo,
  };

  const productSpec = findProductSpec(root);

  return {
    root,
    name: detectProjectName(root),
    description: detectProjectDescription(root),
    isMonorepo,
    packageManager,
    workspaces,
    stack: detectStack(root, workspaces, allNodePkgs, allPythonDeps),
    git,
    productSpec: productSpec || "",
    sprintsDir: findSprintsDir(root),
    docs: findDocs(root),
  };
}
