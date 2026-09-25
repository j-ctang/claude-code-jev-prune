import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tracks which launcher processes share one proxy. The last launcher to exit
 * stops the proxy, so a second terminal never loses its proxy early.
 */
export function registerSession(directory: string, pid: number): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, String(pid)), "", { mode: 0o600 });
}

export function unregisterSession(directory: string, pid: number): void {
  rmSync(join(directory, String(pid)), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Returns live launcher PIDs and removes entries left by crashed launchers. */
export function liveSessions(directory: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const live: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (isAlive(pid)) live.push(pid);
    else unregisterSession(directory, pid);
  }
  return live;
}
