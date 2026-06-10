import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ralph-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns null when no config file exists", () => {
    expect(loadConfig(root)).toBeNull();
  });

  it("parses spec, baseBranch, and onVerifyFailure", () => {
    writeFileSync(
      join(root, ".ralph.yaml"),
      "spec: docs/SPEC.md\nbaseBranch: dev\nonVerifyFailure: block\n",
    );
    expect(loadConfig(root)).toEqual({
      spec: "docs/SPEC.md",
      baseBranch: "dev",
      onVerifyFailure: "block",
    });
  });

  it("ignores invalid onVerifyFailure values", () => {
    writeFileSync(join(root, ".ralph.yaml"), "onVerifyFailure: yolo\n");
    expect(loadConfig(root)?.onVerifyFailure).toBeUndefined();
  });
});

describe("saveConfig", () => {
  it("round-trips onVerifyFailure and merges with existing values", () => {
    saveConfig(root, { spec: "SPEC.md" });
    saveConfig(root, { onVerifyFailure: "draft-pr" });

    const content = readFileSync(join(root, ".ralph.yaml"), "utf-8");
    expect(content).toContain("spec: SPEC.md");
    expect(content).toContain("onVerifyFailure: draft-pr");
    expect(loadConfig(root)).toEqual({
      spec: "SPEC.md",
      onVerifyFailure: "draft-pr",
    });
  });
});
