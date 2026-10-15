import { assertSkillShadowMode, ProxyClient } from "../src/proxyClient.js";

const noProcess = {
  startProcess: () => ({ exited: () => true }),
  builtAt: () => undefined,
};

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
  test("rejects reuse of a proxy with a different shadow opt-in setting", () => {
    expect(() => assertSkillShadowMode({ skill_shadow_enabled: true }, false)).toThrow("different skill shadow setting");
    expect(() => assertSkillShadowMode({ skill_shadow_enabled: false }, true)).toThrow("different skill shadow setting");
    expect(() => assertSkillShadowMode({ skill_shadow_enabled: true }, true)).not.toThrow();
  });
  test("reuses a running proxy without starting another", async () => {
    const { state, fetch } = fakeProxy({ up: true });
    const client = new ProxyClient(5590, {
      ...noProcess,
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
      ...noProcess,
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
      ...noProcess,
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
    const client = new ProxyClient(5590, { ...noProcess, fetch });

    await expect(client.probe()).rejects.toThrow(
      "Port 5590 is used by another program",
    );
  });

  test("flags a proxy started before the last build", () => {
    const client = new ProxyClient(5590, {
      ...noProcess,
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

describe("ProxyClient.watch", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("restarts the proxy when a tick finds it down", async () => {
    const { state, fetch } = fakeProxy({ up: false });
    const client = new ProxyClient(5590, {
      ...noProcess,
      fetch,
      startProcess: () => {
        state.starts += 1;
        state.up = true;
        return { exited: () => false };
      },
      sleep: async () => undefined,
    });

    const stopWatching = client.watch(1_000);
    await jest.advanceTimersByTimeAsync(999);
    expect(state.starts).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(state.starts).toBe(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(state.starts).toBe(1);
    stopWatching();
  });

  test("does not start a second check while one is still running", async () => {
    const { state, fetch } = fakeProxy({ up: false });
    let finishStart = () => undefined as void;
    const client = new ProxyClient(5590, {
      ...noProcess,
      fetch,
      startProcess: () => {
        state.starts += 1;
        return { exited: () => false };
      },
      sleep: () =>
        new Promise<void>((done) => {
          finishStart = () => {
            state.up = true;
            done();
          };
        }),
    });

    const stopWatching = client.watch(1_000);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(state.starts).toBe(1);
    finishStart();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(state.starts).toBe(1);
    stopWatching();
  });

  test("keeps ticking after a failed restart", async () => {
    const { state, fetch } = fakeProxy({ up: false });
    const client = new ProxyClient(5590, {
      ...noProcess,
      fetch,
      startProcess: () => {
        state.starts += 1;
        return { exited: () => true };
      },
    });

    const stopWatching = client.watch(1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(state.starts).toBe(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(state.starts).toBe(2);
    stopWatching();
  });

  test("stops ticking once the returned function is called", async () => {
    const { state, fetch } = fakeProxy({ up: false });
    const client = new ProxyClient(5590, {
      ...noProcess,
      fetch,
      startProcess: () => {
        state.starts += 1;
        return { exited: () => true };
      },
    });

    client.watch(1_000)();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(state.starts).toBe(0);
  });
});

describe("ProxyClient.stop", () => {
  let kill: jest.SpiedFunction<typeof process.kill>;
  beforeEach(() => {
    kill = jest.spyOn(process, "kill").mockImplementation(() => true);
  });
  afterEach(() => kill.mockRestore());

  test("sends SIGTERM to the pid the proxy reports", async () => {
    const { fetch } = fakeProxy({ up: true });
    await new ProxyClient(5590, { ...noProcess, fetch }).stop();

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(42, "SIGTERM");
  });

  test("does nothing when no proxy answers", async () => {
    const { fetch } = fakeProxy({ up: false });
    await new ProxyClient(5590, { ...noProcess, fetch }).stop();

    expect(kill).not.toHaveBeenCalled();
  });

  test("does nothing when another program holds the port", async () => {
    const { fetch } = fakeProxy({ up: true, body: { pid: 7 } });
    await new ProxyClient(5590, { ...noProcess, fetch }).stop();

    expect(kill).not.toHaveBeenCalled();
  });
});
