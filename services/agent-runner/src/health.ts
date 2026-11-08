import { createServer, type Server } from "node:http";

export interface HealthInput {
  daoId: string;
  voters: Array<{ voter_id: string; source: "file" | "discovered" }>;
  lowBalanceVoters: Array<{
    voter_id: string;
    available_yocto: string;
    required_yocto: string;
  }>;
  agentPublicKey: string | null;
  cursor: number | null;
  startedAtMs: number;
  nowMs: number;
  pollMs: number;
  lastTickAtMs: number | null;
  lastTickOkAtMs: number | null;
}

export interface HealthResponse {
  status: "starting" | "ok" | "stale";
  dao_id: string;
  voters: Array<{ voter_id: string; source: "file" | "discovered" }>;
  low_balance_voters: Array<{
    voter_id: string;
    available_yocto: string;
    required_yocto: string;
  }>;
  agent_public_key: string | null;
  cursor: number | null;
  started_at: string;
  uptime_s: number;
  last_tick_at: string | null;
  last_tick_ok_at: string | null;
}

export interface KeepaliveConfig {
  url?: string;
  intervalMs: number;
}

export function healthStatus(input: HealthInput): HealthResponse {
  const uptimeSeconds = Math.max(0, Math.floor((input.nowMs - input.startedAtMs) / 1000));
  const staleThresholdMs = Math.max(3 * input.pollMs + 60_000, 600_000);
  const lastTickIsFresh = input.lastTickOkAtMs !== null
    && input.nowMs >= input.lastTickOkAtMs
    && input.nowMs - input.lastTickOkAtMs <= staleThresholdMs;
  const status = uptimeSeconds < 600 && input.lastTickOkAtMs === null
    ? "starting"
    : lastTickIsFresh
      ? "ok"
      : "stale";

  return {
    status,
    dao_id: input.daoId,
    voters: input.voters,
    low_balance_voters: input.lowBalanceVoters,
    agent_public_key: input.agentPublicKey,
    cursor: input.cursor,
    started_at: new Date(input.startedAtMs).toISOString(),
    uptime_s: uptimeSeconds,
    last_tick_at: input.lastTickAtMs === null ? null : new Date(input.lastTickAtMs).toISOString(),
    last_tick_ok_at: input.lastTickOkAtMs === null
      ? null
      : new Date(input.lastTickOkAtMs).toISOString(),
  };
}

export function parseKeepaliveConfig(env: NodeJS.ProcessEnv): KeepaliveConfig {
  const configuredUrl = env.KEEPALIVE_URL?.trim();
  const renderUrl = env.RENDER_EXTERNAL_URL?.trim().replace(/\/+$/, "");
  const url = configuredUrl || (renderUrl ? `${renderUrl}/health` : undefined);
  const intervalMs = env.KEEPALIVE_MS === undefined ? 600_000 : Number(env.KEEPALIVE_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 840_000) {
    throw new Error("KEEPALIVE_MS must be an integer between 60000 and 840000");
  }
  return { url, intervalMs };
}

export type KeepaliveLog = (entry: {
  action: "keepalive";
  status: "ok" | "error";
  error?: string;
}) => void;

export function startKeepalive(
  url: string | undefined,
  intervalMs: number,
  log: KeepaliveLog,
): NodeJS.Timeout | undefined {
  if (!url) {
    return undefined;
  }

  let loggedSuccess = false;
  const timer = setInterval(() => {
    void (async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        if (!loggedSuccess) {
          loggedSuccess = true;
          log({ action: "keepalive", status: "ok" });
        }
      } catch (error) {
        log({ action: "keepalive", status: "error", error: String(error) });
      }
    })();
  }, intervalMs);
  timer.unref();
  return timer;
}

export function startHealthServer(
  port: number,
  getInput: () => HealthInput,
  briefHandler?: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url?.split("?")[0] === "/brief" && briefHandler) {
      void briefHandler(request, response);
      return;
    }
    if ((request.method !== "GET" && request.method !== "HEAD")
      || request.url?.split("?")[0] !== "/health") {
      response.writeHead(404);
      response.end();
      return;
    }

    const result = healthStatus(getInput());
    const body = JSON.stringify(result);
    const statusCode = result.status === "stale" ? 503 : 200;
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });
}
