import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { SeatVoterDiscovery, mergeVoterSources, type VoterSource } from "./discovery.js";
import { loadCredential, NearAgentRpc, type KeyFileCredential } from "./rpc.js";
import {
  parseKeepaliveConfig,
  startHealthServer,
  startKeepalive,
} from "./health.js";
import {
  initialRunnerState,
  isProposalPeriodTooShort,
  runTick,
  type ActionLog,
  type RunnerState,
} from "./runner.js";

interface VoterConfig {
  voter_id: string;
  agent_key_file: string;
}

interface Config {
  rpcUrl: string;
  daoId: string;
  voters: VoterConfig[];
  seatNftId?: string;
  runnerAgentKeyFile?: string;
  keeperAccountId: string;
  keeperKeyFile: string;
  pollMs: number;
  windowSeconds: number;
  requestTtlMs: number;
  startProposalId?: number;
  lookbackProposals: number;
  port?: number;
  keepaliveUrl?: string;
  keepaliveMs: number;
  stateFile: string;
}

let healthServer: Server | undefined;
let keepaliveTimer: NodeJS.Timeout | undefined;

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertTestnetAccountId(accountId: string, name: string): void {
  if (!accountId.endsWith(".testnet")) {
    throw new Error(`${name} must be a .testnet account`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const votersFile = env.VOTERS?.trim();
  const seatNftId = env.SEAT_NFT_ID?.trim() || undefined;
  const runnerAgentKeyFile = env.RUNNER_AGENT_KEY_FILE?.trim() || undefined;
  if (Boolean(seatNftId) !== Boolean(runnerAgentKeyFile)) {
    throw new Error("SEAT_NFT_ID and RUNNER_AGENT_KEY_FILE must be set together");
  }
  if (!votersFile && !seatNftId) {
    throw new Error("Configure VOTERS or both SEAT_NFT_ID and RUNNER_AGENT_KEY_FILE");
  }

  const voters = votersFile
    ? JSON.parse(readFileSync(resolve(votersFile), "utf8")) as VoterConfig[]
    : [];
  if (!Array.isArray(voters)) {
    throw new Error("VOTERS must contain a JSON array");
  }
  for (const voter of voters) {
    if (
      !voter
      || typeof voter.voter_id !== "string"
      || typeof voter.agent_key_file !== "string"
      || !voter.agent_key_file.trim()
    ) {
      throw new Error("Each VOTERS entry needs voter_id and agent_key_file strings");
    }
    assertTestnetAccountId(voter.voter_id, "VOTERS voter_id");
  }
  if (voters.length === 0 && !seatNftId) {
    throw new Error("VOTERS must contain at least one entry when discovery is disabled");
  }

  const rpcUrl = required("NEAR_RPC_URL", env);
  if (!new URL(rpcUrl).hostname.toLowerCase().includes("testnet")) {
    throw new Error("NEAR_RPC_URL must point to NEAR testnet");
  }
  const daoId = required("DAO_ID", env);
  assertTestnetAccountId(daoId, "DAO_ID");
  if (seatNftId) assertTestnetAccountId(seatNftId, "SEAT_NFT_ID");
  const keeperAccountId = required("KEEPER_ACCOUNT_ID", env);
  assertTestnetAccountId(keeperAccountId, "KEEPER_ACCOUNT_ID");

  const pollMs = Number(env.POLL_MS ?? "15000");
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new Error("POLL_MS must be a positive integer");
  }
  const windowSeconds = Number(env.WINDOW_SECONDS ?? "120");
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("WINDOW_SECONDS must be a positive integer");
  }
  const requestTtlMs = Number(env.REQUEST_TTL_MS ?? "180000");
  if (!Number.isSafeInteger(requestTtlMs) || requestTtlMs < 1) {
    throw new Error("REQUEST_TTL_MS must be a positive integer");
  }
  const startProposalIdValue = env.START_PROPOSAL_ID?.trim();
  const startProposalId = startProposalIdValue ? Number(startProposalIdValue) : undefined;
  if (startProposalId !== undefined && (!Number.isSafeInteger(startProposalId) || startProposalId < 0)) {
    throw new Error("START_PROPOSAL_ID must be a non-negative integer");
  }
  const lookbackValue = env.LOOKBACK_PROPOSALS;
  const lookbackProposals = lookbackValue === undefined ? 20 : Number(lookbackValue);
  if (!Number.isSafeInteger(lookbackProposals) || lookbackProposals < 0) {
    throw new Error("LOOKBACK_PROPOSALS must be a non-negative integer");
  }
  const portValue = env.PORT;
  const port = portValue === undefined ? undefined : Number(portValue);
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65_535)) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  const keepalive = parseKeepaliveConfig(env);
  return {
    rpcUrl,
    daoId,
    voters,
    ...(seatNftId ? { seatNftId } : {}),
    ...(runnerAgentKeyFile ? { runnerAgentKeyFile } : {}),
    keeperAccountId,
    keeperKeyFile: required("KEEPER_KEY_FILE", env),
    pollMs,
    windowSeconds,
    requestTtlMs,
    startProposalId,
    lookbackProposals,
    port,
    keepaliveUrl: keepalive.url,
    keepaliveMs: keepalive.intervalMs,
    stateFile: resolve(process.cwd(), "state.json"),
  };
}

export function readState(stateFile: string): RunnerState | null {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<RunnerState>;
    if (
      !Number.isSafeInteger(state.cursor) ||
      !state.pendingByVoter ||
      typeof state.pendingByVoter !== "object" ||
      Array.isArray(state.pendingByVoter)
    ) {
      throw new Error("Invalid runner state");
    }
    const inFlight = state.inFlight ?? {};
    if (typeof inFlight !== "object" || Array.isArray(inFlight)) {
      throw new Error("Invalid runner state");
    }
    return {
      cursor: state.cursor as number,
      pendingByVoter: state.pendingByVoter,
      inFlight,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeState(stateFile: string, state: RunnerState): void {
  const temporary = `${stateFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, stateFile);
}

function redact(value: string): string {
  return value
    .replace(/(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+/g, "[key omitted]")
    .replace(/private_key/gi, "[private key field]");
}

function log(entry: ActionLog): void {
  const safe = { ...entry, time: new Date().toISOString() };
  if (safe.error) {
    safe.error = redact(safe.error);
  }
  process.stdout.write(`${JSON.stringify(safe)}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAtMs = Date.now();
  let state: RunnerState | null = null;
  let lastTickAtMs: number | null = null;
  let lastTickOkAtMs: number | null = null;
  const keeper = loadCredential(config.keeperKeyFile, config.keeperAccountId);
  const voters = config.voters.map((voter) => ({
    voterId: voter.voter_id,
    credential: loadCredential(voter.agent_key_file, voter.voter_id, false),
  }));
  const sharedCredential: KeyFileCredential | undefined = config.runnerAgentKeyFile
    ? loadCredential(config.runnerAgentKeyFile, "runner-agent.testnet", false)
    : undefined;
  const rpc = new NearAgentRpc(
    config.rpcUrl,
    { ...keeper, accountId: config.keeperAccountId },
    voters.map((voter) => voter.credential),
  );
  const fileVoterIds = voters.map((voter) => voter.voterId);
  let discoveredVoterIds: string[] = [];
  let voterSources: VoterSource[] = mergeVoterSources(fileVoterIds, discoveredVoterIds);
  const discovery = config.seatNftId && sharedCredential ? new SeatVoterDiscovery() : undefined;
  let nextDiscoveryAtMs = 0;
  const refreshDiscovery = async (nowMs: number): Promise<void> => {
    if (!discovery || !config.seatNftId || !sharedCredential || nowMs < nextDiscoveryAtMs) {
      return;
    }
    nextDiscoveryAtMs = nowMs + 60_000;
    if (!await discovery.refresh(
      rpc,
      config.seatNftId,
      sharedCredential.publicKey.toString(),
      log,
    )) {
      return;
    }
    const nextDiscoveredVoterIds = discovery.voters;
    const fileVoterSet = new Set(fileVoterIds);
    const nextDiscoveredSet = new Set(nextDiscoveredVoterIds);
    for (const voterId of discoveredVoterIds) {
      if (!fileVoterSet.has(voterId) && !nextDiscoveredSet.has(voterId)) {
        rpc.removeCredential(voterId);
      }
    }
    for (const voterId of nextDiscoveredVoterIds) {
      if (!fileVoterSet.has(voterId)) {
        rpc.addCredential({ ...sharedCredential, accountId: voterId });
      }
    }
    discoveredVoterIds = nextDiscoveredVoterIds;
    voterSources = mergeVoterSources(fileVoterIds, discoveredVoterIds);
  };
  if (config.port !== undefined) {
    healthServer = await startHealthServer(config.port, () => ({
      daoId: config.daoId,
      voters: voterSources.map(({ voterId, source }) => ({
        voter_id: voterId,
        source,
      })),
      agentPublicKey: sharedCredential?.publicKey.toString() ?? null,
      cursor: state?.cursor ?? null,
      startedAtMs,
      nowMs: Date.now(),
      pollMs: config.pollMs,
      lastTickAtMs,
      lastTickOkAtMs,
    }));
  }
  keepaliveTimer = startKeepalive(config.keepaliveUrl, config.keepaliveMs, log);
  state = readState(config.stateFile);
  if (state === null) {
    const currentNextProposalId = config.startProposalId === undefined
      ? await rpc.getLastProposalId(config.daoId)
      : config.startProposalId;
    state = initialRunnerState(
      config.startProposalId,
      currentNextProposalId,
      config.lookbackProposals,
    );
    writeState(config.stateFile, state);
  }

  await refreshDiscovery(Date.now());
  process.stdout.write(`${JSON.stringify({
    action: "runner_started",
    dao_id: config.daoId,
    voters: voterSources.map(({ voterId, source }) => ({
      voter_id: voterId,
      source,
    })),
    agent_public_key: sharedCredential?.publicKey.toString() ?? null,
    poll_ms: config.pollMs,
  })}\n`);
  let proposalPeriodNs: bigint | undefined;
  try {
    proposalPeriodNs = await rpc.getProposalPeriodNs(config.daoId);
    if (isProposalPeriodTooShort(proposalPeriodNs, config.windowSeconds)) {
      log({
        action: "proposal_period",
        status: "warning",
        reason: `DAO proposal period is below ${config.windowSeconds + 300} seconds`,
      });
    }
  } catch (error) {
    log({ action: "get_policy", status: "error", error: String(error) });
  }

  while (true) {
    const started = Date.now();
    lastTickAtMs = started;
    try {
      await refreshDiscovery(started);
      await runTick({
        rpc,
        daoId: config.daoId,
        voters: voterSources.map(({ voterId }) => ({ voterId })),
        state,
        nowNanoseconds: BigInt(started) * 1_000_000n,
        nowMilliseconds: started,
        requestTtlMs: config.requestTtlMs,
        proposalPeriodNs,
        windowSeconds: config.windowSeconds,
        persistState: writeState.bind(null, config.stateFile),
        log,
      });
      lastTickOkAtMs = Date.now();
      writeState(config.stateFile, state);
    } catch (error) {
      log({ action: "poll", status: "error", error: String(error) });
    }
    await new Promise((done) => setTimeout(done, Math.max(0, config.pollMs - (Date.now() - started))));
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === currentFile) {
  void main().catch((error: unknown) => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
    }
    healthServer?.close();
    process.stderr.write(`${redact(String(error))}\n`);
    process.exitCode = 1;
  });
}
