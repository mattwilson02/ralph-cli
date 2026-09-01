import { describe, it, expect } from "vitest";
import { applyRalphIgnores } from "./git.js";

/** The rules the governance judge depends on being right. */
const EVIDENCE_RULES = [".ralph/*", "!.ralph/evidence/"];

function rules(content: string): string[] {
  return content.split("\n").map((l) => l.trim());
}

describe("applyRalphIgnores — the evidence ledger must reach the repo", () => {
  it("migrates a blanket .ralph/ rule, which is what hid the audit trail", () => {
    const before = ["node_modules/", "ralph.log", ".ralph-state.json", ".ralph/"].join("\n");

    const after = applyRalphIgnores(before);

    expect(after).not.toBeNull();
    expect(rules(after!)).toEqual(expect.arrayContaining(EVIDENCE_RULES));
    expect(rules(after!)).not.toContain(".ralph/");
  });

  it("keeps the negation AFTER the exclusion — git cannot re-include from inside an excluded directory", () => {
    const after = applyRalphIgnores(".ralph/")!;
    const lines = rules(after);

    expect(lines.indexOf(".ralph/*")).toBeLessThan(lines.indexOf("!.ralph/evidence/"));
  });

  it("migrates the extensionless form too", () => {
    const after = applyRalphIgnores("node_modules/\n.ralph")!;

    expect(rules(after)).toEqual(expect.arrayContaining(EVIDENCE_RULES));
    expect(rules(after)).not.toContain(".ralph");
  });

  it("adds every missing rule to a .gitignore that has never seen Ralph", () => {
    const after = applyRalphIgnores("node_modules/\ndist/\n")!;

    expect(rules(after)).toEqual(
      expect.arrayContaining(["ralph.log", ".ralph-state.json", ...EVIDENCE_RULES]),
    );
    expect(after).toContain("# Ralph working files");
  });

  it("returns null when the rules are already correct, so sprints stay quiet", () => {
    const content = ["node_modules/", "ralph.log", ".ralph-state.json", ...EVIDENCE_RULES].join("\n");

    expect(applyRalphIgnores(content)).toBeNull();
  });

  it("does not mistake `.ralph/*` for the blanket rule on a second pass", () => {
    const once = applyRalphIgnores(".ralph/")!;

    // Idempotence is the whole point: ensureGitignore runs on every commit.
    expect(applyRalphIgnores(once)).toBeNull();
  });

  it("leaves unrelated rules alone", () => {
    const after = applyRalphIgnores("node_modules/\n.env\ncoverage/\n.ralph/")!;

    expect(rules(after)).toEqual(expect.arrayContaining(["node_modules/", ".env", "coverage/"]));
  });

  it("still ignores the transient files — only evidence is re-included", () => {
    const after = applyRalphIgnores(".ralph/")!;

    expect(rules(after)).toContain("ralph.log");
    expect(rules(after)).toContain(".ralph-state.json");
  });
});
