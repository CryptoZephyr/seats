import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseEncode } from "@near-js/utils";
import type { JsonRpcProvider } from "@near-js/providers";
import { describe, expect, it, vi } from "vitest";
import {
  callView,
  daoPolicy,
  findPendingProposalId,
  isMissingAccountError,
  isUninitializedContractError,
  main,
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

describe("uninitialized contract views", () => {
  it("recognizes panic and contract-state deserialization errors", () => {
    expect(isUninitializedContractError(new Error("The contract is not initialized"))).toBe(true);
    expect(isUninitializedContractError(new Error("Cannot deserialize the contract state"))).toBe(true);
    expect(isUninitializedContractError(new Error("wrapped", {
      cause: new Error("Contract must be initialized before usage"),
    }))).toBe(true);
    expect(isUninitializedContractError(new Error("connection refused"))).toBe(false);
  });

  it("does not decode a view response with missing result bytes", async () => {
    const provider = {
      sendJsonRpc: vi.fn().mockResolvedValue({}),
    } as unknown as JsonRpcProvider;
    await expect(callView(provider, "contract.testnet", "get_state", {}))
      .rejects.toThrow("View get_state returned no result bytes");
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

type ProposalState = { id: number; kind: any; status: string };

function deploymentFixture(mode: "fresh" | "midway" | "complete") {
  const root = mkdtempSync(join(tmpdir(), "seats-deploy-flow-"));
  const secrets = join(root, "secrets");
  const artifacts = join(root, "target/wasm32-unknown-unknown/release");
  mkdirSync(secrets, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(join(root, "deployments"), { recursive: true });
  const wasmFiles = {
    tee_verifier: "verifier wasm fixture",
    seat_voter: "voter wasm fixture",
    seat_nft: "seat wasm fixture",
  };
  for (const [name, contents] of Object.entries(wasmFiles)) {
    const fileName = name === "tee_verifier" ? "tee_verifier" : name;
    writeFileSync(join(artifacts, `${fileName}.wasm`), contents);
  }
  const codeHashes = Object.fromEntries(
    Object.entries(wasmFiles).map(([name, contents]) => [
      name,
      baseEncode(createHash("sha256").update(contents).digest()),
    ]),
  ) as Record<keyof typeof wasmFiles, string>;
  const expectedSigner = "a".repeat(64);
  const voterId = "voter-1.seat-voter.testnet";
  const daoId = "club.sputnikv2.testnet";
  const seatId = "seatsnft.testnet";
  const brief = {
    brief_hash: "b".repeat(64),
    secrets_account_id: "member-secrets.testnet",
    secrets_profile: "brief",
  };
  const stakingKind = { SetStakingContract: { staking_id: seatId } };
  const state = {
    verifierCodeHash: mode === "fresh" ? "" : codeHashes.tee_verifier,
    verifierInitialized: mode !== "fresh",
    verifierSigner: mode === "fresh" ? null : expectedSigner,
    daoExists: mode !== "fresh",
    daoBalance: mode === "fresh" ? 0n : mode === "midway" ? 8n * 10n ** 24n : 12n * 10n ** 24n,
    seatCodeHash: mode === "fresh" ? "" : codeHashes.seat_nft,
    seatInitialized: mode !== "fresh",
    seat: mode === "complete" ? { voter_id: voterId } : null as { voter_id: string } | null,
    stakingContract: mode === "complete" ? seatId : null as string | null,
    brief: mode === "complete" ? brief : {
      brief_hash: null,
      secrets_account_id: null,
      secrets_profile: null,
    },
    proposals: (mode === "midway"
      ? [{ id: 0, kind: stakingKind, status: "InProgress" }]
      : []) as ProposalState[],
  };
  const record: Record<string, unknown> = {
    status: "not_deployed",
    transactions: [],
  };
  if (mode !== "fresh") {
    record.seat_voter_global = { code_hash: codeHashes.seat_voter };
  }
  if (mode === "complete") {
    record.agent_configuration = {
      voter_id: voterId,
      model_signer: { address_hex: expectedSigner, model: "model-v1" },
      pinned_agent: { url: "https://example.test/agent.wasm", sha256: "c".repeat(64) },
    };
  }
  const recordPath = join(root, "deployments/testnet.json");
  writeFileSync(recordPath, JSON.stringify(record));
  writeFileSync(join(secrets, "quote.json"), JSON.stringify({
    quote_hex: "quote",
    collateral_json: "{}",
    nonce: "1",
    expected_signer: expectedSigner,
  }));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    network: "testnet",
    rpc_url: "https://test.rpc.fastnear.com",
    secrets_dir: secrets,
    funder_account_id: "funder.testnet",
    funder_key_file: "funder.json",
    verifier_account_id: "verifier.testnet",
    verifier_key_file: "verifier.json",
    dao_name: "club",
    member_account_id: "member.testnet",
    member_key_file: "member.json",
    seat_account_id: seatId,
    seat_key_file: "seat.json",
    agent_key_file: "agent.json",
    quote_args_file: "quote.json",
    model: "model-v1",
    brief_hash: brief.brief_hash,
    brief_secrets_account_id: brief.secrets_account_id,
    brief_secrets_profile: brief.secrets_profile,
    agent_wasm_url: "https://example.test/agent.wasm",
    agent_wasm_sha256: "c".repeat(64),
    window_seconds: 120,
    voter_funding_near: 5,
    dao_funding_near: mode === "midway" ? 8 : undefined,
  }));
  const methodCalls: string[] = [];
  const transactions: string[] = [];
  const transferAmounts: bigint[] = [];
  const provider = {
    viewAccount: async (accountId: string) => {
      if (accountId === daoId && !state.daoExists) {
        throw new Error(`account ${daoId} doesn't exist`);
      }
      return {
        amount: accountId === daoId ? String(state.daoBalance) : String(100n * 10n ** 24n),
        storage_usage: accountId === daoId ? 242_000 : 0,
        code_hash: accountId === seatId
          ? state.seatCodeHash
          : accountId === "verifier.testnet"
            ? state.verifierCodeHash
            : "",
      };
    },
    sendJsonRpc: async (_method: string, request: {
      account_id: string;
      method_name: string;
      args_base64: string;
    }) => {
      const args = JSON.parse(Buffer.from(request.args_base64, "base64").toString("utf8"));
      let result: unknown;
      if (request.method_name === "get_model_signer") {
        if (!state.verifierInitialized) throw new Error("The contract is not initialized");
        result = state.verifierSigner;
      } else if (request.method_name === "get_last_proposal_id") {
        result = state.proposals.length;
      } else if (request.method_name === "get_proposals") {
        result = state.proposals.slice(args.from_index, args.from_index + args.limit);
      } else if (request.method_name === "get_staking_contract") {
        result = state.stakingContract;
      } else if (request.method_name === "get_seat") {
        if (!state.seatInitialized) {
          return { error: { message: "Cannot deserialize the contract state" } };
        }
        result = state.seat;
      } else if (request.method_name === "get_brief") {
        result = state.brief;
      } else {
        throw new Error(`Unexpected view ${request.method_name}`);
      }
      return { result: Array.from(Buffer.from(JSON.stringify(result))) };
    },
  } as unknown as JsonRpcProvider;
  const call = async (
    _credential: unknown,
    receiver: string,
    method: string,
    args: any,
  ): Promise<{ hash: string; value: unknown }> => {
    methodCalls.push(method);
    let value: unknown = null;
    if (method === "new" && receiver === "verifier.testnet") {
      state.verifierInitialized = true;
    } else if (method === "register_model_signer") {
      state.verifierSigner = expectedSigner;
      value = expectedSigner;
    } else if (method === "create") {
      state.daoExists = true;
      state.daoBalance = 6n * 10n ** 24n;
    } else if (method === "new" && receiver === seatId) {
      state.seatInitialized = true;
    } else if (method === "add_proposal") {
      const id = state.proposals.length;
      state.proposals.push({ id, kind: args.proposal.kind, status: "InProgress" });
      value = id;
    } else if (method === "act_proposal") {
      const proposal = state.proposals.find(({ id }) => id === args.id);
      if (!proposal) throw new Error(`Unknown proposal ${args.id}`);
      proposal.status = "Approved";
      if ("SetStakingContract" in proposal.kind) {
        state.stakingContract = proposal.kind.SetStakingContract.staking_id;
      }
      const action = proposal.kind.FunctionCall?.actions?.[0];
      if (action?.method_name === "mint_seat") {
        state.seat = { voter_id: voterId };
      }
    } else if (method === "set_brief") {
      state.brief = args;
    }
    return { hash: `call-${methodCalls.length}`, value };
  };
  const sendActions = async (
    _provider: JsonRpcProvider,
    _credential: unknown,
    receiver: string,
    actions: unknown[],
  ): Promise<{ hash: string; value: unknown }> => {
    transactions.push(receiver);
    if (receiver === "verifier.testnet") state.verifierCodeHash = codeHashes.tee_verifier;
    if (receiver === seatId) state.seatCodeHash = codeHashes.seat_nft;
    if (receiver === daoId) {
      const action = actions[0] as { transfer?: { deposit?: unknown } };
      const amount = BigInt(String(action.transfer?.deposit));
      transferAmounts.push(amount);
      state.daoBalance += amount;
    }
    return { hash: `action-${transactions.length}`, value: null };
  };
  const loadCredential = (_path: string, accountId: string) => ({
    accountId,
    signer: {} as never,
    publicKey: {} as never,
  });
  return {
    root,
    configPath,
    provider,
    state,
    methodCalls,
    transactions,
    transferAmounts,
    recordPath,
    dependencies: {
      provider,
      artifactRoot: root,
      recordPath,
      loadCredential,
      publicKeyFromFile: () => "test-agent-public-key",
      call,
      sendActions,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("deployment reruns with an in-memory provider", () => {
  it("creates a fresh deployment in order, reuses a pending proposal, and sends nothing on a complete rerun", async () => {
    const fresh = deploymentFixture("fresh");
    const midway = deploymentFixture("midway");
    const complete = deploymentFixture("complete");
    try {
      await main(["--config", fresh.configPath], fresh.dependencies);
      expect(fresh.methodCalls).toEqual([
        "new",
        "register_model_signer",
        "create",
        "new",
        "add_proposal",
        "act_proposal",
        "add_proposal",
        "act_proposal",
        "add_proposal",
        "act_proposal",
        "add_proposal",
        "act_proposal",
        "set_brief",
      ]);
      expect(fresh.transactions).toHaveLength(4);
      expect(fresh.state.daoBalance).toBe(11n * 10n ** 24n);
      expect(fresh.transferAmounts).toEqual([5n * 10n ** 24n]);

      await main(["--config", midway.configPath], midway.dependencies);
      expect(midway.methodCalls).toEqual([
        "act_proposal",
        "add_proposal",
        "act_proposal",
        "add_proposal",
        "act_proposal",
        "add_proposal",
        "act_proposal",
        "set_brief",
      ]);
      expect(midway.state.proposals[0]?.status).toBe("Approved");
      expect(midway.transactions).toEqual(["club.sputnikv2.testnet"]);
      expect(midway.transferAmounts).toEqual([42n * 10n ** 22n]);
      expect(
        (JSON.parse(readFileSync(midway.recordPath, "utf8")) as {
          transactions: Array<{ label: string }>;
        }).transactions.filter(({ label }) => label === "dao_topup"),
      ).toHaveLength(1);

      await main(["--config", complete.configPath], complete.dependencies);
      expect(complete.methodCalls).toEqual([]);
      expect(complete.transactions).toEqual([]);
    } finally {
      fresh.cleanup();
      midway.cleanup();
      complete.cleanup();
    }
  });
});
