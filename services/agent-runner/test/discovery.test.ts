import { describe, expect, it, vi } from "vitest";
import {
  mergeVoterSources,
  SeatVoterDiscovery,
  type VoterDiscoveryRpc,
} from "../src/discovery.js";

const seatNftId = "seats.testnet";
const publicKey = "ed25519:shared-key";

function createRpc(overrides: Partial<VoterDiscoveryRpc> = {}): VoterDiscoveryRpc {
  return {
    getSeatTokenPage: vi.fn(async () => [
      { token_id: "1" },
      { token_id: "2" },
      { token_id: "3" },
      { token_id: "4" },
      { token_id: "5" },
    ]),
    getSeatVoterId: vi.fn(async (_seatNftId: string, tokenId: string) => `voter-${tokenId}.testnet`),
    hasRequestVoteAccessKey: vi.fn(async () => true),
    getBriefHash: vi.fn(async () => "a".repeat(64)),
    ...overrides,
  };
}

describe("seat voter discovery", () => {
  it("adds voters with the runner key and a brief, skipping unauthorized or unready seats", async () => {
    const requestVote = vi.fn();
    const rpc = createRpc({
      getSeatVoterId: vi.fn(async (_seatNftId: string, tokenId: string) => {
        if (tokenId === "5") throw new Error("get_seat failed");
        return `voter-${tokenId}.testnet`;
      }),
      hasRequestVoteAccessKey: vi.fn(async (voterId) => voterId !== "voter-4.testnet"),
      getBriefHash: vi.fn(async (voterId) =>
        voterId === "voter-2.testnet"
          ? ""
          : voterId === "voter-3.testnet"
            ? Promise.reject(new Error("brief view failed"))
            : "a".repeat(64)),
    }) as VoterDiscoveryRpc & { requestVote: typeof requestVote };
    rpc.requestVote = requestVote;
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await expect(discovery.refresh(rpc, seatNftId, publicKey, new Set(), log)).resolves.toBe(true);

    expect(discovery.voters).toEqual(["voter-1.testnet"]);
    expect(rpc.getSeatTokenPage).toHaveBeenCalledWith(seatNftId, 0, 100);
    expect(rpc.hasRequestVoteAccessKey).toHaveBeenCalledWith("voter-1.testnet", publicKey);
    expect(requestVote).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      voter_id: "voter-2.testnet",
      status: "skipped",
      reason: "brief_not_set",
    }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      voter_id: "voter-3.testnet",
      status: "skipped",
      reason: "brief_view_failed",
      error: "Error: brief view failed",
    }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped",
      reason: "get_seat_failed",
      error: "Error: get_seat failed",
    }));
  });

  it("logs an unready voter only once across successful scans", async () => {
    const rpc = createRpc({
      getBriefHash: vi.fn(async () => ""),
    });
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(), log);
    await discovery.refresh(rpc, seatNftId, publicKey, new Set(discovery.voters), log);

    expect(log.mock.calls.filter(([entry]) => entry.voter_id === "voter-1.testnet")).toHaveLength(1);
  });

  it("keeps file credentials ahead of discovered entries", () => {
    expect(mergeVoterSources(
      ["voter-1.testnet", "voter-file.testnet"],
      ["voter-1.testnet", "voter-discovered.testnet"],
    )).toEqual([
      { voterId: "voter-1.testnet", source: "file" },
      { voterId: "voter-file.testnet", source: "file" },
      { voterId: "voter-discovered.testnet", source: "discovered" },
    ]);
  });

  it("keeps the last good list when a discovery scan fails", async () => {
    const getSeatTokenPage = vi.fn()
      .mockResolvedValueOnce([{ token_id: "1" }])
      .mockRejectedValueOnce(new Error("RPC unavailable"));
    const rpc = createRpc({ getSeatTokenPage });
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await expect(discovery.refresh(rpc, seatNftId, publicKey, new Set(), log)).resolves.toBe(true);
    await expect(discovery.refresh(rpc, seatNftId, publicKey, new Set(discovery.voters), log)).resolves.toBe(false);

    expect(discovery.voters).toEqual(["voter-1.testnet"]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      action: "discover_voters",
      status: "error",
      error: "Error: RPC unavailable",
    }));
  });

  it("keeps a known voter when its access-key view fails", async () => {
    const hasRequestVoteAccessKey = vi.fn(async (_voterId: string) => true);
    const rpc = createRpc({ hasRequestVoteAccessKey });
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(), log);
    hasRequestVoteAccessKey.mockRejectedValueOnce(new Error("RPC unavailable"));

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(discovery.voters), log);

    expect(discovery.voters).toContain("voter-1.testnet");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      voter_id: "voter-1.testnet",
      status: "warning",
      reason: "kept_after_view_failure",
      error: "Error: RPC unavailable",
    }));
  });

  it("keeps a known voter when its brief view fails", async () => {
    const getBriefHash = vi.fn(async (_voterId: string) => "a".repeat(64));
    const rpc = createRpc({ getBriefHash });
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(), log);
    getBriefHash.mockRejectedValueOnce(new Error("RPC unavailable"));

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(discovery.voters), log);

    expect(discovery.voters).toContain("voter-1.testnet");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      voter_id: "voter-1.testnet",
      status: "warning",
      reason: "kept_after_view_failure",
      error: "Error: RPC unavailable",
    }));
  });

  it("does not add an unknown voter when its access-key view fails", async () => {
    const rpc = createRpc({
      getSeatTokenPage: vi.fn(async () => [{ token_id: "1" }]),
      hasRequestVoteAccessKey: vi.fn(async () => Promise.reject(new Error("RPC unavailable"))),
    });
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(), log);

    expect(discovery.voters).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      voter_id: "voter-1.testnet",
      status: "skipped",
      reason: "access_key_view_failed",
    }));
  });

  it("removes a previously discovered voter when the access-key view says false", async () => {
    const hasRequestVoteAccessKey = vi.fn(async (_voterId: string) => true);
    const rpc = createRpc({ hasRequestVoteAccessKey });
    const discovery = new SeatVoterDiscovery();

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(), vi.fn());
    hasRequestVoteAccessKey.mockImplementation(async (voterId) => voterId !== "voter-1.testnet");

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(discovery.voters), vi.fn());

    expect(discovery.voters).not.toContain("voter-1.testnet");
  });

  it("keeps the previous voter for a token when getSeatVoterId fails", async () => {
    const getSeatVoterId = vi.fn(async (_seatNftId: string, tokenId: string) => `voter-${tokenId}.testnet`);
    const rpc = createRpc({
      getSeatTokenPage: vi.fn(async () => [{ token_id: "1" }]),
      getSeatVoterId,
    });
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(), log);
    getSeatVoterId.mockRejectedValueOnce(new Error("RPC unavailable"));

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(discovery.voters), log);

    expect(discovery.voters).toEqual(["voter-1.testnet"]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      voter_id: "voter-1.testnet",
      status: "warning",
      reason: "kept_after_view_failure",
    }));
  });

  it("removes a previously discovered voter when its brief is empty", async () => {
    const getBriefHash = vi.fn(async (_voterId: string) => "a".repeat(64));
    const rpc = createRpc({ getBriefHash });
    const discovery = new SeatVoterDiscovery();

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(), vi.fn());
    getBriefHash.mockImplementation(async (voterId) => voterId === "voter-1.testnet" ? "" : "a".repeat(64));

    await discovery.refresh(rpc, seatNftId, publicKey, new Set(discovery.voters), vi.fn());

    expect(discovery.voters).not.toContain("voter-1.testnet");
  });
});
