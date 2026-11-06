import { chainConfig } from "./config";
import { callView } from "./rpc";
import type {
  NftMetadata,
  NftToken,
  PendingView,
  ProposalView,
  ResultsView,
  SeatView,
} from "./types";

export interface SeatSnapshot {
  token: NftToken;
  record: SeatView;
  controller: string;
  dao: string;
  briefHash: string;
  results: ResultsView;
  pending: Record<number, PendingView | null>;
}

export interface ClubSnapshot {
  metadata: NftMetadata;
  tokens: NftToken[];
  seats: SeatSnapshot[];
  proposals: ProposalView[];
  config: {
    name: string;
    purpose: string;
    metadata: string;
  };
  proposalPeriodNs: string;
}

async function allTokens(): Promise<NftToken[]> {
  const tokens: NftToken[] = [];
  let fromIndex = 0;

  while (true) {
    const page = await callView(chainConfig.seatNftAccountId, "nft_tokens", {
      from_index: String(fromIndex),
      limit: 100,
    });
    tokens.push(...page);
    if (page.length < 100) return tokens;
    fromIndex += page.length;
  }
}

async function readSeat(
  token: NftToken,
  proposals: ProposalView[],
): Promise<SeatSnapshot> {
  const record = await callView(chainConfig.seatNftAccountId, "get_seat", {
    token_id: token.token_id,
  });
  if (!record) {
    throw new Error(`Seat ${token.token_id} has no voter record.`);
  }

  const [controller, dao, briefHash, results] = await Promise.all([
    callView(record.voter_id, "get_controller", {}),
    callView(record.voter_id, "get_dao", {}),
    callView(record.voter_id, "get_brief_hash", {}),
    callView(record.voter_id, "get_results", {}),
  ]);
  if (dao !== chainConfig.daoAccountId) {
    throw new Error(`Seat ${token.token_id} points to an unexpected DAO.`);
  }

  const pendingEntries = await Promise.all(
    proposals
      .filter((proposal) => proposal.status === "InProgress")
      .map(async (proposal) => [
        proposal.id,
        await callView(record.voter_id, "get_pending", { proposal_id: proposal.id }),
      ] as const),
  );

  return {
    token,
    record,
    controller,
    dao,
    briefHash,
    results,
    pending: Object.fromEntries(pendingEntries),
  };
}

export async function loadClubSnapshot(): Promise<ClubSnapshot> {
  const [metadata, tokens, config, policy, lastProposalId] = await Promise.all([
    callView(chainConfig.seatNftAccountId, "nft_metadata", {}),
    allTokens(),
    callView(chainConfig.daoAccountId, "get_config", {}),
    callView(chainConfig.daoAccountId, "get_policy", {}),
    callView(chainConfig.daoAccountId, "get_last_proposal_id", {}),
  ]);
  const proposals =
    lastProposalId === 0
      ? []
      : await callView(chainConfig.daoAccountId, "get_proposals", {
          from_index: 0,
          limit: lastProposalId,
        });
  const seats = await Promise.all(tokens.map((token) => readSeat(token, proposals)));

  return {
    metadata,
    tokens,
    config,
    seats,
    proposals,
    proposalPeriodNs: policy.proposal_period,
  };
}
