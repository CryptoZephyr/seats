import type { ActionLog } from "./runner.js";

export interface SeatToken {
  token_id: string;
}

export interface VoterConfiguration {
  model_signer_hex: string;
  model: string;
  agent_wasm_url: string;
  agent_wasm_sha256: string;
}

export interface VoterDiscoveryRpc {
  getSeatTokenPage(seatNftId: string, fromIndex: number, limit: number): Promise<SeatToken[]>;
  getSeatVoterId(seatNftId: string, tokenId: string): Promise<string | null>;
  hasRequestVoteAccessKey(voterId: string, publicKey: string): Promise<boolean>;
  getBriefHash(voterId: string): Promise<string>;
  getVoterConfiguration(voterId: string): Promise<VoterConfiguration>;
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
      const voterId = await rpc.getSeatVoterId(seatNftId, token.token_id);
      if (!voterId || seenVoters.has(voterId)) continue;
      seenVoters.add(voterId);
      if (!await rpc.hasRequestVoteAccessKey(voterId, publicKey)) continue;

      const [briefHash, configuration] = await Promise.all([
        rpc.getBriefHash(voterId),
        rpc.getVoterConfiguration(voterId),
      ]);
      const skipReason = !briefHash.trim()
        ? "brief_not_set"
        : !configuration.agent_wasm_url.trim()
          || !/^[a-f0-9]{64}$/.test(configuration.agent_wasm_sha256)
          ? "agent_wasm_not_pinned"
          : null;
      if (skipReason) {
        if (!loggedSkippedVoters.has(voterId)) {
          loggedSkippedVoters.add(voterId);
          log({
            action: "discover_voters",
            status: "skipped",
            voter_id: voterId,
            reason: skipReason,
          });
        }
        continue;
      }
      voters.push(voterId);
    }

    if (tokens.length < TOKEN_PAGE_SIZE) break;
    fromIndex += tokens.length;
  }

  return voters;
}
