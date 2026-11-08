import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/index.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "seats-runner-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    NEAR_RPC_URL: "https://rpc.testnet.near.org",
    DAO_ID: "club.testnet",
    KEEPER_ACCOUNT_ID: "keeper.testnet",
    KEEPER_KEY_FILE: "/etc/secrets/keeper.json",
  };
}

describe("runner configuration", () => {
  it("continues to accept VOTERS-only configuration", () => {
    const directory = temporaryDirectory();
    const votersFile = join(directory, "voters.json");
    writeFileSync(votersFile, JSON.stringify([{
      voter_id: "voter.testnet",
      agent_key_file: "/etc/secrets/voter.json",
    }]));

    const config = loadConfig({ ...baseEnvironment(), VOTERS: votersFile });

    expect(config.voters).toEqual([{
      voter_id: "voter.testnet",
      agent_key_file: "/etc/secrets/voter.json",
    }]);
    expect(config.seatNftId).toBeUndefined();
    expect(config.runnerAgentKeyFile).toBeUndefined();
    expect(config.voterMinAvailableYocto).toBe(4_350_000_000_000_000_000_000_000n);
  });

  it("parses a configured minimum voter balance as decimal yoctoNEAR", () => {
    const directory = temporaryDirectory();
    const votersFile = join(directory, "voters.json");
    writeFileSync(votersFile, JSON.stringify([{
      voter_id: "voter.testnet",
      agent_key_file: "/etc/secrets/voter.json",
    }]));

    expect(loadConfig({
      ...baseEnvironment(),
      VOTERS: votersFile,
      VOTER_MIN_AVAILABLE_YOCTO: "123456789",
    }).voterMinAvailableYocto).toBe(123456789n);
  });

  it("rejects a non-decimal minimum voter balance", () => {
    const directory = temporaryDirectory();
    const votersFile = join(directory, "voters.json");
    writeFileSync(votersFile, JSON.stringify([{
      voter_id: "voter.testnet",
      agent_key_file: "/etc/secrets/voter.json",
    }]));

    expect(() => loadConfig({
      ...baseEnvironment(),
      VOTERS: votersFile,
      VOTER_MIN_AVAILABLE_YOCTO: "1.5",
    })).toThrow("VOTER_MIN_AVAILABLE_YOCTO must be a decimal yoctoNEAR string");
  });

  it("requires either VOTERS or the complete discovery configuration", () => {
    expect(() => loadConfig({})).toThrow(
      "Configure VOTERS or both SEAT_NFT_ID and RUNNER_AGENT_KEY_FILE",
    );
    expect(() => loadConfig({
      ...baseEnvironment(),
      SEAT_NFT_ID: "seats.testnet",
    })).toThrow("SEAT_NFT_ID and RUNNER_AGENT_KEY_FILE must be set together");
  });
});
