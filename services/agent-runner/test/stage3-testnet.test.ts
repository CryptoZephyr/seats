import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCouncilCanApproveVoterDefaults,
  assertVoterDefaultsMatch,
  assertVisitorApplicationsReady,
  checkVoterDefaultsProposalState,
  createApplicationProposalKind,
  createDesiredPolicy,
  createPolicyDiff,
  createVoterDefaultsProposalKind,
  readDeploymentAgentConfiguration,
  voterDefaultsMatch,
} from "../src/stage3-testnet.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stage 3 deployment defaults", () => {
  it("reads the recorded agent configuration and lowercases the signer address", () => {
    const directory = mkdtempSync(join(tmpdir(), "seats-agent-configuration-"));
    temporaryDirectories.push(directory);
    const deploymentPath = join(directory, "testnet.json");
    writeFileSync(deploymentPath, JSON.stringify({
      agent_configuration: {
        voter_id: "s1.seatsnft.testnet",
        model_signer: {
          address_hex: "0xABCD0123456789abcdef0123456789ABCDEF0123",
          model: "model-v1",
        },
        pinned_agent: {
          url: "https://example.test/agent.wasm",
          sha256: "a".repeat(64),
        },
      },
    }));

    expect(readDeploymentAgentConfiguration(deploymentPath)).toEqual({
      voter_id: "s1.seatsnft.testnet",
      model_signer_hex: "0xabcd0123456789abcdef0123456789abcdef0123",
      model: "model-v1",
      agent_wasm_url: "https://example.test/agent.wasm",
      agent_wasm_sha256: "a".repeat(64),
    });
  });
});

describe("visitor application proposal", () => {
  it("uses a zero-deposit 10 Tgas approval action with a seven-day expiry", () => {
    const kind = createApplicationProposalKind("seats.testnet", "visitor.testnet") as {
      FunctionCall: {
        receiver_id: string;
        actions: Array<{
          method_name: string;
          args: string;
          deposit: string;
          gas: string;
        }>;
      };
    };
    const [action] = kind.FunctionCall.actions;

    expect(kind.FunctionCall.receiver_id).toBe("seats.testnet");
    expect(action).toMatchObject({
      method_name: "approve_application",
      deposit: "0",
      gas: "10000000000000",
    });
    expect(JSON.parse(Buffer.from(action.args, "base64").toString("utf8"))).toEqual({
      applicant: "visitor.testnet",
      expires_in_ns: 604_800_000_000_000,
    });
  });
});

describe("voter defaults proposal", () => {
  it("requires live voter defaults to match deployment values, ignoring signer hex case", () => {
    const expected = {
      model_signer_hex: `0x${"a".repeat(40)}`,
      model: "model-v1",
      agent_wasm_url: "https://example.test/agent.wasm",
      agent_wasm_sha256: "b".repeat(64),
    };
    const live = {
      ...expected,
      model_signer_hex: `0x${"A".repeat(40)}`,
    };

    expect(voterDefaultsMatch(live, expected)).toBe(true);
    expect(voterDefaultsMatch({ ...live, model: "different-model" }, expected)).toBe(false);
    expect(voterDefaultsMatch(null, expected)).toBe(false);
    expect(() => assertVoterDefaultsMatch(live, expected, "seats.testnet")).not.toThrow();
    expect(() => assertVoterDefaultsMatch(null, expected, "seats.testnet"))
      .toThrow("must match deployments/testnet.json");
  });

  it("returns already_set without checking council votes when defaults match", async () => {
    const expected = {
      model_signer_hex: `0x${"a".repeat(40)}`,
      model: "model-v1",
      agent_wasm_url: "https://example.test/agent.wasm",
      agent_wasm_sha256: "b".repeat(64),
    };
    const live = { ...expected, model_signer_hex: expected.model_signer_hex.toUpperCase() };
    let policyReads = 0;
    const decision = await checkVoterDefaultsProposalState(live, expected, async () => {
      policyReads += 1;
      throw new Error("policy should not be read when defaults are already set");
    });

    expect(decision).toEqual({ status: "already_set" });
    expect(policyReads).toBe(0);
  });

  it("checks council call-vote permission only when a defaults write is needed", async () => {
    const expected = {
      model_signer_hex: `0x${"a".repeat(40)}`,
      model: "model-v1",
      agent_wasm_url: "https://example.test/agent.wasm",
      agent_wasm_sha256: "b".repeat(64),
    };
    let policyReads = 0;
    const decision = checkVoterDefaultsProposalState(null, expected, async () => {
      policyReads += 1;
      return {
        roles: [{
          name: "council",
          kind: { Group: ["council.testnet"] },
          permissions: ["policy:*"],
          vote_policy: {},
        }],
        proposal_bond: "0",
      };
    });

    await expect(decision).rejects.toThrow("Voter defaults must be set first");
    expect(policyReads).toBe(1);
  });

  it("encodes the defaults under the named method argument", () => {
    const defaults = {
      model_signer_hex: "0x" + "a".repeat(40),
      model: "model-v1",
      agent_wasm_url: "https://example.test/agent.wasm",
      agent_wasm_sha256: "b".repeat(64),
    };
    const kind = createVoterDefaultsProposalKind("seats.testnet", defaults) as {
      FunctionCall: {
        receiver_id: string;
        actions: Array<{
          method_name: string;
          args: string;
          deposit: string;
          gas: string;
        }>;
      };
    };
    const [action] = kind.FunctionCall.actions;

    expect(kind.FunctionCall.receiver_id).toBe("seats.testnet");
    expect(action).toMatchObject({
      method_name: "set_voter_defaults",
      deposit: "0",
      gas: "50000000000000",
    });
    expect(JSON.parse(Buffer.from(action.args, "base64").toString("utf8"))).toEqual({
      defaults,
    });
  });
});

describe("combined DAO policy proposal", () => {
  const governanceLabels = [
    "config",
    "policy",
    "add_member_to_role",
    "remove_member_from_role",
    "upgrade_self",
    "upgrade_remote",
    "set_vote_token",
    "factory_info_update",
    "policy_add_or_update_role",
    "policy_remove_role",
    "policy_update_default_vote_policy",
    "policy_update_parameters",
  ];

  function policyFixture() {
    return {
      roles: [
        {
          name: "council",
          kind: { Group: ["council.testnet"] },
          permissions: ["*:*"],
          vote_policy: {
            call: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
          },
        },
        {
          name: "members",
          kind: { Member: "1" },
          permissions: ["call:VoteApprove", "transfer:VoteApprove"],
          vote_policy: {
            call: { weight_kind: "TokenWeight", quorum: "0", threshold: [1, 2] },
          },
        },
        {
          name: "visitors",
          kind: "Group",
          permissions: ["call:VoteApprove"],
          vote_policy: {},
        },
        {
          name: "visitors",
          kind: "Group",
          permissions: ["transfer:VoteApprove"],
          vote_policy: {},
        },
      ],
      default_vote_policy: {
        weight_kind: "TokenWeight",
        quorum: "0",
        threshold: [1, 2],
      },
      proposal_bond: "0",
      proposal_period: "600000000000",
      bounty_bond: "7",
      bounty_forgiveness_period: "11",
    };
  }

  it("sets the council governance policy and preserves members and unrelated parameters", () => {
    const current = policyFixture();
    const membersBytes = JSON.stringify(current.roles.find((role) => role.name === "members"));
    const desired = createDesiredPolicy(current);
    const council = desired.roles.find((role) => role.name === "council");
    const votePolicy = Object.fromEntries(governanceLabels.map((label) => [
      label,
      { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    ]));

    expect(council?.kind).toEqual(current.roles[0].kind);
    expect(council?.permissions).toEqual([
      "*:AddProposal",
      "*:Finalize",
      ...governanceLabels.map((label) => `${label}:*`),
    ]);
    expect(council?.vote_policy).toEqual(votePolicy);
    expect(Object.keys(council?.vote_policy ?? {})).not.toContain("call");
    expect(Object.keys(council?.vote_policy ?? {})).not.toContain("transfer");
    expect(Object.keys(council?.vote_policy ?? {})).not.toContain("*");
    expect(council?.permissions.some((permission) => /^(call|transfer):Vote/.test(permission)))
      .toBe(false);
    expect(council?.permissions).not.toContain("*:*");
    expect(JSON.stringify(desired.roles.find((role) => role.name === "members"))).toBe(membersBytes);
    expect(desired.proposal_bond).toBe("100000000000000000000000");
    expect(desired.proposal_period).toBe(current.proposal_period);
    expect(desired.bounty_bond).toBe(current.bounty_bond);
    expect(desired.bounty_forgiveness_period).toBe(current.bounty_forgiveness_period);
    expect(desired.default_vote_policy).toBe(current.default_vote_policy);
  });

  it("adds or replaces exactly one visitor role and is idempotent", () => {
    const current = policyFixture();
    const desired = createDesiredPolicy(current);
    const visitors = desired.roles.filter((role) => role.name === "visitors");
    const expected = {
      name: "visitors",
      kind: "Everyone",
      permissions: ["call:AddProposal"],
      vote_policy: {},
    };

    expect(visitors).toEqual([expected]);
    expect(createDesiredPolicy(desired)).toEqual(desired);

    const withoutVisitors = {
      ...current,
      roles: current.roles.filter((role) => role.name !== "visitors"),
    };
    expect(createDesiredPolicy(withoutVisitors).roles.filter((role) => role.name === "visitors"))
      .toEqual([expected]);
  });

  it("shows the policy diff and refuses defaults or visitor apply at the wrong stage", () => {
    const current = policyFixture();
    const desired = createDesiredPolicy(current);
    const diff = createPolicyDiff(current, desired) as {
      proposal_bond: { before: string; after: string };
      roles: Record<string, unknown>;
    };

    expect(diff.proposal_bond).toEqual({
      before: "0",
      after: "100000000000000000000000",
    });
    expect(Object.keys(diff.roles)).toEqual(["council", "visitors"]);
    expect(() => assertCouncilCanApproveVoterDefaults(current)).not.toThrow();
    expect(() => assertCouncilCanApproveVoterDefaults(desired))
      .toThrow("Voter defaults must be set first");
    expect(() => assertVisitorApplicationsReady(current))
      .toThrow("council call:VoteApprove");
    expect(() => assertVisitorApplicationsReady(desired)).not.toThrow();
  });
});
