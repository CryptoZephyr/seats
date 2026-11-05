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
}

export interface AgentRunnerRpc {
  getLastProposalId(daoId: string): Promise<number>;
  getProposals(daoId: string, fromIndex: number, limit: number): Promise<Proposal[]>;
  getPending(voterId: string, id: number): Promise<PendingVote | null>;
  getResults(voterId: string): Promise<ResultsView>;
  requestVote(voterId: string, id: number): Promise<string>;
  cast(voterId: string, id: number): Promise<string>;
}

export interface RunnerState {
  cursor: number;
  pendingByVoter: Record<string, number[]>;
}

export function initialRunnerState(
  startProposalId: number | undefined,
  currentNextProposalId: number,
): RunnerState {
  const firstProposalId = startProposalId ?? currentNextProposalId;
  if (!Number.isSafeInteger(firstProposalId) || firstProposalId < 0) {
    throw new Error("Initial proposal ID must be a non-negative integer");
  }
  return { cursor: firstProposalId - 1, pendingByVoter: {} };
}

export interface ActionLog {
  action: string;
  status: "ok" | "skipped" | "error";
  voter_id?: string;
  proposal_id?: number;
  tx_hash?: string;
  reason?: string;
  error?: string;
}

interface TickOptions {
  rpc: AgentRunnerRpc;
  daoId: string;
  voters: Voter[];
  state: RunnerState;
  nowNanoseconds: bigint;
  log: (entry: ActionLog) => void;
}

const PROPOSAL_PAGE_SIZE = 100;

function addPending(state: RunnerState, voterId: string, id: number): void {
  const pending = new Set(state.pendingByVoter[voterId] ?? []);
  pending.add(id);
  state.pendingByVoter[voterId] = [...pending].sort((left, right) => left - right);
}

function removePending(state: RunnerState, voterId: string, id: number): void {
  state.pendingByVoter[voterId] = (state.pendingByVoter[voterId] ?? []).filter(
    (pendingId) => pendingId !== id,
  );
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

  const attempted = new Set<string>();
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
        addPending(state, voter.voterId, id);
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
        removePending(state, voter.voterId, id);
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

      const attemptKey = `${voter.voterId}:${id}`;
      if (attempted.has(attemptKey) || !shouldRequestVote(pending, results, id)) {
        continue;
      }
      attempted.add(attemptKey);
      try {
        const txHash = await rpc.requestVote(voter.voterId, id);
        addPending(state, voter.voterId, id);
        log({
          action: "request_vote",
          status: "ok",
          voter_id: voter.voterId,
          proposal_id: id,
          tx_hash: txHash,
        });
      } catch (error) {
        firstIncompleteId = firstIncompleteId === null ? id : Math.min(firstIncompleteId, id);
        log({
          action: "request_vote",
          status: "error",
          voter_id: voter.voterId,
          proposal_id: id,
          error: String(error),
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
          removePending(state, voter.voterId, id);
        }
        continue;
      }

      const results = resultsByVoter.get(voter.voterId);
      if (results && hasResult(results, id)) {
        removePending(state, voter.voterId, id);
        log({
          action: "cast",
          status: "skipped",
          voter_id: voter.voterId,
          proposal_id: id,
          reason: "result_exists",
        });
        continue;
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
    state.cursor = Math.max(state.cursor, newestId);
  } else {
    state.cursor = Math.max(state.cursor, firstIncompleteId - 1);
  }
  return state;
}
