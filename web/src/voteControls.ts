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

export function changeAttribution(
  signerId: string,
  controller: string,
  viewerId: string | null,
): "you" | "member" | "previous" {
  if (signerId === viewerId) return "you";
  if (signerId === controller) return "member";
  return "previous";
}
