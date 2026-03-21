import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";

let logStream: WriteStream | null = null;

export function initLogger(root: string): void {
  logStream = createWriteStream(join(root, "ralph.log"), { flags: "a" });
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream?.write(line + "\n");
}

export function closeLogger(): void {
  logStream?.end();
  logStream = null;
}
