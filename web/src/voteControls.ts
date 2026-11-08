export interface VoteControlState {
  kind: string;
  sublabel?: string;
}

export function canChangePendingVote(
  voteState: VoteControlState | undefined,
  seatController: string,
  accountId: string | null,
): boolean {
  return voteState?.kind === "pending" &&
    voteState.sublabel === undefined &&
    seatController === accountId;
}
