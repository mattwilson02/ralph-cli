import { describe, it, expect } from "vitest";
import { evaluateToolUse, createGuardrailHook } from "./guardrails.js";
import type { GuardrailPolicy, ToolUseEntry } from "./guardrails.js";

const root = "/repo";

function builderPolicy(overrides: Partial<GuardrailPolicy> = {}): GuardrailPolicy {
  return {
    role: "builder",
    root,
    writePaths: ["apps/api"],
    declaredPaths: ["apps/api/src/users.ts"],
    ...overrides,
  };
}

describe("evaluateToolUse — Bash", () => {
  const policy = builderPolicy();

  it.each([
    "git commit -m 'sneaky'",
    "git push origin main",
    "git rebase main",
    "gh pr create --title x",
    "npm publish",
    "git config user.name evil",
  ])("denies: %s", (command) => {
    expect(evaluateToolUse(policy, "Bash", { command })).not.toBeNull();
  });

  it.each([
    "npm test",
    "git diff",
    "git status",
    "git log --oneline",
    "npm install lodash",
  ])("allows: %s", (command) => {
    expect(evaluateToolUse(policy, "Bash", { command })).toBeNull();
  });
});

describe("evaluateToolUse — Write/Edit", () => {
  it("denies writes to CI workflows unless declared", () => {
    const policy = builderPolicy({ writePaths: undefined });
    expect(
      evaluateToolUse(policy, "Write", { file_path: ".github/workflows/ci.yml" }),
    ).not.toBeNull();

    const declared = builderPolicy({
      writePaths: undefined,
      declaredPaths: [".github/workflows/ci.yml"],
    });
    expect(
      evaluateToolUse(declared, "Write", { file_path: ".github/workflows/ci.yml" }),
    ).toBeNull();
  });

  it("denies .env writes even when declared paths cover everything else", () => {
    const policy = builderPolicy({ writePaths: undefined, declaredPaths: ["src/"] });
    expect(evaluateToolUse(policy, "Write", { file_path: ".env" })).not.toBeNull();
    expect(evaluateToolUse(policy, "Write", { file_path: ".env.local" })).not.toBeNull();
  });

  it("restricts writes to the workspace scope plus declared paths", () => {
    const policy = builderPolicy();
    expect(
      evaluateToolUse(policy, "Write", { file_path: "apps/api/src/new.ts" }),
    ).toBeNull();
    expect(
      evaluateToolUse(policy, "Edit", { file_path: "apps/web/src/page.tsx" }),
    ).not.toBeNull();
    // Declared file outside the workspace scope is allowed
    expect(
      evaluateToolUse(
        builderPolicy({ declaredPaths: ["apps/web/src/page.tsx"] }),
        "Edit",
        { file_path: "apps/web/src/page.tsx" },
      ),
    ).toBeNull();
  });

  it("normalizes absolute paths against the repo root", () => {
    const policy = builderPolicy();
    expect(
      evaluateToolUse(policy, "Write", { file_path: "/repo/apps/api/src/x.ts" }),
    ).toBeNull();
    expect(
      evaluateToolUse(policy, "Write", { file_path: "/repo/apps/web/src/x.ts" }),
    ).not.toBeNull();
  });

  it("always allows Ralph's own working directory", () => {
    const policy = builderPolicy();
    expect(
      evaluateToolUse(policy, "Write", { file_path: ".ralph/handoff/report.md" }),
    ).toBeNull();
  });

  it("writePaths of '.' allows the whole repo", () => {
    const policy = builderPolicy({ writePaths: ["."] });
    expect(evaluateToolUse(policy, "Write", { file_path: "anything/x.ts" })).toBeNull();
  });
});

describe("createGuardrailHook", () => {
  it("returns a deny decision and logs the entry", async () => {
    const entries: ToolUseEntry[] = [];
    const hook = createGuardrailHook(
      builderPolicy({ onToolUse: (e) => entries.push(e) }),
    );

    const denied = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push --force" },
    });
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(entries[0].denied).toBe(true);

    const allowed = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    expect(allowed.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(entries[1].denied).toBe(false);
  });
});
