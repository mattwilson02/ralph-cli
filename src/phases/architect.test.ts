import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadArchitecture, approveArchitecture } from "./architect.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ralph-arch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeArch(content: string): void {
  writeFileSync(join(root, "ARCHITECTURE.md"), content);
}

describe("loadArchitecture", () => {
  it("returns null when no ARCHITECTURE.md exists", () => {
    expect(loadArchitecture(root)).toBeNull();
  });

  it("reads draft status from frontmatter", () => {
    writeArch("---\nstatus: draft\n---\n\n# Architecture\n");
    expect(loadArchitecture(root)?.status).toBe("draft");
  });

  it("reads approved status from frontmatter", () => {
    writeArch("---\nstatus: approved\n---\n\n# Architecture\n");
    expect(loadArchitecture(root)?.status).toBe("approved");
  });

  it("treats human-authored files without frontmatter as approved", () => {
    writeArch("# Architecture\n\nWe use hexagonal everything.\n");
    expect(loadArchitecture(root)?.status).toBe("approved");
  });
});

describe("approveArchitecture", () => {
  it("flips draft to approved and preserves the body", () => {
    writeArch("---\nstatus: draft\n---\n\n# Architecture\n\nStack: TS\n");
    expect(approveArchitecture(root)).toBe(true);

    const content = readFileSync(join(root, "ARCHITECTURE.md"), "utf-8");
    expect(content).toContain("status: approved");
    expect(content).not.toContain("status: draft");
    expect(content).toContain("Stack: TS");
    expect(loadArchitecture(root)?.status).toBe("approved");
  });

  it("returns false when there is nothing to approve", () => {
    expect(approveArchitecture(root)).toBe(false);
    writeArch("---\nstatus: approved\n---\n\n# Architecture\n");
    expect(approveArchitecture(root)).toBe(false);
  });
});
