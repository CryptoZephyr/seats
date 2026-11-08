import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeploymentAgentConfiguration } from "../src/stage3-testnet.js";

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
