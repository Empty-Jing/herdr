import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type Handler = (value?: unknown) => void;
type FakeSocket = ReturnType<typeof createSocket>;

const socketRequests: Record<string, unknown>[] = [];
const metadataRequests: Record<string, unknown>[] = [];
const subscriptions: FakeSocket[] = [];
const remoteRequests: Array<{ url: string; options: RequestInit }> = [];
const plugins: Array<{ dispose?: () => Promise<void> }> = [];
let currentPaneActive = true;
let usagePayload: unknown;
let paneList: Record<string, unknown>[] = [];

function createSocket(onConnect: () => void) {
  const handlers = new Map<string, Set<Handler>>();
  let destroyed = false;
  const socket = {
    write(input: string) {
      const request = JSON.parse(input.trim()) as Record<string, unknown>;
      socketRequests.push(request);
      const method = request.method;
      if (method === "events.subscribe") {
        subscriptions.push(socket);
        queueMicrotask(() => {
          socket.emit("data", `${JSON.stringify({
            id: request.id,
            result: { type: "subscription_started" },
          })}\n`);
        });
      } else if (method === "pane.current") {
        queueMicrotask(() => {
          socket.emit("data", `${JSON.stringify({
            id: request.id,
            result: { type: "pane_current", pane: { focused: currentPaneActive } },
          })}\n`);
        });
      } else if (method === "pane.list") {
        queueMicrotask(() => {
          socket.emit("data", `${JSON.stringify({
            id: request.id,
            result: { type: "pane_list", panes: paneList },
          })}\n`);
        });
      } else if (method === "pane.report_metadata") {
        metadataRequests.push(request);
        queueMicrotask(() => {
          socket.emit("data", `${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
        });
      }
    },
    setTimeout() {},
    on(event: string, handler: Handler) {
      const eventHandlers = handlers.get(event) ?? new Set();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
      return socket;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      socket.emit("close");
    },
    emit(event: string, value?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
  };
  queueMicrotask(onConnect);
  return socket;
}

mock.module("node:net", () => ({
  default: {
    createConnection(_path: string, onConnect: () => void) {
      return createSocket(onConnect);
    },
  },
}));

beforeEach(() => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "test.sock";
  process.env.HERDR_PANE_ID = "test:p1";
  currentPaneActive = true;
  socketRequests.length = 0;
  metadataRequests.length = 0;
  subscriptions.length = 0;
  remoteRequests.length = 0;
  paneList = [];
  usagePayload = {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 5400,
        reset_at: 2_000_000_000,
      },
    },
  };
  globalThis.fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    remoteRequests.push({ url: String(input), options: options ?? {} });
    return new Response(JSON.stringify(usagePayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.dispose?.()));
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  mock.restore();
});

async function loadPlugin(active = true) {
  currentPaneActive = active;
  const { HerdrOpenAIQuotaPlugin } = await import("./herdr-openai-quota.js");
  const plugin = await HerdrOpenAIQuotaPlugin();
  plugins.push(plugin);
  return plugin;
}

function validAuth(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth",
    access: "secret-access-token",
    refresh: "secret-refresh-token",
    expires: Date.now() + 60_000,
    accountId: "secret-account-id",
    ...overrides,
  };
}

async function loadAuth(plugin: Awaited<ReturnType<typeof loadPlugin>>, auth = validAuth()) {
  expect(plugin.auth?.provider).toBe("openai");
  expect(plugin.auth?.methods).toEqual([]);
  await plugin.auth?.loader?.(async () => auth, {});
}

function latestTokens(): Record<string, unknown> {
  const request = metadataRequests.at(-1);
  expect(request?.method).toBe("pane.report_metadata");
  const params = request?.params as Record<string, unknown>;
  return params.tokens as Record<string, unknown>;
}

test("parses a dynamic single window without assuming five hours", async () => {
  const plugin = await loadPlugin();
  await loadAuth(plugin);

  expect(remoteRequests).toHaveLength(1);
  expect(remoteRequests[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
  expect(latestTokens()).toMatchObject({
    quota_status: "ok",
    quota_plan: "plus",
    quota_primary_remaining: "75",
    quota_primary_minutes: "90",
    quota_secondary_remaining: null,
    quota_secondary_minutes: null,
    quota_secondary_reset: null,
  });
});

test("parses camel-case dual windows", async () => {
  usagePayload = {
    planType: "pro",
    rateLimit: {
      limitName: "codex",
      primaryWindow: { usedPercent: 12.5, windowMinutes: 45, resetAt: 1000 },
      secondaryWindow: {
        usedPercent: 60,
        limitWindowSeconds: 172800,
        resetAt: 2000,
      },
    },
    credits: { unlimited: false },
  };
  const plugin = await loadPlugin();
  await loadAuth(plugin);

  expect(latestTokens()).toMatchObject({
    quota_limit_name: "codex",
    quota_primary_remaining: "87.5",
    quota_primary_minutes: "45",
    quota_primary_reset: "1000",
    quota_secondary_remaining: "40",
    quota_secondary_minutes: "2880",
    quota_secondary_reset: "2000",
    quota_unlimited: "false",
  });
});

test("clears tokens when windows are absent", async () => {
  usagePayload = { plan_type: "free", rate_limit: null };
  const plugin = await loadPlugin();
  await loadAuth(plugin);

  expect(latestTokens()).toMatchObject({
    quota_status: "ok",
    quota_primary_remaining: null,
    quota_primary_minutes: null,
    quota_primary_reset: null,
    quota_secondary_remaining: null,
    quota_secondary_minutes: null,
    quota_secondary_reset: null,
  });
});

test("does not fetch while its pane is inactive", async () => {
  const plugin = await loadPlugin(false);
  await loadAuth(plugin);

  expect(remoteRequests).toHaveLength(0);
  expect(metadataRequests).toHaveLength(0);
  expect(socketRequests.map((request) => request.method)).toContain("events.subscribe");
  expect(socketRequests.map((request) => request.method)).toContain("pane.current");
});

test("fetches immediately when its pane gains focus", async () => {
  const plugin = await loadPlugin(false);
  await loadAuth(plugin);
  subscriptions[0]?.emit(
    "data",
    `${JSON.stringify({ event: "pane_focused", data: { pane_id: "test:p1" } })}\n`,
  );
  await waitFor(() => remoteRequests.length === 1 && metadataRequests.length === 1);

  expect(latestTokens().quota_status).toBe("ok");
});

test("reuses fresh quota reported by a Pi pane", async () => {
  paneList = [{
    pane_id: "test:p2",
    agent: "pi",
    tokens: {
      quota_status: "ok",
      quota_provider: "openai",
      quota_plan: "pro",
      quota_primary_remaining: "82",
      quota_primary_minutes: "10080",
      quota_updated: new Date().toISOString(),
    },
  }];
  const plugin = await loadPlugin();
  await loadAuth(plugin);

  expect(remoteRequests).toHaveLength(0);
  expect(latestTokens()).toMatchObject({
    quota_status: "ok",
    quota_plan: "pro",
    quota_primary_remaining: "82",
    quota_primary_minutes: "10080",
  });
});

test("refreshes remotely when shared quota is stale", async () => {
  paneList = [{
    pane_id: "test:p2",
    agent: "opencode",
    tokens: {
      quota_status: "ok",
      quota_provider: "openai",
      quota_updated: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
  }];
  const plugin = await loadPlugin();
  await loadAuth(plugin);

  expect(remoteRequests).toHaveLength(1);
  expect(latestTokens().quota_primary_remaining).toBe("75");
});

test("reports stale OAuth without refreshing or fetching", async () => {
  let authReads = 0;
  const plugin = await loadPlugin();
  await plugin.auth?.loader?.(async () => {
    authReads += 1;
    return validAuth({ expires: Date.now() - 1 });
  }, {});

  expect(authReads).toBe(1);
  expect(remoteRequests).toHaveLength(0);
  expect(latestTokens()).toMatchObject({
    quota_status: "stale",
    quota_message: "OpenAI OAuth access has expired.",
  });
});

test("reports non-OAuth auth as signed out", async () => {
  const plugin = await loadPlugin();
  await loadAuth(plugin, { type: "api", key: "secret-api-key" });

  expect(remoteRequests).toHaveLength(0);
  expect(latestTokens().quota_status).toBe("signed_out");
});

test("reports only the metadata token schema and no credentials", async () => {
  const plugin = await loadPlugin();
  await loadAuth(plugin);

  const request = metadataRequests.at(-1) as Record<string, unknown>;
  const params = request.params as Record<string, unknown>;
  const expectedKeys = [
    "quota_status",
    "quota_provider",
    "quota_plan",
    "quota_limit_name",
    "quota_primary_remaining",
    "quota_primary_minutes",
    "quota_primary_reset",
    "quota_secondary_remaining",
    "quota_secondary_minutes",
    "quota_secondary_reset",
    "quota_unlimited",
    "quota_updated",
    "quota_message",
  ];
  expect(params).toMatchObject({
    pane_id: "test:p1",
    source: "herdr:opencode-quota",
    agent: "opencode",
    ttl_ms: expect.any(Number),
    seq: expect.any(Number),
  });
  expect(Object.keys(latestTokens()).sort()).toEqual(expectedKeys.sort());
  const serialized = JSON.stringify(request);
  expect(serialized).not.toContain("secret-access-token");
  expect(serialized).not.toContain("secret-refresh-token");
  expect(serialized).not.toContain("secret-account-id");
  expect(serialized).not.toContain("plan_type");
  expect(serialized).not.toContain("rate_limit");
});

test("uses bounded manual-redirect HTTP requests", async () => {
  const plugin = await loadPlugin();
  await loadAuth(plugin);

  const request = remoteRequests[0];
  expect(request?.options.redirect).toBe("manual");
  expect(request?.options.signal).toBeInstanceOf(AbortSignal);
  expect(request?.options.headers).toMatchObject({
    authorization: "Bearer secret-access-token",
    "chatgpt-account-id": "secret-account-id",
  });
});

test("rejects responses above one MiB as unavailable", async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ padding: "x".repeat(1024 * 1024) }), { status: 200 }),
  ) as typeof fetch;
  const plugin = await loadPlugin();
  await loadAuth(plugin);

  expect(latestTokens()).toMatchObject({
    quota_status: "unavailable",
    quota_message: "OpenAI quota is unavailable.",
    quota_primary_remaining: null,
    quota_secondary_remaining: null,
  });
});

test("dispose closes the subscription and prevents later focus fetches", async () => {
  const plugin = await loadPlugin(false);
  await loadAuth(plugin);
  const subscription = subscriptions[0];

  await plugin.dispose?.();
  subscription?.emit(
    "data",
    `${JSON.stringify({ event: "pane_focused", data: { pane_id: "test:p1" } })}\n`,
  );
  await Bun.sleep(10);

  expect(remoteRequests).toHaveLength(0);
});

test("disables itself outside the Herdr environment", async () => {
  delete process.env.HERDR_ENV;
  const { HerdrOpenAIQuotaPlugin } = await import("./herdr-openai-quota.js");
  expect(await HerdrOpenAIQuotaPlugin()).toEqual({});
  expect(socketRequests).toHaveLength(0);
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for plugin activity");
    await Bun.sleep(1);
  }
}
