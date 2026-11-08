import { actionCreators } from "@near-js/transactions";
import type { FinalExecutionOutcome, Wallet } from "@near-wallet-selector/core";
import { chainConfig } from "./config";
import { getTransactionStatus } from "./rpc";

export type VoterMethod = "override_vote" | "cancel" | "set_brief";
export type VoterArgs<Method extends VoterMethod> =
  Method extends "override_vote"
    ? { proposal_id: number; vote: "Approve" | "Reject" }
    : Method extends "cancel"
      ? { proposal_id: number }
      : { brief_hash: string; secrets_account_id: string; secrets_profile: string };

const VOTER_CALL_GAS = 30_000_000_000_000n;
const TGAS = 1_000_000_000_000n;
export const PROPOSAL_CALL_GAS = 50n * TGAS;
export const PROPOSAL_ACTION_GAS = 10n * TGAS;
export const CLAIM_SEAT_GAS = 300n * TGAS;
export const CLAIM_SEAT_DEPOSIT = 4_500_000_000_000_000_000_000_000n;
export const BUY_SEAT_GAS = 300n * TGAS;
export const VAULT_REQUEST_GAS = 300n * TGAS;
export const VAULT_ESTIMATE_BUFFER = 500_000_000_000n;
export const APPLICATION_DURATION_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
export const SALE_LEVY_BPS = 500n;
export const SET_BRIEF_GAS = 30_000_000_000_000n;

export interface FunctionCallRequest {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

export interface FunctionCallResult {
  hash: string;
  outcome: FinalExecutionOutcome;
}

export function toBase64Json(value: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildApplyRequest(
  applicant: string,
  proposalBond: string | number,
): FunctionCallRequest {
  if (!/^\d+$/.test(String(proposalBond))) throw new Error("DAO returned an invalid proposal bond.");
  return {
    receiverId: chainConfig.daoAccountId,
    methodName: "add_proposal",
    args: {
      proposal: {
        description: `Apply for a seat for ${applicant}`,
        kind: {
          FunctionCall: {
            receiver_id: chainConfig.seatNftAccountId,
            actions: [{
              method_name: "approve_application",
              args: toBase64Json({ applicant, expires_in_ns: APPLICATION_DURATION_NS }),
              deposit: "0",
              gas: String(PROPOSAL_ACTION_GAS),
            }],
          },
        },
      },
    },
    gas: PROPOSAL_CALL_GAS,
    deposit: BigInt(String(proposalBond)),
  };
}

export function buildClaimRequest(agentPublicKey: string): FunctionCallRequest {
  return {
    receiverId: chainConfig.seatNftAccountId,
    methodName: "claim_seat",
    args: { agent_public_key: agentPublicKey },
    gas: CLAIM_SEAT_GAS,
    deposit: CLAIM_SEAT_DEPOSIT,
  };
}

export function buildSaleRequest(
  tokenId: string,
  buyer: string,
  priceYocto: string,
  expiresInNs: number,
  proposalBond: string | number,
): FunctionCallRequest {
  if (!/^\d+$/.test(String(proposalBond))) throw new Error("DAO returned an invalid proposal bond.");
  if (!/^\d+$/.test(priceYocto) || BigInt(priceYocto) <= 0n) throw new Error("Enter a price above zero.");
  if (!Number.isSafeInteger(expiresInNs) || expiresInNs <= 0) throw new Error("Choose a valid sale expiry.");
  return {
    receiverId: chainConfig.daoAccountId,
    methodName: "add_proposal",
    args: {
      proposal: {
        description: `Sell Seat ${tokenId} to ${buyer} for ${formatNearAmount(priceYocto)} NEAR`,
        kind: {
          FunctionCall: {
            receiver_id: chainConfig.seatNftAccountId,
            actions: [{
              method_name: "approve_sale",
              args: toBase64Json({
                token_id: tokenId,
                buyer,
                price: priceYocto,
                expires_in_ns: expiresInNs,
              }),
              deposit: "0",
              gas: String(PROPOSAL_ACTION_GAS),
            }],
          },
        },
      },
    },
    gas: PROPOSAL_CALL_GAS,
    deposit: BigInt(String(proposalBond)),
  };
}

export function formatNearAmount(value: string | bigint): string {
  const amount = BigInt(value);
  const whole = amount / 10n ** 24n;
  const fraction = (amount % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function buildBuyRequest(tokenId: string, priceYocto: string): FunctionCallRequest {
  if (!/^\d+$/.test(priceYocto) || BigInt(priceYocto) <= 0n) throw new Error("Sale approval has an invalid price.");
  return {
    receiverId: chainConfig.seatNftAccountId,
    methodName: "buy",
    args: { token_id: tokenId, agent_public_key: chainConfig.runnerAgentPublicKey },
    gas: BUY_SEAT_GAS,
    deposit: BigInt(priceYocto),
  };
}

export function buildSetBriefRequest(
  voterId: string,
  briefHash: string,
  secretsAccountId: string,
  secretsProfile: string,
): FunctionCallRequest {
  if (!/^[0-9a-f]{64}$/.test(briefHash)) throw new Error("The brief fingerprint is invalid.");
  if (!isTestnetAccountId(voterId) || !isTestnetAccountId(secretsAccountId)) {
    throw new Error("Brief transactions are restricted to NEAR testnet accounts.");
  }
  if (!/^s\d+-[0-9a-f]{16}$/.test(secretsProfile)) throw new Error("The private profile name is invalid.");
  return {
    receiverId: voterId,
    methodName: "set_brief",
    args: { brief_hash: briefHash, secrets_account_id: secretsAccountId, secrets_profile: secretsProfile },
    gas: SET_BRIEF_GAS,
    deposit: 0n,
  };
}

export interface VaultResourceLimits {
  max_execution_seconds: number;
  max_instructions: number;
  max_memory_mb: number;
}

export function buildVaultRequest(
  requesterPublicKey: string,
  estimatedCostYocto: string | bigint,
): FunctionCallRequest {
  const publicKey = requesterPublicKey.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) throw new Error("The vault key is invalid.");
  if (!/^\d+$/.test(String(estimatedCostYocto))) throw new Error("OutLayer returned an invalid cost estimate.");
  const limits: VaultResourceLimits = {
    max_execution_seconds: 10,
    max_instructions: 1_000_000_000,
    max_memory_mb: 128,
  };
  return {
    receiverId: chainConfig.outlayerAccountId,
    methodName: "request_execution",
    args: {
      input_data: JSON.stringify({ requester_pubkey: publicKey }),
      params: null,
      payer_account_id: null,
      resource_limits: limits,
      response_format: "Json",
      secrets_ref: { account_id: "seatfunder-1793834028.testnet", profile: "vault-seats3" },
      source: {
        Project: {
          project_id: "seatfunder-1793834028.testnet/vault-check-job",
          version_key: null,
        },
      },
    },
    gas: VAULT_REQUEST_GAS,
    deposit: BigInt(String(estimatedCostYocto)) + VAULT_ESTIMATE_BUFFER,
  };
}

export function calculateSaleSplit(priceYocto: string | bigint, levyBps: number | bigint) {
  const price = BigInt(priceYocto);
  const levy = BigInt(levyBps);
  if (levy !== SALE_LEVY_BPS) {
    throw new Error(`This seat's club levy is ${levy} bps. Sale previews require 500 bps.`);
  }
  if (price <= 0n) throw new Error("Enter a price above zero.");
  const club = price * levy / 10_000n;
  return { seller: price - club, club };
}

export function parseNearAmount(value: string): bigint {
  const normalized = value.trim();
  const match = normalized.match(/^(?:0|[1-9]\d*)(?:\.(\d{0,24}))?$/);
  if (!match) throw new Error("Enter a NEAR price with up to 24 decimal places.");
  const [whole, fraction = ""] = normalized.split(".");
  const amount = BigInt(whole) * 10n ** 24n + BigInt((fraction + "0".repeat(24)).slice(0, 24));
  if (amount <= 0n) throw new Error("Enter a price above zero.");
  return amount;
}

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

export function friendlyContractError(code: string): string {
  switch (code) {
    case "ERR_ALREADY_MEMBER":
      return "This account already holds a seat in the club.";
    case "ERR_INSUFFICIENT_DEPOSIT":
      return "The wallet balance is too low for this deposit and gas.";
    case "ERR_NO_APPLICATION":
      return "There is no active seat approval for this account.";
    case "ERR_APPLICATION_EXPIRED":
      return "This seat approval expired. You can apply again.";
    case "ERR_BAD_APPLICATION_EXPIRY":
      return "The requested application expiry isn't valid.";
    case "ERR_INVALID_APPLICATION_APPROVAL":
      return "The club's application approval couldn't be used.";
    case "ERR_NO_APPROVAL":
      return "There is no active sale approval for this seat.";
    case "ERR_NO_SEAT":
    case "ERR_NO_TOKEN":
      return "This account no longer holds the required seat.";
    case "ERR_SAME_BUYER":
      return "Choose a buyer account other than your own.";
    case "ERR_BAD_PRICE":
      return "Enter a price above zero.";
    case "ERR_BAD_EXPIRY":
      return "Choose a valid sale expiry.";
    case "ERR_WRONG_BUYER":
      return "This seat is reserved for a different testnet account.";
    case "ERR_APPROVAL_EXPIRED":
      return "This sale approval expired. The seller must request a new one.";
    case "ERR_BUY_IN_PROGRESS":
      return "This purchase is already being processed.";
    case "ERR_WRONG_DEPOSIT":
      return "The attached NEAR doesn't match the approved price.";
    case "ERR_PRICE_OVERFLOW":
      return "That price is too large to process.";
    default:
      return `This request couldn't be completed. Error code: ${code}`;
  }
}

export function isTestnetAccountId(accountId: string): boolean {
  return /^[a-z0-9._-]+\.testnet$/.test(accountId);
}

export async function sendFunctionCall(
  wallet: Wallet,
  signerId: string,
  request: FunctionCallRequest,
): Promise<FunctionCallResult> {
  if (!isTestnetAccountId(signerId) || !isTestnetAccountId(request.receiverId)) {
    throw new Error("Transactions are restricted to NEAR testnet accounts.");
  }
  let outcome: FinalExecutionOutcome | undefined;
  let resolvedHash: string | undefined;
  try {
    const walletOutcome = await wallet.signAndSendTransaction({
      signerId,
      receiverId: request.receiverId,
      actions: [actionCreators.functionCall(request.methodName, request.args, request.gas, request.deposit)],
    });
    if (walletOutcome) outcome = walletOutcome;
  } catch (error) {
    const details = error as { hash?: string; txHash?: string; transactionHash?: string; transaction?: { hash?: string } };
    const hash = details.transaction?.hash ?? details.txHash ?? details.transactionHash ?? details.hash ??
      String(error).match(/[1-9A-HJ-NP-Za-km-z]{43,44}/)?.[0];
    if (hash) {
      try {
        resolvedHash = hash;
        outcome = await getTransactionStatus(hash, signerId) as FinalExecutionOutcome;
      } catch {
        throw error;
      }
    } else {
      throw error;
    }
  }
  if (!outcome) throw new Error("The wallet returned no transaction outcome.");
  if (isFailureStatus(outcome.status)) {
    const code = contractErrorCode(outcome);
    throw new Error(code ?? "The transaction failed.", { cause: outcome });
  }
  const hash = outcome.transaction?.hash ?? resolvedHash ??
    (outcome as FinalExecutionOutcome & { transaction_outcome?: { id?: string } }).transaction_outcome?.id;
  if (!hash) throw new Error("The wallet returned no transaction hash.", { cause: outcome });
  return { hash, outcome };
}

export async function voterCall<Method extends VoterMethod>(
  wallet: Wallet,
  signerId: string,
  voterId: string,
  method: Method,
  args: VoterArgs<Method>,
): Promise<string> {
  const result = await sendFunctionCall(wallet, signerId, {
    receiverId: voterId,
    methodName: method,
    args,
    gas: VOTER_CALL_GAS,
    deposit: 0n,
  });
  return result.hash;
}

export function explorerTxUrl(hash: string): string {
  return `${chainConfig.explorerTxBaseUrl}${encodeURIComponent(hash)}`;
}
