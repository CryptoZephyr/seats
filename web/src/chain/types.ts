export interface TokenMetadata {
  title: string | null;
  description: string | null;
  media: string | null;
  media_hash: string | null;
  copies: number | null;
  issued_at: string | null;
  expires_at: string | null;
  starts_at: string | null;
  updated_at: string | null;
  extra: string | null;
  reference: string | null;
  reference_hash: string | null;
}

export interface NftToken {
  token_id: string;
  owner_id: string;
  metadata: TokenMetadata | null;
  approved_account_ids: Record<string, number>;
}

export interface NftMetadata {
  spec: string;
  name: string;
  symbol: string;
  icon: string | null;
  base_uri: string | null;
  reference: string | null;
  reference_hash: string | null;
}

export interface SeatView {
  voter_id: string;
  approval: {
    buyer: string;
    price: string;
    expires_at: number;
  } | null;
}

export interface PendingView {
  vote: string;
  reason: string;
  proposal_kind: Record<string, unknown>;
  receipt_hash: string;
  deadline: string;
  controller_at_submit: string;
  casting: boolean;
}

export interface VoteResult {
  proposal_id: number;
  vote: string;
  status: string;
  source: string;
  receipt_hash: string | null;
  error: string | null;
  cast: boolean;
}

export interface ResultsView {
  results: VoteResult[];
  storage_usage_bytes: number;
}

export interface FunctionCallAction {
  method_name: string;
  args: string;
  deposit: string;
  gas: string;
}

export type ProposalKind =
  | { ChangeConfig: { config: Record<string, unknown> } }
  | { ChangePolicy: { policy: unknown } }
  | { AddMemberToRole: { member_id: string; role: string } }
  | { RemoveMemberFromRole: { member_id: string; role: string } }
  | { FunctionCall: { receiver_id: string; actions: FunctionCallAction[] } }
  | { UpgradeSelf: { hash: string } }
  | { UpgradeRemote: { receiver_id: string; method_name: string; hash: string } }
  | { Transfer: { token_id: string; receiver_id: string; amount: string; msg: string | null } }
  | { SetStakingContract: { staking_id: string } }
  | { AddBounty: { bounty: unknown } }
  | { BountyDone: { bounty_id: number; receiver_id: string } }
  | "Vote"
  | { FactoryInfoUpdate: { factory_info: Record<string, unknown> } }
  | { ChangePolicyAddOrUpdateRole: { role: Record<string, unknown> } }
  | { ChangePolicyRemoveRole: { role: string } }
  | { ChangePolicyUpdateDefaultVotePolicy: { vote_policy: Record<string, unknown> } }
  | { ChangePolicyUpdateParameters: { parameters: Record<string, unknown> } };

export type ProposalStatus =
  | "InProgress"
  | "Approved"
  | "Rejected"
  | "Removed"
  | "Expired"
  | "Moved"
  | "Failed";

export interface ProposalView {
  id: number;
  proposer: string;
  description: string;
  kind: ProposalKind;
  status: ProposalStatus;
  vote_counts: Record<string, [number, number, number]>;
  votes: Record<string, "Approve" | "Reject" | "Remove">;
  submission_time: string;
}

export interface PolicyView {
  roles: unknown[];
  default_vote_policy: Record<string, unknown>;
  proposal_bond: string;
  proposal_period: string;
  bounty_bond: string;
  bounty_forgiveness_period: string;
}

export interface ViewArgs {
  nft_tokens: { from_index: string | null; limit: number | null };
  nft_tokens_for_owner: {
    account_id: string;
    from_index: string | null;
    limit: number | null;
  };
  nft_metadata: Record<string, never>;
  get_seat: { token_id: string };
  get_pending: { proposal_id: number };
  get_results: Record<string, never>;
  get_brief_hash: Record<string, never>;
  get_controller: Record<string, never>;
  get_dao: Record<string, never>;
  get_policy: Record<string, never>;
  get_last_proposal_id: Record<string, never>;
  get_proposals: { from_index: number; limit: number };
}

export interface ViewResults {
  nft_tokens: NftToken[];
  nft_tokens_for_owner: NftToken[];
  nft_metadata: NftMetadata;
  get_seat: SeatView | null;
  get_pending: PendingView | null;
  get_results: ResultsView;
  get_brief_hash: string;
  get_controller: string;
  get_dao: string;
  get_policy: PolicyView;
  get_last_proposal_id: number;
  get_proposals: ProposalView[];
}
