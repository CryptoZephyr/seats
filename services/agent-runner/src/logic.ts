export interface Proposal {
  id: number | string;
  status: string;
}

export interface PendingVote {
  deadline: number | string | bigint;
  casting: boolean;
}

export interface VoteResult {
  proposal_id: number | string;
}

export interface ResultsView {
  results: VoteResult[];
}

export function proposalId(value: number | string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error(`Invalid proposal id: ${String(value)}`);
  }
  return id;
}

export function proposalsAfterCursor(
  proposals: Proposal[],
  cursor: number,
  newestId: number,
): Proposal[] {
  return proposals
    .filter((proposal) => {
      const id = proposalId(proposal.id);
      return id > cursor && id <= newestId;
    })
    .sort((left, right) => proposalId(left.id) - proposalId(right.id));
}

export function inProgressProposals(proposals: Proposal[]): Proposal[] {
  return proposals.filter((proposal) => proposal.status === "InProgress");
}

export function hasResult(results: ResultsView, id: number): boolean {
  return results.results.some((result) => proposalId(result.proposal_id) === id);
}

export function shouldRequestVote(
  pending: PendingVote | null,
  results: ResultsView,
  id: number,
): boolean {
  return pending === null && !hasResult(results, id);
}

export function deadlineHasPassed(pending: PendingVote, nowNanoseconds: bigint): boolean {
  return !pending.casting && BigInt(pending.deadline) <= nowNanoseconds;
}
