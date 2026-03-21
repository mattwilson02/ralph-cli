import { resolve, relative, join } from "node:path";
import { readFileSync } from "node:fs";
import { scanProject } from "../context/scanner.js";
import { loadConfig, saveConfig } from "../config.js";
import { log } from "../util/logger.js";

interface InitOptions {
  spec?: string;
  baseBranch?: string;
}

export function init(dir?: string, opts?: InitOptions): void {
  const root = resolve(dir || ".");

  log("Scanning project...\n");

  const ctx = scanProject(root);
  const existingConfig = loadConfig(root);
  let configChanged = false;
  const newConfig: Record<string, string> = {};

  // --spec flag
  if (opts?.spec) {
    const specPath = resolve(root, opts.spec);
    ctx.productSpec = specPath;
    newConfig.spec = relative(root, specPath);
    configChanged = true;
  } else if (existingConfig?.spec) {
    ctx.productSpec = join(root, existingConfig.spec);
  }

  // --base-branch flag
  if (opts?.baseBranch) {
    ctx.git.baseBranch = opts.baseBranch;
    newConfig.baseBranch = opts.baseBranch;
    configChanged = true;
  } else if (existingConfig?.baseBranch) {
    ctx.git.baseBranch = existingConfig.baseBranch;
  }

  if (configChanged) {
    saveConfig(root, newConfig);
    log(`  Saved config to .ralph.yaml\n`);
  }

  log(`  Project:         ${ctx.name}`);
  log(`  Description:     ${ctx.description || "(none)"}`);
  log(`  Monorepo:        ${ctx.isMonorepo ? "yes" : "no"}`);
  log(`  Package manager: ${ctx.packageManager}`);
  log(`  Languages:       ${ctx.stack.languages.join(", ")}`);
  log(`  Frameworks:      ${ctx.stack.frameworks.join(", ") || "(none)"}`);
  log(`  Database:        ${ctx.stack.database || "(none)"}`);
  log(`  Test runner:     ${ctx.stack.testRunner || "(none)"}`);
  log(`  Linter:          ${ctx.stack.linter || "(none)"}`);
  log(`  Build tool:      ${ctx.stack.buildTool || "(none)"}`);
  log(`  Base branch:     ${ctx.git.baseBranch}`);
  log(`  Product spec:    ${ctx.productSpec || "NOT FOUND"}`);
  log(`  Sprints dir:     ${ctx.sprintsDir}`);
  log("");

  if (ctx.workspaces.length > 0) {
    log("  Workspaces:");
    for (const ws of ctx.workspaces) {
      const framework = ws.framework ? ` (${ws.framework})` : "";
      log(`    ${ws.name} — ${ws.type}${framework} [${ws.path}]`);
      if (ws.checks.length > 0) {
        log(`      Checks: ${ws.checks.map((c) => c.name).join(", ")}`);
      }
    }
    log("");
  }

  // Determine project state and guide the user
  const isGreenfield =
    ctx.workspaces.length === 0 ||
    ctx.workspaces.every((w) => w.checks.length === 0);

  if (isGreenfield && !ctx.productSpec) {
    log("  New project detected. To get started:\n");
    log("  1. Write a product spec with an Architecture section:");
    log("     - What to build (features, user flows)");
    log("     - How to build it (framework, database, patterns)\n");
    log("  2. Point Ralph at it:");
    log("     ralph init --spec PRODUCT_SPEC.md\n");
    log("  3. Run:");
    log("     ralph run --single\n");
    log("  Or generate a draft: ralph spec");
  } else if (isGreenfield && ctx.productSpec) {
    // Check if spec has architecture section
    try {
      const specContent = readFileSync(ctx.productSpec, "utf-8").toLowerCase();
      const hasArch =
        specContent.includes("## architecture") ||
        specContent.includes("## tech") ||
        specContent.includes("## stack") ||
        specContent.includes("## technical");
      if (!hasArch) {
        log("  ⚠ New project — your spec should include an Architecture section.");
        log("    Ralph needs to know the stack, framework, and patterns to scaffold.\n");
      }
    } catch {}
    log("Ready. Run `ralph run --single` to scaffold and build.");
  } else if (!ctx.productSpec) {
    log("  No product spec found. Ralph can still help:\n");
    log("  ralph run --single                     # improvement mode (fix quality issues)");
    log("  ralph run --task \"add input validation\" # directed task");
    log("  ralph spec                             # generate a draft spec");
    log("  ralph init --spec <path>               # set a spec\n");
  } else {
    log("Ready. Run `ralph run` to start sprinting.");
  }
}
