import {
  deadlineHasPassed,
  hasResult,
  inProgressProposals,
  proposalId,
  proposalsAfterCursor,
  shouldRequestVote,
  type PendingVote,
  type Proposal,
  type ResultsView,
} from "./logic.js";

export interface Voter {
  voterId: string;
  source?: "file" | "discovered";
}

export interface AgentRunnerRpc {
  getLastProposalId(daoId: string): Promise<number>;
  getProposalPeriodNs(daoId: string): Promise<bigint>;
  getProposals(daoId: string, fromIndex: number, limit: number): Promise<Proposal[]>;
  getAccountInfo(voterId: string): Promise<{
    amount: string | bigint;
    storageUsage: string | number | bigint;
  }>;
  getPending(voterId: string, id: number): Promise<PendingVote | null>;
  getResults(voterId: string): Promise<ResultsView>;
  requestVote(voterId: string, id: number): Promise<string>;
  cast(voterId: string, id: number): Promise<string>;
}

export interface LowBalanceVoter {
  available_yocto: string;
  required_yocto: string;
}

export interface RunnerState {
  cursor: number;
  pendingByVoter: Record<string, number[]>;
  inFlight: Record<string, Record<string, number>>;
  requestBackoffByVoter?: Record<string, number>;
  lowBalanceVoters?: Record<string, LowBalanceVoter>;
}

export function initialRunnerState(
  startProposalId: number | undefined,
  currentNextProposalId: number,
  lookbackProposals = 0,
): RunnerState {
  if (!Number.isSafeInteger(currentNextProposalId) || currentNextProposalId < 0) {
    throw new Error("Current next proposal ID must be a non-negative integer");
  }
  if (!Number.isSafeInteger(lookbackProposals) || lookbackProposals < 0) {
    throw new Error("Proposal lookback must be a non-negative integer");
  }
  const firstProposalId = startProposalId
    ?? Math.max(0, currentNextProposalId - lookbackProposals);
  if (!Number.isSafeInteger(firstProposalId) || firstProposalId < 0) {
    throw new Error("Initial proposal ID must be a non-negative integer");
  }
  return { cursor: firstProposalId - 1, pendingByVoter: {}, inFlight: {} };
}

export function rewindCursorForNewDiscoveredVoters(
  state: RunnerState,
  newlyDiscoveredVoterIds: string[],
  newestKnownId: number,
  lookbackProposals: number,
): boolean {
  if (newlyDiscoveredVoterIds.length === 0) return false;
  if (!Number.isSafeInteger(newestKnownId) || newestKnownId < -1) {
    throw new Error("Newest proposal ID must be an integer greater than or equal to -1");
  }
  if (!Number.isSafeInteger(lookbackProposals) || lookbackProposals < 0) {
    throw new Error("Proposal lookback must be a non-negative integer");
  }
  const lookback = lookbackProposals === 0 ? 20 : lookbackProposals;
  const rewindFloor = Math.max(-1, newestKnownId - lookback - 1);
  const nextCursor = Math.min(state.cursor, rewindFloor);
  if (nextCursor === state.cursor) return false;
  state.cursor = nextCursor;
  return true;
}

export interface ActionLog {
  action: string;
  status: "ok" | "skipped" | "error" | "warning";
  voter_id?: string;
  proposal_id?: number;
  tx_hash?: string;
  reason?: string;
  error?: string;
  available_yocto?: string;
  required_yocto?: string;
}

interface TickOptions {
  rpc: AgentRunnerRpc;
  daoId: string;
  voters: Voter[];
  state: RunnerState;
  nowNanoseconds: bigint;
  nowMilliseconds: number;
  requestTtlMs: number;
  voterMinAvailableYocto?: bigint;
  proposalPeriodNs?: bigint;
  windowSeconds?: number;
  persistState: (state: RunnerState) => void;
  log: (entry: ActionLog) => void;
}

const PROPOSAL_PAGE_SIZE = 100;
const PROPOSAL_PERIOD_MARGIN_SECONDS = 300;
const REQUEST_BACKOFF_MS = 60 * 60 * 1000;
const VOTER_MIN_AVAILABLE_YOCTO = 4_350_000_000_000_000_000_000_000n;
const STORAGE_COST_PER_BYTE_YOCTO = 10_000_000_000_000_000_000n;

export function isProposalPeriodTooShort(proposalPeriodNs: bigint, windowSeconds: number): boolean {
  return proposalPeriodNs < BigInt(windowSeconds + PROPOSAL_PERIOD_MARGIN_SECONDS) * 1_000_000_000n;
}

function addPending(state: RunnerState, voterId: string, id: number): boolean {
  const pending = new Set(state.pendingByVoter[voterId] ?? []);
  const previousSize = pending.size;
  pending.add(id);
  state.pendingByVoter[voterId] = [...pending].sort((left, right) => left - right);
  return pending.size !== previousSize;
}

function removePending(state: RunnerState, voterId: string, id: number): boolean {
  const previous = state.pendingByVoter[voterId] ?? [];
  state.pendingByVoter[voterId] = (state.pendingByVoter[voterId] ?? []).filter(
    (pendingId) => pendingId !== id,
  );
  return state.pendingByVoter[voterId].length !== previous.length;
}

function getInFlight(state: RunnerState, voterId: string, id: number): number | undefined {
  return state.inFlight[voterId]?.[String(id)];
}

function setInFlight(state: RunnerState, voterId: string, id: number, requestedAtMs: number): void {
  state.inFlight[voterId] ??= {};
  state.inFlight[voterId][String(id)] = requestedAtMs;
}

function clearInFlight(state: RunnerState, voterId: string, id: number): boolean {
  const requests = state.inFlight[voterId];
  if (!requests || !Object.prototype.hasOwnProperty.call(requests, String(id))) {
    return false;
  }
  delete requests[String(id)];
  if (Object.keys(requests).length === 0) {
    delete state.inFlight[voterId];
  }
  return true;
}

function setRequestBackoff(state: RunnerState, voterId: string, untilMs: number): void {
  state.requestBackoffByVoter ??= {};
  state.requestBackoffByVoter[voterId] = untilMs;
}

function clearRequestBackoff(state: RunnerState, voterId: string): boolean {
  if (!state.requestBackoffByVoter || !Object.hasOwn(state.requestBackoffByVoter, voterId)) {
    return false;
  }
  delete state.requestBackoffByVoter[voterId];
  if (Object.keys(state.requestBackoffByVoter).length === 0) {
    delete state.requestBackoffByVoter;
  }
  return true;
}

function clearLowBalanceVoter(state: RunnerState, voterId: string): boolean {
  if (!state.lowBalanceVoters || !Object.hasOwn(state.lowBalanceVoters, voterId)) {
    return false;
  }
  delete state.lowBalanceVoters[voterId];
  if (Object.keys(state.lowBalanceVoters).length === 0) {
    delete state.lowBalanceVoters;
  }
  return true;
}

function setLowBalanceVoter(
  state: RunnerState,
  voterId: string,
  availableYocto: bigint,
  requiredYocto: bigint,
): void {
  state.lowBalanceVoters ??= {};
  state.lowBalanceVoters[voterId] = {
    available_yocto: availableYocto.toString(),
    required_yocto: requiredYocto.toString(),
  };
}

function availableVoterBalance(account: {
  amount: string | bigint;
  storageUsage: string | number | bigint;
}): bigint {
  return BigInt(account.amount)
    - BigInt(account.storageUsage) * STORAGE_COST_PER_BYTE_YOCTO;
}

function hasPending(state: RunnerState, voterId: string, id: number): boolean {
  return (state.pendingByVoter[voterId] ?? []).includes(id);
}

function isDefiniteRequestPanic(error: unknown): boolean {
  const message = String(error);
  return [
    "ERR_BRIEF_NOT_SET",
    "ERR_AGENT_WASM_NOT_PINNED",
    "ERR_ONLY_SELF",
  ].some((code) => message.includes(code));
}

function requestSkipReason(
  proposal: Proposal,
  voterId: string,
  options: Pick<TickOptions, "proposalPeriodNs" | "windowSeconds" | "nowNanoseconds">,
): "already_voted" | "too_late" | undefined {
  if (proposal.votes && Object.prototype.hasOwnProperty.call(proposal.votes, voterId)) {
    return "already_voted";
  }
  if (
    options.proposalPeriodNs === undefined
    || options.windowSeconds === undefined
    || proposal.submission_time === undefined
  ) {
    return undefined;
  }
  try {
    const deadline = BigInt(proposal.submission_time) + options.proposalPeriodNs;
    const requiredWindow = BigInt(options.windowSeconds + 60) * 1_000_000_000n;
    return deadline < options.nowNanoseconds + requiredWindow ? "too_late" : undefined;
  } catch {
    return undefined;
  }
}

async function readNewProposals(
  rpc: AgentRunnerRpc,
  daoId: string,
  cursor: number,
  newestId: number,
): Promise<Proposal[]> {
  const proposals: Proposal[] = [];
  let fromIndex = Math.max(0, cursor + 1);
  while (fromIndex <= newestId) {
    const page = await rpc.getProposals(
      daoId,
      fromIndex,
      Math.min(PROPOSAL_PAGE_SIZE, newestId - fromIndex + 1),
    );
    proposals.push(...page);
    if (page.length < PROPOSAL_PAGE_SIZE) {
      break;
    }
    fromIndex += page.length;
  }
  return proposalsAfterCursor(proposals, cursor, newestId);
}

export async function runTick(options: TickOptions): Promise<RunnerState> {
  const { rpc, daoId, voters, state, nowNanoseconds, log } = options;
  let nextProposalId: number;
  try {
    nextProposalId = await rpc.getLastProposalId(daoId);
  } catch (error) {
    log({ action: "get_last_proposal_id", status: "error", error: String(error) });
    return state;
  }

  const newestId = nextProposalId - 1;
  let proposals: Proposal[];
  try {
    proposals = await readNewProposals(rpc, daoId, state.cursor, newestId);
  } catch (error) {
    log({ action: "get_proposals", status: "error", error: String(error) });
    return state;
  }
  const seenNewestId = Math.max(
    state.cursor,
    ...proposals.map((proposal) => proposalId(proposal.id)),
  );

  const resultsByVoter = new Map<string, ResultsView>();
  const unavailableVoters = new Set<string>();
  for (const voter of voters) {
    try {
      resultsByVoter.set(voter.voterId, await rpc.getResults(voter.voterId));
    } catch (error) {
      unavailableVoters.add(voter.voterId);
      log({
        action: "get_results",
        status: "error",
        voter_id: voter.voterId,
        error: String(error),
      });
    }
  }

  let firstIncompleteId: number | null = null;
  const inProgressIds = new Set(
    inProgressProposals(proposals).map((proposal) => proposalId(proposal.id)),
  );
  for (const proposal of proposals) {
    const id = proposalId(proposal.id);
    for (const voter of voters) {
      if (unavailableVoters.has(voter.voterId)) {
        firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
        continue;
      }

      const results = resultsByVoter.get(voter.voterId);
      if (!results) {
        firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
        continue;
      }

      let pending: PendingVote | null;
      try {
        pending = await rpc.getPending(voter.voterId, id);
      } catch (error) {
        firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
        log({
          action: "get_pending",
          status: "error",
          voter_id: voter.voterId,
          proposal_id: id,
          error: String(error),
        });
        continue;
      }

      if (pending) {
        const changed = addPending(state, voter.voterId, id);
        const cleared = clearInFlight(state, voter.voterId, id);
        if (changed || cleared) {
          options.persistState(state);
        }
        log({
          action: "request_vote",
          status: "skipped",
          voter_id: voter.voterId,
          proposal_id: id,
          reason: "pending_exists",
        });
        continue;
      }

      if (hasResult(results, id)) {
        const changed = removePending(state, voter.voterId, id);
        const cleared = clearInFlight(state, voter.voterId, id);
        if (changed || cleared) {
          options.persistState(state);
        }
        log({
          action: "request_vote",
          status: "skipped",
          voter_id: voter.voterId,
          proposal_id: id,
          reason: "result_exists",
        });
        continue;
      }

      if (!inProgressIds.has(id)) {
        continue;
      }

      const skipReason = requestSkipReason(proposal, voter.voterId, options);
      if (skipReason) {
        log({
          action: "request_vote",
          status: "skipped",
          voter_id: voter.voterId,
          proposal_id: id,
          reason: skipReason,
        });
        continue;
      }

      const hasLowBalanceState = state.lowBalanceVoters?.[voter.voterId] !== undefined;
      const requestBackoffUntil = state.requestBackoffByVoter?.[voter.voterId];
      if (requestBackoffUntil !== undefined) {
        if (requestBackoffUntil > options.nowMilliseconds && !hasLowBalanceState) {
          firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
          continue;
        }
        if (requestBackoffUntil <= options.nowMilliseconds
          && clearRequestBackoff(state, voter.voterId)) {
          options.persistState(state);
        }
      }

      const requestedAtMs = getInFlight(state, voter.voterId, id);
      if (requestedAtMs !== undefined && options.nowMilliseconds - requestedAtMs < options.requestTtlMs) {
        firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
        log({
          action: "request_vote",
          status: "skipped",
          voter_id: voter.voterId,
          proposal_id: id,
          reason: "request_in_flight",
        });
        continue;
      }
      if (requestedAtMs === undefined && hasPending(state, voter.voterId, id)) {
        log({
          action: "request_vote",
          status: "skipped",
          voter_id: voter.voterId,
          proposal_id: id,
          reason: "pending_exists",
        });
        continue;
      }
      if (!shouldRequestVote(pending, results, id)) {
        continue;
      }

      const requiredYocto = options.voterMinAvailableYocto ?? VOTER_MIN_AVAILABLE_YOCTO;
      try {
        const account = await rpc.getAccountInfo(voter.voterId);
        const availableYocto = availableVoterBalance(account);
        if (availableYocto < requiredYocto) {
          setLowBalanceVoter(state, voter.voterId, availableYocto, requiredYocto);
          setRequestBackoff(
            state,
            voter.voterId,
            options.nowMilliseconds + REQUEST_BACKOFF_MS,
          );
          firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
          options.persistState(state);
          log({
            action: "request_vote",
            status: "skipped",
            voter_id: voter.voterId,
            proposal_id: id,
            reason: "insufficient_voter_balance",
            available_yocto: availableYocto.toString(),
            required_yocto: requiredYocto.toString(),
          });
          continue;
        }
        if (clearLowBalanceVoter(state, voter.voterId)) {
          clearRequestBackoff(state, voter.voterId);
          options.persistState(state);
        }
      } catch (error) {
        log({
          action: "view_account",
          status: "error",
          voter_id: voter.voterId,
          error: String(error),
        });
        if (hasLowBalanceState) {
          firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
          continue;
        }
      }

      const retryAfterTtl = requestedAtMs !== undefined;
      setInFlight(state, voter.voterId, id, options.nowMilliseconds);
      options.persistState(state);
      try {
        const txHash = await rpc.requestVote(voter.voterId, id);
        addPending(state, voter.voterId, id);
        options.persistState(state);
        log({
          action: "request_vote",
          status: "ok",
          voter_id: voter.voterId,
          proposal_id: id,
          tx_hash: txHash,
          ...(retryAfterTtl ? { reason: "request_retry_after_ttl" } : {}),
        });
      } catch (error) {
        const message = String(error);
        if (message.includes("ERR_PENDING_EXISTS")) {
          addPending(state, voter.voterId, id);
          clearInFlight(state, voter.voterId, id);
          options.persistState(state);
          log({
            action: "request_vote",
            status: "skipped",
            voter_id: voter.voterId,
            proposal_id: id,
            reason: "pending_exists",
          });
          continue;
        }
        firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
        const needsConfigurationBackoff = voter.source === "discovered"
          && (message.includes("ERR_AGENT_WASM_NOT_PINNED") || message.includes("ERR_BRIEF_NOT_SET"));
        if (needsConfigurationBackoff) {
          setRequestBackoff(
            state,
            voter.voterId,
            options.nowMilliseconds + REQUEST_BACKOFF_MS,
          );
        }
        if (isDefiniteRequestPanic(error)) {
          clearInFlight(state, voter.voterId, id);
          removePending(state, voter.voterId, id);
          options.persistState(state);
        }
        if (needsConfigurationBackoff) {
          log({
            action: "request_vote",
            status: "skipped",
            voter_id: voter.voterId,
            proposal_id: id,
            reason: "discovered_voter_backoff_1h",
            error: message,
          });
          continue;
        }
        log({
          action: "request_vote",
          status: "error",
          voter_id: voter.voterId,
          proposal_id: id,
          ...(retryAfterTtl ? { reason: "request_retry_after_ttl" } : {}),
          error: message,
        });
      }
    }
  }

  for (const voter of voters) {
    const pendingIds = [...(state.pendingByVoter[voter.voterId] ?? [])];
    for (const id of pendingIds) {
      let pending: PendingVote | null;
      try {
        pending = await rpc.getPending(voter.voterId, id);
      } catch (error) {
        log({
          action: "get_pending",
          status: "error",
          voter_id: voter.voterId,
          proposal_id: id,
          error: String(error),
        });
        continue;
      }

      if (!pending) {
        const results = resultsByVoter.get(voter.voterId);
        if (results && hasResult(results, id)) {
          const removed = removePending(state, voter.voterId, id);
          const cleared = clearInFlight(state, voter.voterId, id);
          if (removed || cleared) {
            options.persistState(state);
          }
        }
        continue;
      }

      const results = resultsByVoter.get(voter.voterId);
      if (results && hasResult(results, id)) {
        removePending(state, voter.voterId, id);
        clearInFlight(state, voter.voterId, id);
        options.persistState(state);
        log({
          action: "cast",
          status: "skipped",
          voter_id: voter.voterId,
          proposal_id: id,
          reason: "result_exists",
        });
        continue;
      }

      if (clearInFlight(state, voter.voterId, id)) {
        options.persistState(state);
      }

      if (pending.casting) {
        log({
          action: "cast",
          status: "skipped",
          voter_id: voter.voterId,
          proposal_id: id,
          reason: "already_casting",
        });
        continue;
      }

      if (!deadlineHasPassed(pending, nowNanoseconds)) {
        continue;
      }

      try {
        const txHash = await rpc.cast(voter.voterId, id);
        log({
          action: "cast",
          status: "ok",
          voter_id: voter.voterId,
          proposal_id: id,
          tx_hash: txHash,
        });
      } catch (error) {
        log({
          action: "cast",
          status: "error",
          voter_id: voter.voterId,
          proposal_id: id,
          error: String(error),
        });
      }
    }
  }

  if (firstIncompleteId === null) {
    state.cursor = Math.max(state.cursor, Math.min(newestId, seenNewestId));
  } else {
    state.cursor = Math.max(state.cursor, firstIncompleteId - 1);
  }
  return state;
}
