import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState } from "../src/index.js";
import {
  initialRunnerState,
  isProposalPeriodTooShort,
  runTick,
  type AgentRunnerRpc,
  type RunnerState,
} from "../src/runner.js";

function createRpc(overrides: Partial<AgentRunnerRpc> = {}): AgentRunnerRpc {
  return {
    getLastProposalId: vi.fn(async () => 2),
    getProposalPeriodNs: vi.fn(async () => 600_000_000_000n),
    getProposals: vi.fn(async () => [{ id: 0, status: "InProgress" }, { id: 1, status: "InProgress" }]),
    getPending: vi.fn(async () => null),
    getResults: vi.fn(async () => ({ results: [] })),
    requestVote: vi.fn(async (_voterId: string, id: number) => `request-${id}`),
    cast: vi.fn(async (_voterId: string, id: number) => `cast-${id}`),
    ...overrides,
  };
}

function state(): RunnerState {
  return { cursor: -1, pendingByVoter: {}, inFlight: {} };
}

describe("initial runner state", () => {
  it("starts at the first proposal created after the runner starts", () => {
    expect(initialRunnerState(undefined, 8)).toEqual({
      cursor: 7,
      pendingByVoter: {},
      inFlight: {},
    });
  });

  it("uses START_PROPOSAL_ID as the first proposal to handle", () => {
    expect(initialRunnerState(12, 8)).toEqual({
      cursor: 11,
      pendingByVoter: {},
      inFlight: {},
    });
  });

  it("warns when the DAO proposal period is below the voter window plus the safety margin", () => {
    expect(isProposalPeriodTooShort(419_000_000_000n, 120)).toBe(true);
    expect(isProposalPeriodTooShort(420_000_000_000n, 120)).toBe(false);
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
      nowMilliseconds: 0,
      requestTtlMs: 180_000,
      persistState: () => undefined,
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
      nowMilliseconds: 0,
      requestTtlMs: 180_000,
      persistState: () => undefined,
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
      nowMilliseconds: 0,
      requestTtlMs: 180_000,
      persistState: () => undefined,
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
      inFlight: {},
    };
    const result = await runTick({
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: currentState,
      nowNanoseconds: 1000n,
      nowMilliseconds: 0,
      requestTtlMs: 180_000,
      persistState: () => undefined,
      log: () => undefined,
    });

    expect(rpc.cast).toHaveBeenCalledTimes(1);
    expect(rpc.cast).toHaveBeenCalledWith("voter.testnet", 6);
    expect(rpc.requestVote).not.toHaveBeenCalled();
    expect(result.pendingByVoter["voter.testnet"]).toEqual([6]);
  });

  it("keeps a timed-out request in flight, then adopts and later casts its pending vote", async () => {
    const currentState = state();
    let pending: { deadline: string; casting: boolean } | null = null;
    const getPending = vi.fn(async () => pending);
    const persistState = vi.fn((_value: RunnerState) => undefined);
    const requestVote = vi.fn(async () => {
      expect(currentState.inFlight["voter.testnet"]?.["0"]).toBe(1000);
      expect(persistState).toHaveBeenCalled();
      throw new Error("Timeout error");
    });
    const rpc = createRpc({
      getLastProposalId: vi.fn(async () => 1),
      getProposals: vi.fn(async () => [{ id: 0, status: "InProgress" }]),
      getPending,
      requestVote,
    });
    const options = {
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: currentState,
      requestTtlMs: 180_000,
      persistState,
      log: () => undefined,
    };

    await runTick({ ...options, nowMilliseconds: 1000, nowNanoseconds: 0n });
    expect(requestVote).toHaveBeenCalledTimes(1);

    pending = { deadline: "5000", casting: false };
    await runTick({ ...options, nowMilliseconds: 1001, nowNanoseconds: 1000n });
    expect(requestVote).toHaveBeenCalledTimes(1);
    expect(currentState.inFlight).toEqual({});
    expect(currentState.pendingByVoter["voter.testnet"]).toEqual([0]);
    expect(rpc.cast).not.toHaveBeenCalled();

    pending = { deadline: "0", casting: false };
    await runTick({ ...options, nowMilliseconds: 1002, nowNanoseconds: 6000n });
    expect(rpc.cast).toHaveBeenCalledWith("voter.testnet", 0);
  });

  it("does not resend a timed-out request before the TTL expires", async () => {
    const currentState = state();
    const requestVote = vi.fn()
      .mockRejectedValueOnce(new Error("Timeout error"))
      .mockResolvedValue("request-0");
    const rpc = createRpc({
      getLastProposalId: vi.fn(async () => 1),
      getProposals: vi.fn(async () => [{ id: 0, status: "InProgress" }]),
      requestVote,
    });
    const logs: Array<{ reason?: string }> = [];
    const options = {
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: currentState,
      nowNanoseconds: 0n,
      requestTtlMs: 180_000,
      persistState: () => undefined,
      log: (entry: { reason?: string }) => logs.push(entry),
    };

    await runTick({ ...options, nowMilliseconds: 5000 });
    await runTick({ ...options, nowMilliseconds: 184_999 });

    expect(requestVote).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(expect.objectContaining({ reason: "request_in_flight" }));
  });

  it("allows one resend after the TTL and logs the retry reason", async () => {
    const currentState = state();
    const requestVote = vi.fn()
      .mockRejectedValueOnce(new Error("Timeout error"))
      .mockResolvedValue("request-0");
    const rpc = createRpc({
      getLastProposalId: vi.fn(async () => 1),
      getProposals: vi.fn(async () => [{ id: 0, status: "InProgress" }]),
      requestVote,
    });
    const logs: Array<{ reason?: string }> = [];
    const options = {
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: currentState,
      nowNanoseconds: 0n,
      requestTtlMs: 180_000,
      persistState: () => undefined,
      log: (entry: { reason?: string }) => logs.push(entry),
    };

    await runTick({ ...options, nowMilliseconds: 100 });
    await runTick({ ...options, nowMilliseconds: 180_101 });

    expect(requestVote).toHaveBeenCalledTimes(2);
    expect(currentState.inFlight["voter.testnet"]?.["0"]).toBe(180_101);
    expect(logs).toContainEqual(expect.objectContaining({ reason: "request_retry_after_ttl" }));
  });

  it("adopts an existing pending vote reported by ERR_PENDING_EXISTS", async () => {
    const currentState = state();
    const pendingVote = { deadline: "10000000000", casting: false };
    const getPending = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(pendingVote);
    const rpc = createRpc({
      getLastProposalId: vi.fn(async () => 1),
      getProposals: vi.fn(async () => [{ id: 0, status: "InProgress" }]),
      getPending,
      requestVote: vi.fn(async () => {
        throw new Error("ERR_PENDING_EXISTS");
      }),
    });

    await runTick({
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: currentState,
      nowNanoseconds: 1n,
      nowMilliseconds: 100,
      requestTtlMs: 180_000,
      persistState: () => undefined,
      log: () => undefined,
    });

    expect(currentState.inFlight).toEqual({});
    expect(currentState.pendingByVoter["voter.testnet"]).toEqual([0]);
  });

  it("clears in-flight state after a definite contract panic", async () => {
    const currentState = state();
    const rpc = createRpc({
      getLastProposalId: vi.fn(async () => 1),
      getProposals: vi.fn(async () => [{ id: 0, status: "InProgress" }]),
      requestVote: vi.fn(async () => {
        throw new Error("FunctionCallError: ERR_BRIEF_NOT_SET");
      }),
    });

    await runTick({
      rpc,
      daoId: "club.testnet",
      voters: [{ voterId: "voter.testnet" }],
      state: currentState,
      nowNanoseconds: 0n,
      nowMilliseconds: 1234,
      requestTtlMs: 180_000,
      persistState: () => undefined,
      log: () => undefined,
    });

    expect(currentState.inFlight).toEqual({});
  });

  it("loads an older state file without inFlight", () => {
    const directory = mkdtempSync(join(tmpdir(), "seats-runner-state-"));
    const stateFile = join(directory, "state.json");
    try {
      writeFileSync(stateFile, JSON.stringify({ cursor: 4, pendingByVoter: { "voter.testnet": [3] } }));
      expect(readState(stateFile)).toEqual({
        cursor: 4,
        pendingByVoter: { "voter.testnet": [3] },
        inFlight: {},
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
