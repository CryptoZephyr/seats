import type { ProposalView } from "./chain/types";

export function isProposalVotingClosed(
  proposal: Pick<ProposalView, "status" | "submission_time">,
  proposalPeriodNs: string,
  nowNs: bigint,
): boolean {
  return (
    proposal.status === "InProgress" &&
    nowNs > BigInt(proposal.submission_time) + BigInt(proposalPeriodNs)
  );
}

export function newestFirst<T extends Pick<ProposalView, "id" | "submission_time">>(
  proposals: T[],
): T[] {
  return [...proposals].sort((a, b) => {
    const aTime = BigInt(a.submission_time);
    const bTime = BigInt(b.submission_time);
    if (aTime === bTime) return b.id - a.id;
    return aTime > bTime ? -1 : 1;
  });
}
