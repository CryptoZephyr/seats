import { afterEach, describe, expect, it, vi } from "vitest";
import { chainConfig } from "./config";
import { rpcRequest } from "./rpc";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const successResponse = () => new Response(JSON.stringify({ result: { value: "ok" } }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("rpcRequest", () => {
  it("keeps FastNear first and uses dRPC as the final read fallback", () => {
    expect(chainConfig.readRpcUrls).toEqual([
      "https://rpc.testnet.fastnear.com",
      "https://test.rpc.fastnear.com",
      "https://near-testnet.drpc.org",
    ]);
  });

  it("retries a read on the second URL after a fetch error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal("fetch", fetchMock);

    const request = rpcRequest("query", {});
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ value: "ok" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      chainConfig.readRpcUrls[0],
      chainConfig.readRpcUrls[1],
    ]);
  });

  it("retries fetch errors and HTTP 429 responses before succeeding", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal("fetch", fetchMock);

    const request = rpcRequest("query", {});
    await vi.runAllTimersAsync();

    await expect(request).resolves.toEqual({ value: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("sends broadcast methods to the primary once without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpcRequest("broadcast_tx_async", {})).rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(chainConfig.rpcUrl);
  });

  it("cycles through read URLs and gives up after four retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const rejectedRequest = expect(rpcRequest("query", {})).rejects.toThrow("Failed to fetch");
    await vi.runAllTimersAsync();

    await rejectedRequest;
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      chainConfig.readRpcUrls[0],
      chainConfig.readRpcUrls[1],
      chainConfig.readRpcUrls[2],
      chainConfig.readRpcUrls[0],
      chainConfig.readRpcUrls[1],
    ]);
  });

  it("limits concurrent read requests to four", async () => {
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return successResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all(Array.from({ length: 20 }, () => rpcRequest("query", {})));

    expect(peak).toBe(4);
  });
});
