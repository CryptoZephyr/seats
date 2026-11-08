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
    ]),
    getSeatVoterId: vi.fn(async (_seatNftId: string, tokenId: string) => `voter-${tokenId}.testnet`),
    hasRequestVoteAccessKey: vi.fn(async () => true),
    getBriefHash: vi.fn(async () => "a".repeat(64)),
    getVoterConfiguration: vi.fn(async () => ({
      model_signer_hex: `0x${"b".repeat(40)}`,
      model: "model-v1",
      agent_wasm_url: "https://example.test/agent.wasm",
      agent_wasm_sha256: "c".repeat(64),
    })),
    ...overrides,
  };
}

describe("seat voter discovery", () => {
  it("adds configured voters with the runner key and skips unauthorized or unready seats", async () => {
    const requestVote = vi.fn();
    const rpc = createRpc({
      hasRequestVoteAccessKey: vi.fn(async (voterId) => voterId !== "voter-4.testnet"),
      getBriefHash: vi.fn(async (voterId) =>
        voterId === "voter-2.testnet" ? "" : "a".repeat(64)),
      getVoterConfiguration: vi.fn(async (voterId) => ({
        model_signer_hex: `0x${"b".repeat(40)}`,
        model: "model-v1",
        agent_wasm_url: voterId === "voter-3.testnet" ? "" : "https://example.test/agent.wasm",
        agent_wasm_sha256: voterId === "voter-3.testnet" ? "" : "c".repeat(64),
      })),
    }) as VoterDiscoveryRpc & { requestVote: typeof requestVote };
    rpc.requestVote = requestVote;
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await expect(discovery.refresh(rpc, seatNftId, publicKey, log)).resolves.toBe(true);

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
      reason: "agent_wasm_not_pinned",
    }));
  });

  it("logs an unready voter only once across successful scans", async () => {
    const rpc = createRpc({
      getBriefHash: vi.fn(async () => ""),
    });
    const log = vi.fn();
    const discovery = new SeatVoterDiscovery();

    await discovery.refresh(rpc, seatNftId, publicKey, log);
    await discovery.refresh(rpc, seatNftId, publicKey, log);

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

    await expect(discovery.refresh(rpc, seatNftId, publicKey, log)).resolves.toBe(true);
    await expect(discovery.refresh(rpc, seatNftId, publicKey, log)).resolves.toBe(false);

    expect(discovery.voters).toEqual(["voter-1.testnet"]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      action: "discover_voters",
      status: "error",
      error: "Error: RPC unavailable",
    }));
  });
});
