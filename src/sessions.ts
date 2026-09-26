import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SHARED_MARKER = ".shared";

/**
 * Tracks which launcher processes share one proxy. The last launcher to exit
 * stops the proxy, so a second terminal never loses its proxy early.
 */
export function registerSession(
  directory: string,
  pid: number,
  project = "",
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (liveSessions(directory).length === 0)
    rmSync(join(directory, SHARED_MARKER), { force: true });
  writeFileSync(join(directory, String(pid)), project, { mode: 0o600 });
  if (liveSessions(directory).length > 1)
    writeFileSync(join(directory, SHARED_MARKER), "", { mode: 0o600 });
}

/** True after this proxy has had more than one live launcher. */
export function wasShared(directory: string): boolean {
  return existsSync(join(directory, SHARED_MARKER));
}

/** Project directories advertised by live launchers sharing this proxy. */
export function readSessionProjects(directory: string): string[] {
  const projects = new Set<string>();
  for (const pid of liveSessions(directory)) {
    try {
      const project = readFileSync(join(directory, String(pid)), "utf8").trim();
      if (project) projects.add(project);
    } catch {
      // A launcher may exit between listing and reading.
    }
  }
  return [...projects];
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
