import { describe, expect, it, vi } from "vitest";
import {
  initialRunnerState,
  runTick,
  type AgentRunnerRpc,
  type RunnerState,
} from "../src/runner.js";

function createRpc(overrides: Partial<AgentRunnerRpc> = {}): AgentRunnerRpc {
  return {
    getLastProposalId: vi.fn(async () => 2),
    getProposals: vi.fn(async () => [{ id: 0, status: "InProgress" }, { id: 1, status: "InProgress" }]),
    getPending: vi.fn(async () => null),
    getResults: vi.fn(async () => ({ results: [] })),
    requestVote: vi.fn(async (_voterId: string, id: number) => `request-${id}`),
    cast: vi.fn(async (_voterId: string, id: number) => `cast-${id}`),
    ...overrides,
  };
}

function state(): RunnerState {
  return { cursor: -1, pendingByVoter: {} };
}

describe("initial runner state", () => {
  it("starts at the first proposal created after the runner starts", () => {
    expect(initialRunnerState(undefined, 8)).toEqual({ cursor: 7, pendingByVoter: {} });
  });

  it("uses START_PROPOSAL_ID as the first proposal to handle", () => {
    expect(initialRunnerState(12, 8)).toEqual({ cursor: 11, pendingByVoter: {} });
  });
});

describe("runTick with mocked RPC", () => {
  it("requests each in-progress proposal once and persists the cursor", async () => {
    const rpc = createRpc();
    const logs: unknown[] = [];
    const result = await runTick({
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: state(),
      nowNanoseconds: 0n,
      log: (entry) => logs.push(entry),
    });

    expect(rpc.requestVote).toHaveBeenCalledTimes(2);
    expect(result.cursor).toBe(1);
    expect(result.pendingByVoter["voter.testnet"]).toEqual([0, 1]);
    expect(logs).toHaveLength(2);
  });

  it("sends a voter's requests sequentially", async () => {
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const requestVote = vi.fn(async (_voterId: string, id: number) => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await Promise.resolve();
      activeCalls -= 1;
      return `request-${id}`;
    });
    const rpc = createRpc({ requestVote });

    await runTick({
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: state(),
      nowNanoseconds: 0n,
      log: () => undefined,
    });

    expect(requestVote.mock.calls.map(([, id]) => id)).toEqual([0, 1]);
    expect(maximumActiveCalls).toBe(1);
  });

  it("does not retry a failed request in the same tick and leaves its cursor for a later tick", async () => {
    const requestVote = vi.fn(async (_voterId: string, id: number) => {
      if (id === 0) {
        throw new Error("contract rejected request");
      }
      return `request-${id}`;
    });
    const rpc = createRpc({ requestVote });
    const result = await runTick({
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: state(),
      nowNanoseconds: 0n,
      log: () => undefined,
    });

    expect(requestVote.mock.calls.filter(([, id]) => id === 0)).toHaveLength(1);
    expect(result.cursor).toBe(-1);
  });

  it("skips pending and completed votes, then casts only an expired pending vote", async () => {
    const rpc = createRpc({
      getLastProposalId: vi.fn(async () => 0),
      getResults: vi.fn(async () => ({ results: [{ proposal_id: 5 }] })),
      getPending: vi.fn(async (_voterId: string, id: number) => {
        if (id === 5) {
          return { deadline: "999", casting: false };
        }
        if (id === 6) {
          return { deadline: "1000", casting: false };
        }
        return null;
      }),
    });
    const currentState: RunnerState = {
      cursor: 0,
      pendingByVoter: { "voter.testnet": [5, 6] },
    };
    const result = await runTick({
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: currentState,
      nowNanoseconds: 1000n,
      log: () => undefined,
    });

    expect(rpc.cast).toHaveBeenCalledTimes(1);
    expect(rpc.cast).toHaveBeenCalledWith("voter.testnet", 6);
    expect(rpc.requestVote).not.toHaveBeenCalled();
    expect(result.pendingByVoter["voter.testnet"]).toEqual([6]);
  });
});
