import type { ActionLog } from "./runner.js";

export interface SeatToken {
  token_id: string;
}

export interface VoterDiscoveryRpc {
  getSeatTokenPage(seatNftId: string, fromIndex: number, limit: number): Promise<SeatToken[]>;
  getSeatVoterId(seatNftId: string, tokenId: string): Promise<string | null>;
  hasRequestVoteAccessKey(voterId: string, publicKey: string): Promise<boolean>;
  getBriefHash(voterId: string): Promise<string>;
}

export interface VoterSource {
  voterId: string;
  source: "file" | "discovered";
}

const TOKEN_PAGE_SIZE = 100;

export class SeatVoterDiscovery {
  private currentVoters: string[] = [];
  private currentVoterIdsByToken = new Map<string, string>();
  private readonly loggedSkippedVoters = new Set<string>();

  get voters(): string[] {
    return [...this.currentVoters];
  }

  async refresh(
    rpc: VoterDiscoveryRpc,
    seatNftId: string,
    publicKey: string,
    previousVoterIds: ReadonlySet<string>,
    log: (entry: ActionLog) => void,
  ): Promise<boolean> {
    try {
      const scan = await scanSeatVoters(
        rpc,
        seatNftId,
        publicKey,
        previousVoterIds,
        this.currentVoterIdsByToken,
        this.loggedSkippedVoters,
        log,
      );
      this.currentVoters = scan.voters;
      this.currentVoterIdsByToken = scan.voterIdsByToken;
      return true;
    } catch (error) {
      log({ action: "discover_voters", status: "error", error: String(error) });
      return false;
    }
  }
}

export function mergeVoterSources(
  fileVoterIds: string[],
  discoveredVoterIds: string[],
): VoterSource[] {
  const voters = new Map<string, VoterSource>();
  for (const voterId of fileVoterIds) {
    voters.set(voterId, { voterId, source: "file" });
  }
  for (const voterId of discoveredVoterIds) {
    if (!voters.has(voterId)) {
      voters.set(voterId, { voterId, source: "discovered" });
    }
  }
  return [...voters.values()];
}

async function scanSeatVoters(
  rpc: VoterDiscoveryRpc,
  seatNftId: string,
  publicKey: string,
  previousVoterIds: ReadonlySet<string>,
  previousVoterIdsByToken: ReadonlyMap<string, string>,
  loggedSkippedVoters: Set<string>,
  log: (entry: ActionLog) => void,
): Promise<{ voters: string[]; voterIdsByToken: Map<string, string> }> {
  const voters: string[] = [];
  const voterIdsByToken = new Map<string, string>();
  const seenVoters = new Set<string>();
  let fromIndex = 0;

  while (true) {
    const tokens = await rpc.getSeatTokenPage(seatNftId, fromIndex, TOKEN_PAGE_SIZE);
    for (const token of tokens) {
      let voterId: string | null;
      try {
        voterId = await rpc.getSeatVoterId(seatNftId, token.token_id);
      } catch (error) {
        const previousVoterId = previousVoterIdsByToken.get(token.token_id);
        if (previousVoterId && previousVoterIds.has(previousVoterId)) {
          seenVoters.add(previousVoterId);
          voters.push(previousVoterId);
          voterIdsByToken.set(token.token_id, previousVoterId);
          logDiscoveryOnce(
            loggedSkippedVoters,
            `voter:${previousVoterId}`,
            log,
            {
              voter_id: previousVoterId,
              reason: "kept_after_view_failure",
              error: String(error),
            },
            "warning",
          );
        } else {
          logDiscoveryOnce(
            loggedSkippedVoters,
            `token:${token.token_id}`,
            log,
            { reason: "get_seat_failed", error: String(error) },
          );
        }
        continue;
      }
      if (!voterId || seenVoters.has(voterId)) continue;
      seenVoters.add(voterId);
      let hasAccessKey: boolean;
      try {
        hasAccessKey = await rpc.hasRequestVoteAccessKey(voterId, publicKey);
      } catch (error) {
        if (previousVoterIds.has(voterId)) {
          voters.push(voterId);
          voterIdsByToken.set(token.token_id, voterId);
          logDiscoveryOnce(
            loggedSkippedVoters,
            `voter:${voterId}`,
            log,
            { voter_id: voterId, reason: "kept_after_view_failure", error: String(error) },
            "warning",
          );
        } else {
          logDiscoveryOnce(
            loggedSkippedVoters,
            `voter:${voterId}`,
            log,
            { voter_id: voterId, reason: "access_key_view_failed", error: String(error) },
          );
        }
        continue;
      }
      if (!hasAccessKey) continue;

      let briefHash: string;
      try {
        briefHash = await rpc.getBriefHash(voterId);
        if (typeof briefHash !== "string") {
          throw new Error("Invalid get_brief_hash result");
        }
      } catch (error) {
        if (previousVoterIds.has(voterId)) {
          voters.push(voterId);
          voterIdsByToken.set(token.token_id, voterId);
          logDiscoveryOnce(
            loggedSkippedVoters,
            `voter:${voterId}`,
            log,
            { voter_id: voterId, reason: "kept_after_view_failure", error: String(error) },
            "warning",
          );
        } else {
          logDiscoveryOnce(
            loggedSkippedVoters,
            `voter:${voterId}`,
            log,
            { voter_id: voterId, reason: "brief_view_failed", error: String(error) },
          );
        }
        continue;
      }
      if (!briefHash.trim()) {
        logDiscoveryOnce(
          loggedSkippedVoters,
          `voter:${voterId}`,
          log,
          { voter_id: voterId, reason: "brief_not_set" },
        );
        continue;
      }
      voters.push(voterId);
      voterIdsByToken.set(token.token_id, voterId);
    }

    if (tokens.length < TOKEN_PAGE_SIZE) break;
    fromIndex += tokens.length;
  }

  return { voters, voterIdsByToken };
}

function logDiscoveryOnce(
  loggedSkippedVoters: Set<string>,
  key: string,
  log: (entry: ActionLog) => void,
  details: Pick<ActionLog, "voter_id" | "reason" | "error">,
  status: ActionLog["status"] = "skipped",
): void {
  const logKey = `${key}:${details.reason}`;
  if (loggedSkippedVoters.has(logKey)) return;
  loggedSkippedVoters.add(logKey);
  log({ action: "discover_voters", status, ...details });
}
