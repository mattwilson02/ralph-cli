import { execSync } from "node:child_process";
import { log } from "./logger.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per command

export function run(
  cmd: string,
  cwd: string,
  env?: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): string {
  log(`  $ ${cmd}`);
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 50 * 1024 * 1024,
    timeout: timeoutMs,
  }).trim();
}

export function runSafe(
  cmd: string,
  cwd: string,
  env?: Record<string, string>,
): { ok: boolean; output: string } {
  try {
    const output = run(cmd, cwd, env);
    return { ok: true, output };
  } catch (err: unknown) {
    const output =
      err instanceof Error
        ? (err as Error & { stdout?: string; stderr?: string }).stdout ||
          (err as Error & { stderr?: string }).stderr ||
          err.message
        : String(err);
    return { ok: false, output };
  }
}
