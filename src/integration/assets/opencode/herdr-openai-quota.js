// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=opencode-quota
// HERDR_INTEGRATION_VERSION=1

import net from "node:net";

const SOURCE = "herdr:opencode-quota";
const AGENT = "opencode";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TTL_MS = 11 * 60_000;
const NORMAL_REFRESH_MS = 5 * 60_000;
const RESET_REFRESH_MS = 60_000;
const MIN_REFRESH_MS = 30_000;
const IDLE_REFRESH_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const RECONNECT_MS = 5_000;
const TOKEN_KEYS = [
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

let reportSeq = Date.now() * 1000;

function nextSeq() {
  reportSeq += 1;
  return reportSeq;
}

function socketEndpoint(path) {
  return process.platform === "win32" ? `\\\\.\\pipe\\${path}` : path;
}

function timer(callback, delay) {
  const handle = setTimeout(callback, delay);
  handle.unref?.();
  return handle;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function pick(record, snake, camel) {
  if (!isRecord(record)) return undefined;
  return record[snake] ?? record[camel];
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function tokenNumber(value) {
  const number = finiteNumber(value);
  if (number === undefined) return null;
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function windowTokens(window) {
  if (!isRecord(window)) {
    return { remaining: null, minutes: null, reset: null };
  }
  const used = finiteNumber(pick(window, "used_percent", "usedPercent"));
  const explicitMinutes = finiteNumber(pick(window, "window_minutes", "windowMinutes"));
  const seconds = finiteNumber(pick(window, "limit_window_seconds", "limitWindowSeconds"));
  const minutes = explicitMinutes ?? (seconds === undefined ? undefined : Math.ceil(seconds / 60));
  const reset = finiteNumber(pick(window, "reset_at", "resetAt"));
  return {
    remaining: used === undefined ? null : tokenNumber(Math.max(0, 100 - used)),
    minutes: tokenNumber(minutes),
    reset: tokenNumber(reset),
  };
}

function blankTokens(status, message) {
  const tokens = Object.fromEntries(TOKEN_KEYS.map((key) => [key, null]));
  tokens.quota_status = status;
  tokens.quota_provider = "openai";
  tokens.quota_updated = new Date().toISOString();
  tokens.quota_message = message;
  return tokens;
}

function usageTokens(payload) {
  if (!isRecord(payload)) throw new Error("invalid usage response");
  const rateLimit = pick(payload, "rate_limit", "rateLimit");
  const primary = windowTokens(pick(rateLimit, "primary_window", "primaryWindow"));
  const secondary = windowTokens(pick(rateLimit, "secondary_window", "secondaryWindow"));
  const credits = pick(payload, "credits", "credits");
  const unlimited = isRecord(credits) && typeof credits.unlimited === "boolean"
    ? String(credits.unlimited)
    : null;
  const limitName =
    pick(rateLimit, "limit_name", "limitName") ??
    pick(payload, "limit_name", "limitName") ??
    pick(payload, "metered_feature", "meteredFeature");
  return {
    quota_status: "ok",
    quota_provider: "openai",
    quota_plan: stringToken(pick(payload, "plan_type", "planType")),
    quota_limit_name: stringToken(limitName),
    quota_primary_remaining: primary.remaining,
    quota_primary_minutes: primary.minutes,
    quota_primary_reset: primary.reset,
    quota_secondary_remaining: secondary.remaining,
    quota_secondary_minutes: secondary.minutes,
    quota_secondary_reset: secondary.reset,
    quota_unlimited: unlimited,
    quota_updated: new Date().toISOString(),
    quota_message: null,
  };
}

function stringToken(value) {
  return typeof value === "string" && value ? value : null;
}

function sharedQuotaTokens(response) {
  const panes = response?.result?.panes;
  if (!Array.isArray(panes)) return;

  let newest;
  for (const pane of panes) {
    if (pane?.agent !== AGENT || !isRecord(pane.tokens)) continue;
    const tokens = pane.tokens;
    if (
      tokens.quota_provider !== "openai" ||
      typeof tokens.quota_status !== "string" ||
      typeof tokens.quota_updated !== "string"
    ) {
      continue;
    }
    const updatedAt = Date.parse(tokens.quota_updated);
    const age = Date.now() - updatedAt;
    if (!Number.isFinite(updatedAt) || age < 0 || age >= NORMAL_REFRESH_MS) continue;
    if (newest && newest.updatedAt >= updatedAt) continue;
    newest = {
      age,
      updatedAt,
      tokens: Object.fromEntries(
        TOKEN_KEYS.map((key) => [
          key,
          typeof tokens[key] === "string" ? tokens[key] : null,
        ]),
      ),
    };
  }
  return newest;
}

function nearReset(tokens) {
  const nowSeconds = Date.now() / 1000;
  return [tokens.quota_primary_reset, tokens.quota_secondary_reset].some((value) => {
    const reset = finiteNumber(value);
    if (reset === undefined) return false;
    const delta = reset - nowSeconds;
    return delta >= -5 * 60 && delta <= 15 * 60;
  });
}

async function readLimitedJson(response) {
  const contentLength = finiteNumber(response.headers?.get?.("content-length"));
  if (contentLength !== undefined && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("usage response too large");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("usage response too large");
    }
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("usage response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export const HerdrOpenAIQuotaPlugin = async () => {
  const paneId = process.env.HERDR_PANE_ID;
  const path = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== "1" || !path || !paneId) return {};

  const endpoint = socketEndpoint(path);
  const sockets = new Set();
  let authGetter;
  let active = false;
  let disposed = false;
  let refreshTimer;
  let reconnectTimer;
  let subscription;
  let lastRemoteAt = 0;
  let inFlight;
  let abortController;
  let reportChain = Promise.resolve();

  function clearRefreshTimer() {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  function scheduleRefresh(delay) {
    clearRefreshTimer();
    if (!disposed && active) {
      refreshTimer = timer(() => void refresh(), delay);
    }
  }

  function rpc(method, params) {
    if (disposed) return Promise.resolve(undefined);
    const id = `${SOURCE}:${Date.now()}:${Math.random()}`;
    return new Promise((resolve) => {
      const client = net.createConnection(endpoint, () => {
        client.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      sockets.add(client);
      let input = "";
      const finish = (result) => {
        sockets.delete(client);
        client.destroy();
        resolve(result);
      };
      client.setTimeout(1000, () => finish(undefined));
      client.on("data", (chunk) => {
        input += String(chunk);
        const newline = input.indexOf("\n");
        if (newline === -1) return;
        try {
          finish(JSON.parse(input.slice(0, newline)));
        } catch {
          finish(undefined);
        }
      });
      client.on("error", () => finish(undefined));
      client.on("end", () => finish(undefined));
    });
  }

  function report(tokens) {
    reportChain = reportChain.then(() =>
      rpc("pane.report_metadata", {
        pane_id: paneId,
        source: SOURCE,
        agent: AGENT,
        ttl_ms: TTL_MS,
        seq: nextSeq(),
        tokens,
      }),
    );
    return reportChain;
  }

  async function reuseSharedQuota() {
    const shared = sharedQuotaTokens(await rpc("pane.list", {}));
    if (!shared || !active || disposed) return false;
    await report(shared.tokens);
    scheduleRefresh(Math.max(1_000, NORMAL_REFRESH_MS - shared.age));
    return true;
  }

  async function fetchUsage(auth) {
    abortController = new AbortController();
    const timeout = timer(() => abortController?.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers = {
        accept: "application/json",
        authorization: `Bearer ${auth.access}`,
      };
      if (typeof auth.accountId === "string" && auth.accountId) {
        headers["chatgpt-account-id"] = auth.accountId;
      }
      const response = await fetch(USAGE_URL, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: abortController.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return { tokens: blankTokens("signed_out", "OpenAI sign-in is required.") };
      }
      if (!response.ok) throw new Error("usage request failed");
      return { tokens: usageTokens(await readLimitedJson(response)) };
    } finally {
      clearTimeout(timeout);
      abortController = undefined;
    }
  }

  async function refresh() {
    if (disposed || !active) return;
    if (inFlight) return inFlight;
    const wait = MIN_REFRESH_MS - (Date.now() - lastRemoteAt);
    if (lastRemoteAt && wait > 0) {
      scheduleRefresh(wait);
      return;
    }
    inFlight = (async () => {
      if (!authGetter) return;
      if (await reuseSharedQuota()) return;
      let auth;
      try {
        auth = await authGetter();
      } catch {
        if (active) {
          await report(blankTokens("unavailable", "OpenAI auth is unavailable."));
          scheduleRefresh(NORMAL_REFRESH_MS);
        }
        return;
      }
      if (!isRecord(auth) || auth.type !== "oauth" || typeof auth.access !== "string") {
        if (active) {
          await report(blankTokens("signed_out", "OpenAI sign-in is required."));
          scheduleRefresh(NORMAL_REFRESH_MS);
        }
        return;
      }
      if (!finiteNumber(auth.expires) || auth.expires <= Date.now()) {
        if (active) {
          await report(blankTokens("stale", "OpenAI OAuth access has expired."));
          scheduleRefresh(NORMAL_REFRESH_MS);
        }
        return;
      }
      lastRemoteAt = Date.now();
      try {
        const result = await fetchUsage(auth);
        if (!active || disposed) return;
        await report(result.tokens);
        scheduleRefresh(nearReset(result.tokens) ? RESET_REFRESH_MS : NORMAL_REFRESH_MS);
      } catch {
        if (!active || disposed) return;
        await report(blankTokens("unavailable", "OpenAI quota is unavailable."));
        scheduleRefresh(NORMAL_REFRESH_MS);
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  function setActive(value) {
    if (active === value) return;
    active = value;
    if (!active) {
      clearRefreshTimer();
      abortController?.abort();
      return;
    }
    void refresh();
  }

  function connectSubscription() {
    if (disposed) return;
    const id = `${SOURCE}:focus:${Date.now()}`;
    let input = "";
    const client = net.createConnection(endpoint, () => {
      client.write(
        `${JSON.stringify({
          id,
          method: "events.subscribe",
          params: { subscriptions: [{ type: "pane.focused" }] },
        })}\n`,
      );
    });
    subscription = client;
    sockets.add(client);
    const reconnect = () => {
      sockets.delete(client);
      client.destroy();
      if (subscription === client) subscription = undefined;
      if (!disposed && !reconnectTimer) {
        reconnectTimer = timer(async () => {
          reconnectTimer = undefined;
          connectSubscription();
          const current = await rpc("pane.current", { caller_pane_id: paneId });
          setActive(current?.result?.pane?.focused === true);
        }, RECONNECT_MS);
      }
    };
    client.setTimeout?.(0);
    client.on("data", (chunk) => {
      input += String(chunk);
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline === -1) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message?.event === "pane_focused") {
            setActive(message?.data?.pane_id === paneId);
          }
        } catch {}
      }
    });
    client.on("error", reconnect);
    client.on("end", reconnect);
    client.on("close", reconnect);
  }

  connectSubscription();
  const current = await rpc("pane.current", { caller_pane_id: paneId });
  setActive(current?.result?.pane?.focused === true);

  return {
    auth: {
      provider: "openai",
      methods: [],
      loader: async (getAuth) => {
        authGetter = getAuth;
        if (active) await refresh();
        return {};
      },
    },
    event: async ({ event }) => {
      if (event?.type === "session.idle" && active) {
        scheduleRefresh(IDLE_REFRESH_DELAY_MS);
      }
    },
    dispose: async () => {
      disposed = true;
      clearRefreshTimer();
      clearTimeout(reconnectTimer);
      abortController?.abort();
      subscription?.destroy();
      for (const client of sockets) client.destroy();
      sockets.clear();
      await inFlight?.catch(() => {});
      await reportChain.catch(() => {});
    },
  };
};
