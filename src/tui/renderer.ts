import chalk from "chalk";
import terminalImage from "terminal-image";
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RALPH_QUOTES, PHASE_LABELS, PHASE_ORDER } from "./frames.js";
import type { SprintState } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class TUIRenderer {
  private root: string;
  private logPath: string;
  private statePath: string;
  private lastLogSize = 0;
  private logFd?: number;
  private logWatcher?: ReturnType<typeof watch>;
  private stateWatcher?: ReturnType<typeof watch>;
  private state: SprintState | null = null;
  private lastPhase = "";
  private stopped = false;

  constructor(root: string) {
    this.root = root;
    this.logPath = join(root, "ralph.log");
    this.statePath = join(root, ".ralph-state.json");
  }

  async start(): Promise<void> {
    // Print Ralph banner
    await this.printBanner();

    // Print current state
    this.loadState();
    this.printStateHeader();

    // Print existing log tail (last 20 lines)
    this.printExistingLogTail();

    // Start watching for new content
    this.watchLog();
    this.watchState();

    // Handle exit
    const cleanup = () => this.stop();
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Keep process alive
    await new Promise(() => {});
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.logWatcher) this.logWatcher.close();
    if (this.stateWatcher) this.stateWatcher.close();
    if (this.logFd !== undefined) closeSync(this.logFd);
    console.log(chalk.gray("\n👋 Ralph Watch stopped."));
    process.exit(0);
  }

  private async printBanner(): Promise<void> {
    // Try to render the actual Ralph image
    const candidates = [
      join(__dirname, "..", "..", "docs", "ralph.png"),
      join(__dirname, "..", "docs", "ralph.png"),
    ];

    let printed = false;
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const buf = readFileSync(p);
        const rendered = await terminalImage.buffer(buf, {
          width: 28,
          height: 16,
          preserveAspectRatio: true,
        });
        console.log(rendered);
        printed = true;
        break;
      } catch {
        // Fall through to text fallback
      }
    }

    if (!printed) {
      console.log(chalk.yellow.bold("\n  RALPH"));
    }

    // Random quote
    const quote = RALPH_QUOTES[Math.floor(Math.random() * RALPH_QUOTES.length)];
    console.log(chalk.italic.gray(`  ${quote}\n`));
  }

  private loadState(): void {
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      this.state = JSON.parse(raw) as SprintState;
    } catch {
      this.state = null;
    }
  }

  private detectSprintFromLog(): { sprint: number; phase: string } | null {
    try {
      const content = readFileSync(this.logPath, "utf-8");
      const lines = content.split("\n").reverse();
      let sprint: number | null = null;
      let phase = "spec";

      for (const line of lines) {
        if (!sprint) {
          const sprintMatch = line.match(/SPRINT\s+(\d+)/);
          if (sprintMatch) sprint = parseInt(sprintMatch[1], 10);
        }
        if (line.includes("Writing spec")) phase = "spec";
        if (line.includes("builder")) phase = "build";
        if (line.includes("verification checks (build)")) phase = "build_verify";
        if (line.includes("verification checks (full)")) phase = "full_verify";
        if (line.includes("compliance audit")) phase = "audit";
        if (line.includes("Committing")) phase = "pr";
        if (sprint) break;
      }

      return sprint ? { sprint, phase } : null;
    } catch {
      return null;
    }
  }

  private printStateHeader(): void {
    if (!this.state) {
      // Try to detect from log output
      const logState = this.detectSprintFromLog();
      if (logState) {
        console.log(
          chalk.bold.white(`  Sprint ${logState.sprint}`) +
          chalk.gray(" · ") +
          chalk.bold.magenta(PHASE_LABELS[logState.phase] || logState.phase),
        );
        console.log(chalk.yellow("─".repeat(process.stdout.columns || 80)));
        return;
      }
      console.log(chalk.gray("  Waiting for Ralph to start...\n"));
      return;
    }

    const phaseLabel = PHASE_LABELS[this.state.phase] || this.state.phase;
    console.log(
      chalk.bold.white(`  Sprint ${this.state.sprint}`) +
      chalk.gray(" · ") +
      chalk.white(this.state.specName || "unknown") +
      chalk.gray(" · ") +
      chalk.bold.magenta(phaseLabel),
    );

    if (this.state.branchName) {
      console.log(chalk.green(`  ⎇ ${this.state.branchName}`));
    }

    // Phase progress bar
    console.log(`  ${this.buildPhaseBar()}`);
    console.log(chalk.yellow("─".repeat(process.stdout.columns || 80)));

    this.lastPhase = this.state.phase;
  }

  private buildPhaseBar(): string {
    const currentPhase = this.state?.phase || "";
    const currentIdx = PHASE_ORDER.indexOf(currentPhase);

    return PHASE_ORDER.map((phase, i) => {
      const label = PHASE_LABELS[phase] || phase;
      if (i < currentIdx) return chalk.green(`✓ ${label}`);
      if (i === currentIdx) return chalk.bold.cyan(`● ${label}`);
      return chalk.dim(`○ ${label}`);
    }).join(chalk.gray(" → "));
  }

  private printExistingLogTail(): void {
    try {
      const content = readFileSync(this.logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      const tail = lines.slice(-20);
      for (const line of tail) {
        console.log(this.formatLogLine(line));
      }
      this.lastLogSize = statSync(this.logPath).size;
    } catch {
      // No log yet
    }
  }

  private watchLog(): void {
    try {
      this.logFd = openSync(this.logPath, "r");
    } catch {
      // File doesn't exist yet
    }

    const startWatching = () => {
      this.logWatcher = watch(this.logPath, () => {
        this.printNewLogLines();
      });
    };

    try {
      startWatching();
    } catch {
      // Poll until file exists
      const poll = setInterval(() => {
        try {
          this.logFd = openSync(this.logPath, "r");
          startWatching();
          clearInterval(poll);
        } catch { /* waiting */ }
      }, 2000);
    }
  }

  private printNewLogLines(): void {
    try {
      const currentSize = statSync(this.logPath).size;
      if (currentSize <= this.lastLogSize) {
        if (currentSize < this.lastLogSize) {
          this.lastLogSize = 0; // File was truncated
        }
        return;
      }

      const bytesToRead = currentSize - this.lastLogSize;
      const buffer = Buffer.alloc(bytesToRead);

      if (this.logFd === undefined) {
        this.logFd = openSync(this.logPath, "r");
      }

      readSync(this.logFd, buffer, 0, bytesToRead, this.lastLogSize);
      this.lastLogSize = currentSize;

      const lines = buffer.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        console.log(this.formatLogLine(line));
      }
    } catch {
      // Will retry on next event
    }
  }

  private printQuote(): void {
    const quote = RALPH_QUOTES[Math.floor(Math.random() * RALPH_QUOTES.length)];
    console.log(chalk.italic.gray(`  "${quote}"\n`));
  }

  private watchState(): void {
    const onStateChange = () => {
      this.loadState();
      if (this.state && this.state.phase !== this.lastPhase) {
        this.lastPhase = this.state.phase;
        console.log(chalk.yellow("\n─".repeat(process.stdout.columns || 80)));
        this.printQuote();
        this.printStateHeader();
      }
    };

    try {
      this.stateWatcher = watch(this.statePath, onStateChange);
    } catch {
      const poll = setInterval(() => {
        try {
          this.stateWatcher = watch(this.statePath, onStateChange);
          clearInterval(poll);
          onStateChange();
        } catch { /* waiting */ }
      }, 2000);
    }
  }

  private formatLogLine(raw: string): string {
    // Parse timestamp
    const tsMatch = raw.match(/^\[(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}))\.\d+Z\]\s*(.*)/);
    let time = "";
    let msg = raw;

    if (tsMatch) {
      time = tsMatch[2];
      msg = tsMatch[3];
    }

    const timeStr = time ? chalk.dim.blue(time) + " " : "";

    // Color by content
    if (msg.includes("PASS:")) {
      return timeStr + chalk.green("✓") + " " + chalk.white(msg.replace("PASS:", "").trim());
    }
    if (msg.includes("FAIL:")) {
      return timeStr + chalk.red("✗") + " " + chalk.red(msg.replace("FAIL:", "").trim());
    }
    if (msg.includes("════")) {
      return timeStr + chalk.yellow(msg);
    }
    if (msg.startsWith("  $")) {
      return timeStr + chalk.dim(msg);
    }
    if (msg.includes("Agent completed")) {
      return timeStr + chalk.green("⚡") + " " + chalk.white(msg);
    }
    if (msg.includes("Agent hit max turns") || msg.includes("Agent idle")) {
      return timeStr + chalk.yellow("⚠") + " " + chalk.yellow(msg);
    }
    if (msg.includes("Fix attempt")) {
      return timeStr + chalk.yellow("🔧 ") + chalk.white(msg);
    }
    if (msg.includes("SPRINT")) {
      return timeStr + chalk.bold.cyan(msg);
    }
    if (msg.includes("timeout") || msg.includes("Timeout")) {
      return timeStr + chalk.red("⏱ ") + chalk.yellow(msg);
    }
    if (msg.includes("PR created") || msg.includes("pr_url")) {
      return timeStr + chalk.green("🚀 ") + chalk.white(msg);
    }
    if (msg.includes("Committing")) {
      return timeStr + chalk.green("📦 ") + chalk.white(msg);
    }
    if (msg.includes("complete!")) {
      return timeStr + chalk.green("✅ ") + chalk.bold.white(msg);
    }
    if (msg.includes("Phase")) {
      return timeStr + chalk.cyan("▸ ") + chalk.white(msg);
    }
    return timeStr + chalk.white(msg);
  }
}
