import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplicationProposalKind,
  createVoterDefaultsProposalKind,
  readDeploymentAgentConfiguration,
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
