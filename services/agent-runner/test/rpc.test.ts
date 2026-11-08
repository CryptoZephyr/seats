import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { baseEncode } from "@near-js/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialFromPrivateKey, NearAgentRpc } from "../src/rpc.js";

const rpcUrls = [
  "https://primary.testnet.example",
  "https://secondary.testnet.example",
  "https://tertiary.testnet.example",
];

type ProviderCall = {
  url: string;
  method: string;
  params: unknown;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createRpc(urls = rpcUrls): NearAgentRpc {
  const keeper = credentialFromPrivateKey(
    "keeper.testnet",
    KeyPair.fromRandom("ed25519").toString(),
  );
  const voter = credentialFromPrivateKey(
    "voter.testnet",
    KeyPair.fromRandom("ed25519").toString(),
  );
  return new NearAgentRpc(urls, keeper, [voter]);
}

function stubSendJsonRpc(handler: (call: ProviderCall) => unknown | Promise<unknown>): ProviderCall[] {
  const calls: ProviderCall[] = [];
  vi.spyOn(JsonRpcProvider.prototype, "sendJsonRpc").mockImplementation(
    async function (this: JsonRpcProvider, method: string, params: unknown) {
      const call = { url: this.connection.url, method, params };
      calls.push(call);
      return await handler(call) as never;
    },
  );
  return calls;
}

function successfulRpcResponse({ method, params }: ProviderCall): unknown {
  if (method === "query") {
    if ((params as { request_type?: string }).request_type === "view_access_key") {
      return { nonce: "1", permission: "FullAccess" };
    }
    return { result: Array.from(Buffer.from(JSON.stringify(19))) };
  }
  if (method === "block") {
    return { header: { hash: baseEncode(new Uint8Array(32)), height: 1 } };
  }
  if (method === "send_tx") {
    return {
      status: { SuccessValue: "" },
      transaction_outcome: { outcome: { status: { SuccessValue: "" } } },
      receipts_outcome: [],
    };
  }
  throw new Error(`Unexpected RPC method ${method}`);
}

describe("runner RPC failover", () => {
  it("moves a read from the primary URL to the next URL after a -429 error", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const calls = stubSendJsonRpc((call) => {
      if (call.url === rpcUrls[0]) {
        throw new Error('{"code": -429, "message": "Rate limits exceeded"}');
      }
      return successfulRpcResponse(call);
    });

    const result = createRpc().getLastProposalId("dao.testnet");
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(19);
    expect(calls.map(({ url }) => url)).toEqual(rpcUrls.slice(0, 2));
  });

  it.each([
    ["HTTP 429", Object.assign(new Error("Too Many Requests"), { cause: 429 })],
    ["HTTP 503", Object.assign(new Error("Service unavailable"), { cause: 503 })],
    ["fetch TypeError", new TypeError("Failed to fetch")],
    ["request timeout", new Error("Request timed out")],
  ])("retries reads after %s", async (_name, error) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let attempt = 0;
    const calls = stubSendJsonRpc((call) => {
      if (attempt++ === 0) throw error;
      return successfulRpcResponse(call);
    });

    const result = createRpc().getLastProposalId("dao.testnet");
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(19);
    expect(calls.map(({ url }) => url)).toEqual(rpcUrls.slice(0, 2));
  });

  it("cycles through five attempts and throws the last read error", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const errors = Array.from({ length: 5 }, (_, attempt) =>
      new Error(`{"code": -429, "message": "Rate limits exceeded", "attempt": ${attempt}}`));
    let attempt = 0;
    const calls = stubSendJsonRpc(() => {
      throw errors[attempt++];
    });

    const result = createRpc().getLastProposalId("dao.testnet");
    const rejection = expect(result).rejects.toBe(errors[4]);
    await vi.runAllTimersAsync();

    await rejection;
    expect(calls.map(({ url }) => url)).toEqual([
      rpcUrls[0],
      rpcUrls[1],
      rpcUrls[2],
      rpcUrls[0],
      rpcUrls[1],
    ]);
  });

  it("does not retry non-retryable read errors", async () => {
    const error = new Error("Contract execution panicked");
    const calls = stubSendJsonRpc(() => { throw error; });

    await expect(createRpc().getLastProposalId("dao.testnet")).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });

  it("resends identical signed bytes to the next URL after a broadcast -429", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const broadcasts: ProviderCall[] = [];
    const calls = stubSendJsonRpc((call) => {
      if (call.method === "send_tx") {
        broadcasts.push(call);
        if (broadcasts.length === 1) {
          throw new Error('{"code": -429, "message": "Rate limits exceeded"}');
        }
      }
      return successfulRpcResponse(call);
    });

    const result = createRpc().requestVote("voter.testnet", 19);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual(expect.any(String));
    expect(broadcasts.map(({ url }) => url)).toEqual(rpcUrls.slice(0, 2));
    expect((broadcasts[1].params as { signed_tx_base64: string }).signed_tx_base64)
      .toBe((broadcasts[0].params as { signed_tx_base64: string }).signed_tx_base64);
    expect(calls.filter(({ method }) => method === "send_tx")).toHaveLength(2);
  });

  it.each([
    ["timeout", Object.assign(new Error("request timed out"), { name: "TimeoutError" })],
    ["HTTP 5xx", Object.assign(new Error("Internal server error"), { cause: 503 })],
  ])("does not retry a broadcast after %s", async (_name, error) => {
    const broadcasts: ProviderCall[] = [];
    const calls = stubSendJsonRpc((call) => {
      if (call.method === "send_tx") {
        broadcasts.push(call);
        throw error;
      }
      return successfulRpcResponse(call);
    });

    await expect(createRpc().requestVote("voter.testnet", 19)).rejects.toBe(error);
    expect(broadcasts).toHaveLength(1);
    expect(calls.filter(({ method }) => method === "send_tx")).toHaveLength(1);
  });
});
