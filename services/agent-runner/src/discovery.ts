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
  private readonly loggedSkippedVoters = new Set<string>();

  get voters(): string[] {
    return [...this.currentVoters];
  }

  async refresh(
    rpc: VoterDiscoveryRpc,
    seatNftId: string,
    publicKey: string,
    log: (entry: ActionLog) => void,
  ): Promise<boolean> {
    try {
      this.currentVoters = await scanSeatVoters(
        rpc,
        seatNftId,
        publicKey,
        this.loggedSkippedVoters,
        log,
      );
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
  loggedSkippedVoters: Set<string>,
  log: (entry: ActionLog) => void,
): Promise<string[]> {
  const voters: string[] = [];
  const seenVoters = new Set<string>();
  let fromIndex = 0;

  while (true) {
    const tokens = await rpc.getSeatTokenPage(seatNftId, fromIndex, TOKEN_PAGE_SIZE);
    for (const token of tokens) {
      let voterId: string | null;
      try {
        voterId = await rpc.getSeatVoterId(seatNftId, token.token_id);
      } catch (error) {
        logSkippedVoter(
          loggedSkippedVoters,
          `token:${token.token_id}`,
          log,
          { reason: "get_seat_failed", error: String(error) },
        );
        continue;
      }
      if (!voterId || seenVoters.has(voterId)) continue;
      seenVoters.add(voterId);
      let hasAccessKey: boolean;
      try {
        hasAccessKey = await rpc.hasRequestVoteAccessKey(voterId, publicKey);
      } catch (error) {
        logSkippedVoter(
          loggedSkippedVoters,
          `voter:${voterId}`,
          log,
          { voter_id: voterId, reason: "access_key_view_failed", error: String(error) },
        );
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
        logSkippedVoter(
          loggedSkippedVoters,
          `voter:${voterId}`,
          log,
          { voter_id: voterId, reason: "brief_view_failed", error: String(error) },
        );
        continue;
      }
      if (!briefHash.trim()) {
        logSkippedVoter(
          loggedSkippedVoters,
          `voter:${voterId}`,
          log,
          { voter_id: voterId, reason: "brief_not_set" },
        );
        continue;
      }
      voters.push(voterId);
    }

    if (tokens.length < TOKEN_PAGE_SIZE) break;
    fromIndex += tokens.length;
  }

  return voters;
}

function logSkippedVoter(
  loggedSkippedVoters: Set<string>,
  key: string,
  log: (entry: ActionLog) => void,
  details: Pick<ActionLog, "voter_id" | "reason" | "error">,
): void {
  if (loggedSkippedVoters.has(key)) return;
  loggedSkippedVoters.add(key);
  log({ action: "discover_voters", status: "skipped", ...details });
}
