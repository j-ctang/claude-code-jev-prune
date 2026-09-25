/** Health of a running Jev Prune proxy, as reported by GET /health. */
export interface ProxyHealth {
  pid?: number;
  prunes?: number;
  tokens_removed?: number;
  started_at?: string;
}

/** Returns the running proxy's health, undefined if the port is free. */
export async function probe(baseUrl: string): Promise<ProxyHealth | undefined> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`);
  } catch {
    return undefined;
  }
  const body = (await response.json().catch(() => undefined)) as
    (ProxyHealth & { status?: unknown; proxy_version?: unknown }) | undefined;
  if (body?.status !== "ok" || typeof body.proxy_version !== "string") {
    throw new Error(
      `Port ${new URL(baseUrl).port} is used by another program. Set PORT in .env.`,
    );
  }
  return body;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}K` : String(tokens);
}
