import { ProxyClient } from "../src/proxyClient.js";

const healthy = { status: "ok", proxy_version: "1.0.0", pid: 42 };

/** A fake network where the proxy answers once `up` is true. */
function fakeProxy(options: { up: boolean; body?: unknown }) {
  const state = { ...options, starts: 0 };
  const fetch = (async () => {
    if (!state.up) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(state.body ?? healthy));
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

describe("ProxyClient", () => {
  test("reuses a running proxy without starting another", async () => {
    const { state, fetch } = fakeProxy({ up: true });
    const client = new ProxyClient(5590, {
      fetch,
      startProcess: () => {
        state.starts += 1;
        return { exited: () => false };
      },
    });

    expect(await client.ensureRunning()).toMatchObject({ pid: 42 });
    expect(state.starts).toBe(0);
  });

  test("starts the proxy and waits until it answers", async () => {
    const { state, fetch } = fakeProxy({ up: false });
    let waits = 0;
    const client = new ProxyClient(5590, {
      fetch,
      startProcess: () => {
        state.starts += 1;
        return { exited: () => false };
      },
      sleep: async () => {
        waits += 1;
        if (waits === 3) state.up = true;
      },
    });

    expect(await client.ensureRunning()).toMatchObject({ pid: 42 });
    expect(state.starts).toBe(1);
    expect(waits).toBe(3);
  });

  test("gives up when the proxy process exits", async () => {
    const { fetch } = fakeProxy({ up: false });
    let exited = false;
    const client = new ProxyClient(5590, {
      fetch,
      startProcess: () => ({ exited: () => exited }),
      sleep: async () => {
        exited = true;
      },
    });

    await expect(client.ensureRunning()).rejects.toThrow("did not start");
  });

  test("reports another program on the port", async () => {
    const { fetch } = fakeProxy({ up: true, body: { hello: "world" } });
    const client = new ProxyClient(5590, { fetch });

    await expect(client.probe()).rejects.toThrow(
      "Port 5590 is used by another program",
    );
  });

  test("flags a proxy started before the last build", () => {
    const client = new ProxyClient(5590, {
      builtAt: () => Date.parse("2026-09-24T12:00:00Z"),
    });

    expect(client.isOutdated({ started_at: "2026-09-24T11:00:00Z" })).toBe(
      true,
    );
    expect(client.isOutdated({ started_at: "2026-09-24T13:00:00Z" })).toBe(
      false,
    );
  });
});
