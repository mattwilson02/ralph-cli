import { Command } from "commander";
import { init } from "./commands/init.js";
import { run } from "./commands/run.js";
import { spec } from "./commands/spec.js";

const program = new Command();

program
  .name("ralph")
  .description("Autonomous AI dev agent — builds, verifies, and ships.")
  .version("0.1.0");

program
  .command("init")
  .description("Scan a project and display detected configuration")
  .argument("[dir]", "project directory", ".")
  .option("--spec <path>", "set the product spec path (saved to .ralph.yaml)")
  .option("--base-branch <branch>", "set the base branch (saved to .ralph.yaml)")
  .action((dir: string, opts: { spec?: string; baseBranch?: string }) => {
    init(dir, opts);
  });

program
  .command("run")
  .description("Start autonomous sprint execution")
  .option("-d, --dir <path>", "project directory", ".")
  .option("-s, --sprint <n>", "starting sprint number", "1")
  .option("--max-sprints <n>", "maximum sprints to run", "10")
  .option("--single", "run a single sprint then stop")
  .option("-t, --task <description>", "directed task — skip spec writer, build inline spec from description")
  .option("--spec <path>", "path to product spec file")
  .option("--max-fix-attempts <n>", "max fix attempts per verify cycle", "3")
  .option("--spec-model <model>", "model for spec writer")
  .option("--build-model <model>", "model for builder agents")
  .option("--fix-model <model>", "model for fix agents")
  .option("--audit-model <model>", "model for auditor")
  .action(async (flags) => {
    await run(flags);
  });

program
  .command("spec")
  .description("Generate a draft product spec from the codebase")
  .argument("[dir]", "project directory", ".")
  .action(async (dir: string) => {
    await spec(dir);
  });

program.parse();
