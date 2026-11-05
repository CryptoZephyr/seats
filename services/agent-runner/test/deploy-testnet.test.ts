import { describe, expect, it, vi } from "vitest";
import { parseProposalId, selectNextNonce, sendWithNonceRetry } from "../src/deploy-testnet.js";

const accountId = "funder.testnet";
const publicKey = { toString: () => "ed25519:test-public-key" } as unknown as Parameters<
  typeof sendWithNonceRetry
>[2];
const cacheKey = `${accountId}:${publicKey.toString()}`;

describe("proposal IDs", () => {
  it("accepts non-negative integer IDs returned by Sputnik", () => {
    expect(parseProposalId(0)).toBe(0);
    expect(parseProposalId("12")).toBe(12);
  });

  it("rejects invalid proposal IDs with a clear error", () => {
    for (const value of [-1, 1.5, "1.5", undefined, {}]) {
      expect(() => parseProposalId(value))
        .toThrow("Sputnik add_proposal did not return a non-negative integer proposal ID");
    }
  });
});

describe("deployment transaction nonces", () => {
  it("selects the next nonce above both the local cache and chain state", () => {
    expect(selectNextNonce(undefined, 10n)).toBe(11n);
    expect(selectNextNonce(8n, 10n)).toBe(11n);
    expect(selectNextNonce(12n, 10n)).toBe(13n);
  });

  it("refreshes optimistic access-key state and retries once after InvalidNonce", async () => {
    const viewAccessKey = vi.fn()
      .mockResolvedValueOnce({ nonce: 10n })
      .mockResolvedValueOnce({ nonce: 10n });
    const provider = { viewAccessKey } as unknown as Parameters<typeof sendWithNonceRetry>[0];
    const send = vi.fn()
      .mockRejectedValueOnce(new Error(
        "Transaction nonce 11 must be larger than nonce of the used access key 11",
      ))
      .mockResolvedValueOnce("submitted");
    const nonceCache = new Map([[cacheKey, 8n]]);

    await expect(sendWithNonceRetry(provider, accountId, publicKey, nonceCache, send)).resolves.toBe("submitted");

    expect(viewAccessKey).toHaveBeenCalledTimes(2);
    expect(viewAccessKey).toHaveBeenNthCalledWith(1, accountId, publicKey, { finality: "optimistic" });
    expect(viewAccessKey).toHaveBeenNthCalledWith(2, accountId, publicKey, { finality: "optimistic" });
    expect(send.mock.calls.map(([nonce]) => nonce)).toEqual([11n, 12n]);
  });

  it("does not retry a second InvalidNonce failure", async () => {
    const viewAccessKey = vi.fn()
      .mockResolvedValueOnce({ nonce: 10n })
      .mockResolvedValueOnce({ nonce: 10n });
    const provider = { viewAccessKey } as unknown as Parameters<typeof sendWithNonceRetry>[0];
    const send = vi.fn().mockRejectedValue(new Error("InvalidNonce"));

    await expect(sendWithNonceRetry(provider, accountId, publicKey, new Map(), send))
      .rejects.toThrow("InvalidNonce");

    expect(viewAccessKey).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
