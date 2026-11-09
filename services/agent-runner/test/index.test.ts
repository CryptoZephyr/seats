import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findNewlyDiscoveredVoterIds, loadConfig } from "../src/index.js";

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

describe("discovered voter cursor handling", () => {
  it("does not treat a voter kept after a view failure as new", () => {
    const previousDiscoveredVoterIds = new Set(["known.testnet"]);

    expect(findNewlyDiscoveredVoterIds(
      ["known.testnet"],
      previousDiscoveredVoterIds,
      [],
    )).toEqual([]);
  });
});

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    NEAR_RPC_URL: "https://rpc.testnet.fastnear.com",
    DAO_ID: "club.testnet",
    KEEPER_ACCOUNT_ID: "keeper.testnet",
    KEEPER_KEY_FILE: "/etc/secrets/keeper.json",
  };
}

function votersEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const directory = temporaryDirectory();
  const votersFile = join(directory, "voters.json");
  writeFileSync(votersFile, JSON.stringify([{
    voter_id: "voter.testnet",
    agent_key_file: "/etc/secrets/voter.json",
  }]));
  return { ...baseEnvironment(), VOTERS: votersFile, ...overrides };
}

describe("runner configuration", () => {
  it("uses testnet fallback RPC URLs by default", () => {
    const config = loadConfig(votersEnvironment());

    expect(config.rpcUrls).toEqual([
      "https://rpc.testnet.fastnear.com",
      "https://test.rpc.fastnear.com",
      "https://near-testnet.drpc.org",
    ]);
  });

  it("accepts custom testnet fallback URLs and removes duplicates", () => {
    const config = loadConfig(votersEnvironment({
      NEAR_RPC_FALLBACK_URLS: [
        "https://rpc.testnet.fastnear.com/",
        "https://custom.testnet.example",
        "https://near-testnet.drpc.org",
        "https://custom.testnet.example",
      ].join(", "),
    }));

    expect(config.rpcUrls).toEqual([
      "https://rpc.testnet.fastnear.com",
      "https://custom.testnet.example",
      "https://near-testnet.drpc.org",
    ]);
  });

  it("rejects non-testnet fallback URLs", () => {
    expect(() => loadConfig(votersEnvironment({
      NEAR_RPC_FALLBACK_URLS: "https://rpc.mainnet.near.org",
    }))).toThrow("NEAR_RPC_FALLBACK_URLS must point to NEAR testnet");
  });

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
