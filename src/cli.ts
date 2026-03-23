import { createRequire } from "node:module";
import { Command } from "commander";
import { init } from "./commands/init.js";
import { run } from "./commands/run.js";
import { spec } from "./commands/spec.js";
import { watchCommand } from "./commands/watch.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// Ensure all child processes are killed when Ralph exits.
// Without this, spawned Claude agents can become orphaned (PPID=1)
// and burn CPU/tokens indefinitely if the parent terminal closes.
function killAllChildren() {
  try {
    // Kill our entire process group
    process.kill(-process.pid, "SIGTERM");
  } catch {
    // process group kill may fail — not critical
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    killAllChildren();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

process.on("exit", killAllChildren);

// Detect orphaned process — if parent dies (PPID becomes 1), exit
const parentPid = process.ppid;
if (parentPid !== undefined) {
  const orphanCheck = setInterval(() => {
    if (process.ppid !== parentPid) {
      killAllChildren();
      process.exit(1);
    }
  }, 5000);
  orphanCheck.unref();
}

const program = new Command();

program
  .name("ralph")
  .description(
    "Autonomous AI dev agent. Point it at a codebase and product spec — it builds, verifies, and ships.",
  )
  .version(pkg.version);

program
  .command("init")
  .description("Scan project, detect stack, and save configuration to .ralph.yaml")
  .argument("[dir]", "project directory", ".")
  .option("--spec <path>", "set the product spec path (saved to .ralph.yaml)")
  .option("--base-branch <branch>", "set the base branch (saved to .ralph.yaml)")
  .action((dir: string, opts: { spec?: string; baseBranch?: string }) => {
    init(dir, opts);
  });

program
  .command("run")
  .description("Start autonomous sprint execution against your codebase")
  .option("-d, --dir <path>", "project directory", ".")
  .option("-s, --sprint <n>", "starting sprint number")
  .option("--max-sprints <n>", "maximum sprints to run", "10")
  .option("--single", "run a single sprint then stop")
  .option("--improve", "specless mode — analyze codebase and fix quality issues")
  .option("-t, --task <description>", "directed task — skip spec writer, build inline spec from description")
  .option("--spec <path>", "path to product spec file")
  .option("--max-fix-attempts <n>", "max fix attempts per verify cycle", "3")
  .option("--sprint-timeout <minutes>", "max time per sprint in minutes", "45")
  .option("--spec-model <model>", "model for spec writer")
  .option("--build-model <model>", "model for builder agents")
  .option("--fix-model <model>", "model for fix agents")
  .option("--audit-model <model>", "model for auditor")
  .action(async (flags) => {
    try {
      await run(flags);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nRalph failed: ${message}`);
      if (process.env.DEBUG) console.error(err);
      process.exit(1);
    }
  });

program
  .command("spec")
  .description("Generate a product spec from your existing codebase")
  .argument("[dir]", "project directory", ".")
  .action(async (dir: string) => {
    try {
      await spec(dir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nRalph failed: ${message}`);
      if (process.env.DEBUG) console.error(err);
      process.exit(1);
    }
  });

program
  .command("watch")
  .description("Live TUI — watch Ralph work with animated ASCII art and pretty logs")
  .argument("[dir]", "project directory", ".")
  .action(async (dir: string) => {
    try {
      await watchCommand(dir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nRalph failed: ${message}`);
      if (process.env.DEBUG) console.error(err);
      process.exit(1);
    }
  });

program.parse();
