/**
 * Error whose message is written by this codebase and safe to log.
 * Any other error is logged by name only.
 */
export class PruneError extends Error {
  override name = "PruneError";
}

export function loggableReason(error: unknown): string {
  if (error instanceof PruneError) return error.message;
  if (error instanceof Error) return error.name;
  return "unknown pruning error";
}
