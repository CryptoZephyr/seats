import { actionCreators } from "@near-js/transactions";
import type { Wallet } from "@near-wallet-selector/core";
import { chainConfig } from "./config";

export type VoterMethod = "override_vote" | "cancel";
export type VoterArgs<Method extends VoterMethod> =
  Method extends "override_vote"
    ? { proposal_id: number; vote: "Approve" | "Reject" }
    : { proposal_id: number };

const VOTER_CALL_GAS = 30_000_000_000_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFailureStatus(value: unknown): boolean {
  return value === "Failure" || (isRecord(value) && Object.hasOwn(value, "Failure"));
}

export function contractErrorCode(value: unknown): string | null {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      const match = current.match(/ERR_[A-Z_]+/);
      if (match) return match[0];
      continue;
    }
    if (!isRecord(current) && !Array.isArray(current)) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (current instanceof Error) {
      pending.push(current.message, current.stack, current.cause);
    }
    if (Array.isArray(current)) {
      pending.push(...current);
    } else {
      pending.push(...Object.values(current));
    }
  }

  return null;
}

export function friendlyVoteError(code: string): string {
  switch (code) {
    case "ERR_NOT_CONTROLLER":
      return "This account doesn't control this seat.";
    case "ERR_NO_PENDING":
      return "This vote is no longer waiting to be sent.";
    case "ERR_WINDOW_CLOSED":
      return "The time to change this vote has passed.";
    case "ERR_CASTING":
      return "Your delegate's vote is already being sent.";
    case "ERR_INVALID_VOTE":
      return "That vote choice isn't allowed.";
    default:
      return `The vote couldn't be changed. Error code: ${code}`;
  }
}

export async function voterCall<Method extends VoterMethod>(
  wallet: Wallet,
  signerId: string,
  voterId: string,
  method: Method,
  args: VoterArgs<Method>,
): Promise<string> {
  if (!signerId.endsWith(".testnet") || !voterId.endsWith(".testnet")) {
    throw new Error("Vote changes are restricted to NEAR testnet accounts.");
  }

  const outcome = await wallet.signAndSendTransaction({
    signerId,
    receiverId: voterId,
    actions: [actionCreators.functionCall(method, args, VOTER_CALL_GAS, 0n)],
  });

  if (isFailureStatus(outcome.status)) {
    const code = contractErrorCode(outcome);
    throw new Error(code ?? "The vote change failed.", { cause: outcome });
  }

  return outcome.transaction.hash;
}

export function explorerTxUrl(hash: string): string {
  return `${chainConfig.explorerTxBaseUrl}${encodeURIComponent(hash)}`;
}
