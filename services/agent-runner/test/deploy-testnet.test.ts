import { describe, expect, it, vi } from "vitest";
import {
  daoPolicy,
  findPendingProposalId,
  isMissingAccountError,
  parseProposalId,
} from "../src/deploy-testnet.js";
import { selectNextNonce, sendWithNonceRetry } from "../src/nonce.js";

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

describe("missing account detection", () => {
  it("recognizes near-api-js missing-account messages and UNKNOWN_ACCOUNT errors", () => {
    expect(isMissingAccountError(
      new Error("Can't complete the action because account fresh-dao.sputnikv2.testnet doesn't exist"),
    )).toBe(true);
    expect(isMissingAccountError(new Error("account fresh-dao.sputnikv2.testnet does not exist"))).toBe(true);
    expect(isMissingAccountError({ type: "UNKNOWN_ACCOUNT" })).toBe(true);
    expect(isMissingAccountError(new Error("wrapped RPC failure", {
      cause: { name: "UNKNOWN_ACCOUNT" },
    }))).toBe(true);
    expect(isMissingAccountError(new Error("connection refused"))).toBe(false);
  });
});

describe("DAO voting policy", () => {
  it("uses role weight for council calls without giving the council transfer weight", () => {
    const policy = daoPolicy("funder.testnet") as {
      roles: Array<{ name: string; vote_policy: Record<string, { weight_kind: string }> }>;
    };
    const council = policy.roles.find((role) => role.name === "council");
    const members = policy.roles.find((role) => role.name === "members");

    expect(council?.vote_policy.call?.weight_kind).toBe("RoleWeight");
    expect(council?.vote_policy.transfer).toBeUndefined();
    expect(members?.vote_policy.transfer?.weight_kind).toBe("TokenWeight");
  });
});

describe("pending DAO proposal lookup", () => {
  it("finds an in-progress proposal with a matching kind using mocked RPC views", async () => {
    const kind = { SetStakingContract: { staking_id: "seatsnft.testnet" } };
    const proposals = [
      { id: 0, kind, status: "InProgress" },
      { id: 1, kind, status: "Approved" },
      { id: 2, kind: { SetStakingContract: { staking_id: "other.testnet" } }, status: "InProgress" },
    ];
    const sendJsonRpc = vi.fn(async (_method: string, request: { method_name: string }) => ({
      result: Array.from(Buffer.from(JSON.stringify(
        request.method_name === "get_last_proposal_id" ? 3 : proposals,
      ))),
    }));
    const provider = { sendJsonRpc } as unknown as Parameters<typeof findPendingProposalId>[0];

    await expect(findPendingProposalId(provider, "seats.sputnikv2.testnet", kind)).resolves.toBe(0);

    expect(sendJsonRpc).toHaveBeenCalledTimes(2);
    expect(sendJsonRpc.mock.calls[1]?.[1]).toMatchObject({
      request_type: "call_function",
      finality: "optimistic",
      account_id: "seats.sputnikv2.testnet",
      method_name: "get_proposals",
    });
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
