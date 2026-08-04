import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type Handler = (event?: unknown, ctx?: unknown) => unknown;
type SocketHandler = (value?: unknown) => void;
type FakeSocket = ReturnType<typeof createSocket>;

const socketRequests: Record<string, unknown>[] = [];
const metadataRequests: Record<string, unknown>[] = [];
const subscriptions: FakeSocket[] = [];
const remoteRequests: Array<{ url: string; options: RequestInit }> = [];
let currentPaneActive = true;
let paneList: Record<string, unknown>[] = [];
let usagePayload: unknown;

function createSocket(onConnect: () => void) {
  const handlers = new Map<string, Set<SocketHandler>>();
  let destroyed = false;
  const socket = {
    write(input: string) {
      const request = JSON.parse(input.trim()) as Record<string, unknown>;
      socketRequests.push(request);
      if (request.method === "events.subscribe") {
        subscriptions.push(socket);
        queueMicrotask(() => socket.emit("data", `${JSON.stringify({ id: request.id, result: {} })}\n`));
      } else if (request.method === "pane.current") {
        queueMicrotask(() => socket.emit("data", `${JSON.stringify({
          id: request.id,
          result: { pane: { focused: currentPaneActive } },
        })}\n`));
      } else if (request.method === "pane.list") {
        queueMicrotask(() => socket.emit("data", `${JSON.stringify({
          id: request.id,
          result: { panes: paneList },
        })}\n`));
      } else if (request.method === "pane.report_metadata") {
        metadataRequests.push(request);
        queueMicrotask(() => socket.emit("data", `${JSON.stringify({ id: request.id, result: {} })}\n`));
      }
    },
    setTimeout() {},
    on(event: string, handler: SocketHandler) {
      const values = handlers.get(event) ?? new Set();
      values.add(handler);
      handlers.set(event, values);
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

function oauthToken(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "secret-account-id" },
    ...overrides,
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createPi(auth = { auth: { apiKey: oauthToken() }, source: "OAuth" }) {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async emit(event: string, value: unknown = {}, ctx?: unknown) {
      for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
    },
    handlerCount(event: string) {
      return handlers.get(event)?.length ?? 0;
    },
    ctx: {
      mode: "tui",
      modelRegistry: {
        async getProviderAuth(provider: string) {
          expect(provider).toBe("openai-codex");
          return auth;
        },
      },
    },
  };
}

beforeEach(() => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "test.sock";
  process.env.HERDR_PANE_ID = "test:p1";
  currentPaneActive = true;
  paneList = [];
  socketRequests.length = 0;
  metadataRequests.length = 0;
  subscriptions.length = 0;
  remoteRequests.length = 0;
  usagePayload = {
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 38,
        limit_window_seconds: 604800,
        reset_at: 2_000_000_000,
      },
    },
  };
  globalThis.fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    remoteRequests.push({ url: String(input), options: options ?? {} });
    return new Response(JSON.stringify(usagePayload), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  mock.restore();
});

async function loadExtension(pi = createPi()) {
  const { default: extension } = await import("./herdr-openai-quota.ts");
  extension(pi);
  await pi.emit("session_start", {}, pi.ctx);
  return pi;
}

function latestTokens(): Record<string, unknown> {
  const params = metadataRequests.at(-1)?.params as Record<string, unknown>;
  return params.tokens as Record<string, unknown>;
}

async function shutdown(pi: ReturnType<typeof createPi>) {
  await pi.emit("session_shutdown", {}, pi.ctx);
}

test("fetches Pi-managed OAuth quota and reports normalized metadata", async () => {
  const pi = await loadExtension();
  await waitFor(() => metadataRequests.length === 1);

  expect(remoteRequests).toHaveLength(1);
  expect(remoteRequests[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
  expect(remoteRequests[0]?.options.headers).toMatchObject({
    authorization: expect.stringContaining("Bearer "),
    "chatgpt-account-id": "secret-account-id",
  });
  expect(remoteRequests[0]?.options.redirect).toBe("manual");
  expect(remoteRequests[0]?.options.signal).toBeInstanceOf(AbortSignal);
  expect(latestTokens()).toMatchObject({
    quota_status: "ok",
    quota_plan: "pro",
    quota_primary_remaining: "62",
    quota_primary_minutes: "10080",
  });
  const request = metadataRequests[0] as Record<string, unknown>;
  expect(request.params).toMatchObject({
    pane_id: "test:p1",
    source: "herdr:pi-quota",
    agent: "pi",
  });
  const serialized = JSON.stringify(request);
  expect(serialized).not.toContain("secret-account-id");
  expect(serialized).not.toContain("signature");
  expect(serialized).not.toContain("rate_limit");

  await shutdown(pi);
});

test("does not fetch until the Pi pane gains focus", async () => {
  currentPaneActive = false;
  const pi = await loadExtension();
  expect(remoteRequests).toHaveLength(0);

  subscriptions[0]?.emit("data", `${JSON.stringify({
    event: "pane_focused",
    data: { pane_id: "test:p1" },
  })}\n`);
  await waitFor(() => metadataRequests.length === 1);
  expect(remoteRequests).toHaveLength(1);

  await shutdown(pi);
});

test("reuses fresh quota from an OpenCode pane", async () => {
  paneList = [{
    agent: "opencode",
    tokens: {
      quota_status: "ok",
      quota_provider: "openai",
      quota_plan: "plus",
      quota_primary_remaining: "81",
      quota_primary_minutes: "300",
      quota_updated: new Date().toISOString(),
    },
  }];
  const pi = await loadExtension();
  await waitFor(() => metadataRequests.length === 1);

  expect(remoteRequests).toHaveLength(0);
  expect(latestTokens()).toMatchObject({
    quota_plan: "plus",
    quota_primary_remaining: "81",
  });

  await shutdown(pi);
});

test("does not reuse a failed quota status from another agent", async () => {
  paneList = [{
    agent: "opencode",
    tokens: {
      quota_status: "signed_out",
      quota_provider: "openai",
      quota_updated: new Date().toISOString(),
    },
  }];
  const pi = await loadExtension();
  await waitFor(() => metadataRequests.length === 1);

  expect(remoteRequests).toHaveLength(1);
  expect(latestTokens().quota_status).toBe("ok");

  await shutdown(pi);
});

test("reports signed out when Pi has no OpenAI OAuth", async () => {
  const pi = await loadExtension(createPi(null));
  await waitFor(() => metadataRequests.length === 1);

  expect(remoteRequests).toHaveLength(0);
  expect(latestTokens()).toMatchObject({
    quota_status: "signed_out",
    quota_message: "OpenAI sign-in is required.",
  });

  await shutdown(pi);
});

test("reports stale when the resolved OAuth JWT is expired", async () => {
  const pi = await loadExtension(createPi({
    auth: { apiKey: oauthToken({ exp: Math.floor(Date.now() / 1000) - 60 }) },
    source: "OAuth",
  }));
  await waitFor(() => metadataRequests.length === 1);

  expect(remoteRequests).toHaveLength(0);
  expect(latestTokens().quota_status).toBe("stale");

  await shutdown(pi);
});

test("does not register outside Herdr", async () => {
  delete process.env.HERDR_ENV;
  const pi = createPi();
  const { default: extension } = await import("./herdr-openai-quota.ts");
  extension(pi);
  expect(pi.handlerCount("session_start")).toBe(0);
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for quota activity; sockets=${JSON.stringify(socketRequests)} remote=${remoteRequests.length}`,
      );
    }
    await Bun.sleep(1);
  }
}
