import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  healthStatus,
  parseKeepaliveConfig,
  startHealthServer,
  type HealthInput,
} from "../src/health.js";

function healthInput(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    daoId: "club.testnet",
    voters: ["voter.testnet"],
    cursor: 7,
    startedAtMs: 1_000,
    nowMs: 2_000,
    pollMs: 15_000,
    lastTickAtMs: null,
    lastTickOkAtMs: null,
    ...overrides,
  };
}

describe("health status", () => {
  it("reports starting for the 600-second grace period without a successful tick", () => {
    expect(healthStatus(healthInput({ startedAtMs: 0, nowMs: 599_999 })).status).toBe("starting");
    expect(healthStatus(healthInput({ startedAtMs: 0, nowMs: 600_000 })).status).toBe("stale");
  });

  it("reports ok through the minimum 600-second freshness window", () => {
    expect(healthStatus(healthInput({
      startedAtMs: 0,
      nowMs: 700_000,
      lastTickAtMs: 100_000,
      lastTickOkAtMs: 100_000,
    })).status).toBe("ok");
  });

  it("reports stale after the minimum freshness window", () => {
    expect(healthStatus(healthInput({
      startedAtMs: 0,
      nowMs: 700_001,
      lastTickAtMs: 1_000,
      lastTickOkAtMs: 1_000,
    })).status).toBe("stale");
  });

  it("uses the poll-derived freshness window when it exceeds ten minutes", () => {
    expect(healthStatus(healthInput({
      nowMs: 1_160_000,
      lastTickAtMs: 200_000,
      lastTickOkAtMs: 200_000,
      pollMs: 300_000,
    })).status).toBe("ok");
    expect(healthStatus(healthInput({
      nowMs: 1_160_001,
      lastTickAtMs: 200_000,
      lastTickOkAtMs: 200_000,
      pollMs: 300_000,
    })).status).toBe("stale");
  });

  it("serves GET and HEAD on /health and returns 404 for other paths", async () => {
    const server = await startHealthServer(0, () => healthInput({
      startedAtMs: 0,
      nowMs: 30_000,
      lastTickAtMs: 25_000,
      lastTickOkAtMs: 25_000,
    }));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const getResponse = await fetch(`${baseUrl}/health`);
      expect(getResponse.status).toBe(200);
      expect(await getResponse.json()).toEqual({
        status: "ok",
        dao_id: "club.testnet",
        voters: ["voter.testnet"],
        cursor: 7,
        started_at: new Date(0).toISOString(),
        uptime_s: 30,
        last_tick_at: new Date(25_000).toISOString(),
        last_tick_ok_at: new Date(25_000).toISOString(),
      });

      const headResponse = await fetch(`${baseUrl}/health`, { method: "HEAD" });
      expect(headResponse.status).toBe(200);
      expect(await headResponse.text()).toBe("");

      const missingResponse = await fetch(`${baseUrl}/not-health`);
      expect(missingResponse.status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe("keep-alive configuration", () => {
  it("uses the Render external URL and ten-minute default", () => {
    expect(parseKeepaliveConfig({ RENDER_EXTERNAL_URL: "https://runner.onrender.com/" })).toEqual({
      url: "https://runner.onrender.com/health",
      intervalMs: 600_000,
    });
  });

  it("uses an explicit URL and can remain disabled", () => {
    expect(parseKeepaliveConfig({
      KEEPALIVE_URL: "https://monitor.example/health",
      KEEPALIVE_MS: "840000",
    })).toEqual({ url: "https://monitor.example/health", intervalMs: 840_000 });
    expect(parseKeepaliveConfig({})).toEqual({ url: undefined, intervalMs: 600_000 });
  });

  it.each(["59999", "840001", "60000.5", "invalid"])(
    "rejects an invalid keep-alive interval %s",
    (value) => {
      expect(() => parseKeepaliveConfig({ KEEPALIVE_MS: value })).toThrow(
        "KEEPALIVE_MS must be an integer between 60000 and 840000",
      );
    },
  );
});
