import { Buffer } from "buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callSignMessageWithBufferNonce, waitForOwnedSeats } from "./WalletProvider";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function tokensResponse(tokenIds: string[]) {
  const result = tokenIds.map((token_id) => ({ token_id, owner_id: "holder.testnet" }));
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(result)));
  return new Response(JSON.stringify({ result: { result: bytes } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("wallet message signing", () => {
  it("passes a real 32-byte Buffer nonce to the wallet", async () => {
    const signMessage = vi.fn().mockResolvedValue(undefined);
    const nonce = new Uint8Array(32).fill(1);

    await callSignMessageWithBufferNonce(signMessage, "message", nonce, "seats-agent-runner");

    const params = signMessage.mock.calls[0][0] as { nonce: unknown };
    expect(Buffer.isBuffer(params.nonce)).toBe(true);
    expect((params.nonce as Buffer).length).toBe(32);
  });
});

describe("owned seat polling", () => {
  it("continues after a read error and resolves when ownership appears on the third poll", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokensResponse([]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Read unavailable" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(tokensResponse(["seat-1"]));
    vi.stubGlobal("fetch", fetchMock);

    const polling = waitForOwnedSeats(
      "holder.testnet",
      (tokenIds) => tokenIds.includes("seat-1"),
      { attempts: 3, intervalMs: 1_500 },
    );
    await vi.runAllTimersAsync();

    await expect(polling).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns false after all ownership checks miss", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => tokensResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const polling = waitForOwnedSeats(
      "holder.testnet",
      (tokenIds) => tokenIds.includes("seat-1"),
      { attempts: 3, intervalMs: 1_500 },
    );
    await vi.runAllTimersAsync();

    await expect(polling).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
