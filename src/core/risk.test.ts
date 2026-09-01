import { describe, it, expect } from "vitest";
import { assessRisk, parseDeclaredFiles, resolveAutonomy } from "./risk.js";
import type { ProjectContext } from "../context/types.js";

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    root: "/tmp/test",
    name: "test-app",
    description: "",
    isMonorepo: false,
    packageManager: "npm",
    workspaces: [
      {
        name: "app",
        path: ".",
        type: "backend",
        checks: [{ name: "Tests", cmd: "npm test", cwd: "." }],
        dependencies: [],
      },
    ],
    stack: { languages: ["typescript"], frameworks: [] },
    git: { baseBranch: "main", remote: "origin", provider: "github" },
    productSpec: "",
    sprintsDir: "/tmp/test/docs/sprints",
    docs: [],
    ...overrides,
  };
}

describe("assessRisk", () => {
  it("scores a plain feature spec as low risk", () => {
    const risk = assessRisk(makeCtx(), "## Tasks\nAdd a date formatter to `src/util/dates.ts`");
    expect(risk.level).toBe("low");
    expect(risk.reasons.length).toBeGreaterThan(0);
  });

  it("scores auth work as high risk", () => {
    const risk = assessRisk(makeCtx(), "Implement authentication middleware");
    expect(risk.level).toBe("high");
    expect(risk.reasons.join(" ")).toContain("auth");
  });

  it("scores migrations as high risk", () => {
    const risk = assessRisk(makeCtx(), "Add a database migration for the users table");
    expect(risk.level).toBe("high");
  });

  it("scores CI workflow paths as high risk", () => {
    const risk = assessRisk(makeCtx(), "Update `.github/workflows/ci.yml` caching");
    expect(risk.level).toBe("high");
  });

  it("scores greenfield as high risk", () => {
    const risk = assessRisk(makeCtx(), "Build a hello world", { greenfield: true });
    expect(risk.level).toBe("high");
    expect(risk.reasons.join(" ")).toContain("Greenfield");
  });

  it("scores no-checks workspaces as high risk", () => {
    const ctx = makeCtx({
      workspaces: [
        { name: "app", path: ".", type: "backend", checks: [], dependencies: [] },
      ],
    });
    const risk = assessRisk(ctx, "Add a small helper");
    expect(risk.level).toBe("high");
    expect(risk.reasons.join(" ")).toContain("No verification checks");
  });

  it("scores large declared changesets as medium risk", () => {
    const files = Array.from({ length: 13 }, (_, i) => `- \`src/f${i}.ts\``).join("\n");
    const risk = assessRisk(makeCtx(), `## Declared Files\n${files}`);
    expect(risk.level).toBe("medium");
  });
});

describe("parseDeclaredFiles", () => {
  it("parses the Declared Files section", () => {
    const spec = [
      "## Tasks",
      "Modify `src/should-not-count.ts` here",
      "",
      "## Declared Files",
      "- `src/api/users.ts`",
      "- `src/api/users.test.ts`",
      "- `src/components/UserList/`",
    ].join("\n");
    expect(parseDeclaredFiles(spec)).toEqual([
      "src/api/users.ts",
      "src/api/users.test.ts",
      "src/components/UserList/",
    ]);
  });

  it("stops at the next section header", () => {
    const spec = [
      "## Declared Files",
      "- `src/a.ts`",
      "## Definition of Done",
      "- `src/should-not-count.ts` is green",
    ].join("\n");
    expect(parseDeclaredFiles(spec)).toEqual(["src/a.ts"]);
  });

  it("falls back to scanning the whole spec when no section exists", () => {
    const spec = "Modify `src/a.ts` and add tests in `src/a.test.ts`. Use the `UserService` pattern.";
    const files = parseDeclaredFiles(spec);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/a.test.ts");
    expect(files).not.toContain("UserService");
  });
});

describe("resolveAutonomy", () => {
  it("honours an explicit human choice", () => {
    expect(resolveAutonomy("auto")).toBe("auto");
    expect(resolveAutonomy("plan-first")).toBe("plan-first");
  });

  it("defaults to auto — risk no longer opens the gate", () => {
    // The grader saturates on any domain-specific codebase, so gating on it
    // gated on everything: 14 of 14 sprints graded high on the IoM CIS run.
    expect(resolveAutonomy(undefined)).toBe("auto");
  });
});
