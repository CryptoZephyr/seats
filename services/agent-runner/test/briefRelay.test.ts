import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyPair } from "@near-js/crypto";
import { briefHash, briefProfileName, createBriefHandler, nep413Hash, type BriefRelayRpc } from "../src/briefRelay.js";

const recipient = "seats-agent-runner";
const ownerId = "brief-owner.testnet";
const apiKey = "near-ai-test-secret";
const brief = "Back community events and reject spending above 50 NEAR.";
const nowValue = 1_800_000_000_000;
const servers: Server[] = [];
let nonceCounter = 0;

function rpc(overrides: Partial<BriefRelayRpc> = {}): BriefRelayRpc {
  return {
    isFullAccessKey: async () => true,
    getTokenOwner: async (tokenId) => `account-${tokenId}.testnet`,
    getSeatVoterId: async (tokenId) => `voter-${tokenId}.testnet`,
    getVoterController: async (voterId) => `account-${voterId.slice("voter-".length).replace(".testnet", "")}.testnet`,
    getAccountBalance: async () => "1000000000000000000000000",
    storeProfile: async () => "profile-store-tx",
    ...overrides,
  };
}

async function serve(handler: ReturnType<typeof createBriefHandler>): Promise<string> {
  const server = createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}/brief`;
}

async function signedBody(options: {
  accountId?: string;
  tokenId?: string;
  issuedAt?: number;
  brief?: string;
  salt?: string;
  action?: string;
} = {}) {
  const pair = KeyPair.fromRandom("ed25519");
  const tokenId = options.tokenId ?? "1";
  const accountId = options.accountId ?? `account-${tokenId}.testnet`;
  const requestBrief = options.brief ?? brief;
  const salt = options.salt ?? "ab".repeat(32);
  const nonce = Buffer.alloc(32, ++nonceCounter);
  const hash = briefHash(salt, requestBrief);
  const issuedAt = options.issuedAt ?? nowValue;
  const message = JSON.stringify({
    action: options.action ?? "seats-save-brief",
    token_id: tokenId,
    brief_hash: hash,
    issued_at: issuedAt,
  });
  const signature = pair.sign(nep413Hash(message, nonce, recipient)).signature;
  return {
    account_id: accountId,
    public_key: pair.getPublicKey().toString(),
    signature: Buffer.from(signature).toString("base64"),
    nonce: nonce.toString("base64"),
    message,
    brief: requestBrief,
    salt,
  };
}

async function post(url: string, body: unknown, origin?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() as Record<string, unknown> };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  vi.restoreAllMocks();
});

describe("brief relay", () => {
  it("verifies NEP-413 and stores content-addressed secrets without returning or logging them", async () => {
    const stored: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const url = await serve(createBriefHandler({
      rpc: rpc({ storeProfile: async (profile, secrets) => {
        expect(profile).toBe(briefProfileName("1", briefHash("ab".repeat(32), brief)));
        stored.push(secrets);
        return "profile-store-tx";
      } }),
      apiKey,
      ownerAccountId: ownerId,
      recipient,
      now: () => nowValue,
    }));
    const signed = await signedBody();
    const { response, json } = await post(url, signed);
    expect(response.status, JSON.stringify(json)).toBe(200);
    expect(json).toEqual({
      secrets_account_id: ownerId,
      profile: briefProfileName("1", briefHash(signed.salt, signed.brief)),
      brief_hash: briefHash(signed.salt, signed.brief),
      tx_hash: "profile-store-tx",
    });
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0])).toEqual({
      BRIEF: brief,
      SALT: signed.salt,
      NEAR_AI_API_KEY: apiKey,
    });
    expect(JSON.stringify(json)).not.toContain(apiKey);
    expect(JSON.stringify(json)).not.toContain(brief);
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects a non-FullAccess key", async () => {
    const url = await serve(createBriefHandler({
      rpc: rpc({ isFullAccessKey: async () => false }),
      apiKey,
      ownerAccountId: ownerId,
      now: () => nowValue,
    }));
    const { response, json } = await post(url, await signedBody());
    expect(response.status).toBe(403);
    expect(json.error).toBe("FULL_ACCESS_REQUIRED");
  });

  it("rejects a different signed action", async () => {
    const url = await serve(createBriefHandler({ rpc: rpc(), apiKey, ownerAccountId: ownerId, now: () => nowValue }));
    const { response, json } = await post(url, await signedBody({ action: "wrong-action" }));
    expect(response.status).toBe(400);
    expect(json.error).toBe("INVALID_MESSAGE");
  });

  it("rejects an invalid Ed25519 signature", async () => {
    const url = await serve(createBriefHandler({ rpc: rpc(), apiKey, ownerAccountId: ownerId, now: () => nowValue }));
    const body = await signedBody();
    body.signature = Buffer.alloc(64).toString("base64");
    const { response, json } = await post(url, body);
    expect(response.status).toBe(401);
    expect(json.error).toBe("INVALID_SIGNATURE");
  });

  it("rejects an old or future signature timestamp", async () => {
    const url = await serve(createBriefHandler({ rpc: rpc(), apiKey, ownerAccountId: ownerId, now: () => nowValue }));
    for (const issuedAt of [nowValue - 300_001, nowValue + 1]) {
      const { response, json } = await post(url, await signedBody({ issuedAt }));
      expect(response.status).toBe(400);
      expect(json.error).toBe("MESSAGE_EXPIRED");
    }
  });

  it("rejects a reused nonce", async () => {
    const url = await serve(createBriefHandler({ rpc: rpc(), apiKey, ownerAccountId: ownerId, now: () => nowValue }));
    const body = await signedBody();
    expect((await post(url, body)).response.status).toBe(200);
    const { response, json } = await post(url, body);
    expect(response.status).toBe(409);
    expect(json.error).toBe("NONCE_REUSED");
  });

  it("rejects a seat that belongs to another account", async () => {
    const url = await serve(createBriefHandler({
      rpc: rpc({ getTokenOwner: async () => "other.testnet" }),
      apiKey,
      ownerAccountId: ownerId,
      now: () => nowValue,
    }));
    const { response, json } = await post(url, await signedBody());
    expect(response.status).toBe(403);
    expect(json.error).toBe("NOT_TOKEN_OWNER");
  });

  it("rejects an account that isn't the voter controller", async () => {
    const url = await serve(createBriefHandler({
      rpc: rpc({ getVoterController: async () => "other.testnet" }),
      apiKey,
      ownerAccountId: ownerId,
      now: () => nowValue,
    }));
    const { response, json } = await post(url, await signedBody());
    expect(response.status).toBe(403);
    expect(json.error).toBe("NOT_VOTER_CONTROLLER");
  });

  it("rejects a hash mismatch, malformed salt, empty brief, and overlong brief", async () => {
    const url = await serve(createBriefHandler({ rpc: rpc(), apiKey, ownerAccountId: ownerId, now: () => nowValue }));
    for (const [body, code] of [
      [{ ...(await signedBody()), brief: "changed" }, "BRIEF_HASH_MISMATCH"],
      [{ ...(await signedBody()), salt: "bad" }, "INVALID_SALT"],
      [await signedBody({ brief: " " }), "INVALID_BRIEF"],
      [await signedBody({ brief: "x".repeat(4_001) }), "INVALID_BRIEF"],
    ] as const) {
      const { response, json } = await post(url, body);
      expect(json.error).toBe(code);
      expect(response.status).toBe(400);
    }
  });

  it("rejects a body larger than 16 KB", async () => {
    const url = await serve(createBriefHandler({ rpc: rpc(), apiKey, ownerAccountId: ownerId, now: () => nowValue }));
    const { response, json } = await post(url, { brief: "x".repeat(17_000) });
    expect(response.status).toBe(413);
    expect(json.error).toBe("BODY_TOO_LARGE");
  });

  it("enforces per-account and global hourly limits", async () => {
    const url = await serve(createBriefHandler({ rpc: rpc(), apiKey, ownerAccountId: ownerId, now: () => nowValue }));
    for (let index = 0; index < 5; index += 1) {
      expect((await post(url, await signedBody())).response.status).toBe(200);
    }
    expect((await post(url, await signedBody())).response.status).toBe(429);

    const globalUrl = await serve(createBriefHandler({ rpc: rpc(), apiKey, ownerAccountId: ownerId, now: () => nowValue }));
    for (let index = 1; index <= 30; index += 1) {
      const result = await post(globalUrl, await signedBody({ tokenId: String(index) }));
      expect(result.response.status).toBe(200);
    }
    const last = await post(globalUrl, await signedBody({ tokenId: "31" }));
    expect(last.response.status).toBe(429);
    expect(last.json.error).toBe("RATE_LIMITED");
  });

  it("returns 503 when the profile owner has less than 0.2 NEAR", async () => {
    const url = await serve(createBriefHandler({
      rpc: rpc({ getAccountBalance: async () => "199999999999999999999999" }),
      apiKey,
      ownerAccountId: ownerId,
      now: () => nowValue,
    }));
    const { response, json } = await post(url, await signedBody());
    expect(response.status).toBe(503);
    expect(json.error).toBe("BRIEF_OWNER_LOW_BALANCE");
  });

  it("only allows configured web origins through CORS", async () => {
    const url = await serve(createBriefHandler({
      rpc: rpc(),
      apiKey,
      ownerAccountId: ownerId,
      webOrigins: "https://seats.example",
    }));
    const allowed = await fetch(url, { method: "OPTIONS", headers: { origin: "https://seats.example" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://seats.example");
    const blocked = await fetch(url, { method: "OPTIONS", headers: { origin: "https://attacker.example" } });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });
});
