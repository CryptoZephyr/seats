import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredential, NearAgentRpc } from "./rpc.js";
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
  keeperAccountId: string;
  keeperKeyFile: string;
  pollMs: number;
  windowSeconds: number;
  requestTtlMs: number;
  startProposalId?: number;
  votersFile: string;
  stateFile: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function loadConfig(): Config {
  const votersFile = resolve(required("VOTERS"));
  const voters = JSON.parse(readFileSync(votersFile, "utf8")) as VoterConfig[];
  if (!Array.isArray(voters) || voters.length === 0) {
    throw new Error("VOTERS must contain a non-empty JSON array");
  }
  for (const voter of voters) {
    if (!voter || typeof voter.voter_id !== "string" || typeof voter.agent_key_file !== "string") {
      throw new Error("Each VOTERS entry needs voter_id and agent_key_file strings");
    }
  }
  const pollMs = Number(process.env.POLL_MS ?? "15000");
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new Error("POLL_MS must be a positive integer");
  }
  const windowSeconds = Number(process.env.WINDOW_SECONDS ?? "120");
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("WINDOW_SECONDS must be a positive integer");
  }
  const requestTtlMs = Number(process.env.REQUEST_TTL_MS ?? "180000");
  if (!Number.isSafeInteger(requestTtlMs) || requestTtlMs < 1) {
    throw new Error("REQUEST_TTL_MS must be a positive integer");
  }
  const startProposalIdValue = process.env.START_PROPOSAL_ID?.trim();
  const startProposalId = startProposalIdValue ? Number(startProposalIdValue) : undefined;
  if (startProposalId !== undefined && (!Number.isSafeInteger(startProposalId) || startProposalId < 0)) {
    throw new Error("START_PROPOSAL_ID must be a non-negative integer");
  }
  return {
    rpcUrl: required("NEAR_RPC_URL"),
    daoId: required("DAO_ID"),
    voters,
    keeperAccountId: required("KEEPER_ACCOUNT_ID"),
    keeperKeyFile: required("KEEPER_KEY_FILE"),
    pollMs,
    windowSeconds,
    requestTtlMs,
    startProposalId,
    votersFile,
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
  const keeper = loadCredential(config.keeperKeyFile, config.keeperAccountId);
  const voters = config.voters.map((voter) => ({
    voterId: voter.voter_id,
    credential: loadCredential(voter.agent_key_file, voter.voter_id, false),
  }));
  const rpc = new NearAgentRpc(
    config.rpcUrl,
    { ...keeper, accountId: config.keeperAccountId },
    voters.map((voter) => voter.credential),
  );
  let state = readState(config.stateFile);
  if (state === null) {
    const currentNextProposalId = config.startProposalId ?? await rpc.getLastProposalId(config.daoId);
    state = initialRunnerState(config.startProposalId, currentNextProposalId);
    writeState(config.stateFile, state);
  }

  process.stdout.write(`${JSON.stringify({
    action: "runner_started",
    dao_id: config.daoId,
    voters: voters.map((voter) => voter.voterId),
    poll_ms: config.pollMs,
  })}\n`);
  try {
    const proposalPeriodNs = await rpc.getProposalPeriodNs(config.daoId);
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
    try {
      await runTick({
        rpc,
        daoId: config.daoId,
        voters: voters.map(({ voterId }) => ({ voterId })),
        state,
        nowNanoseconds: BigInt(started) * 1_000_000n,
        nowMilliseconds: started,
        requestTtlMs: config.requestTtlMs,
        persistState: writeState.bind(null, config.stateFile),
        log,
      });
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
    process.stderr.write(`${redact(String(error))}\n`);
    process.exitCode = 1;
  });
}
