import { readFileSync } from "node:fs";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { sendWithNonceRetry } from "./nonce.js";
import type { VoterDiscoveryRpc } from "./discovery.js";
import type { AgentRunnerRpc } from "./runner.js";
import type { PendingVote, Proposal, ResultsView } from "./logic.js";

type CallFunctionResult = {
  result: number[];
};

type Credential = {
  accountId: string;
  signer: KeyPairSigner;
};

const retryDelaysMs = [300, 900, 2_000, 4_000];
const maxRpcAttempts = retryDelaysMs.length + 1;

type RetryOptions = {
  broadcast?: boolean;
};

export interface KeyFileCredential {
  accountId: string;
  signer: KeyPairSigner;
  publicKey: Awaited<ReturnType<KeyPairSigner["getPublicKey"]>>;
}

export function loadCredential(
  keyFile: string,
  accountId: string,
  enforceAccountMatch = true,
): KeyFileCredential {
  const contents = requireFile(keyFile);
  let privateKey = contents.trim();
  let declaredAccountId: string | undefined;
  try {
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    if (typeof parsed.private_key === "string") {
      privateKey = parsed.private_key;
    }
    if (typeof parsed.account_id === "string") {
      declaredAccountId = parsed.account_id;
    }
  } catch {
    // Plain key files are accepted alongside NEAR credential JSON.
  }
  if (enforceAccountMatch && declaredAccountId && declaredAccountId !== accountId) {
    throw new Error(`Key file account does not match ${accountId}`);
  }
  const key = privateKey.trim() as KeyPairString;
  const keyPair = KeyPair.fromString(key);
  const signer = KeyPairSigner.fromSecretKey(key);
  return { accountId, signer, publicKey: keyPair.getPublicKey() };
}

export function credentialFromPrivateKey(accountId: string, secretKey: string): KeyFileCredential {
  const keyPair = KeyPair.fromString(secretKey as KeyPairString);
  return {
    accountId,
    signer: KeyPairSigner.fromSecretKey(secretKey as KeyPairString),
    publicKey: keyPair.getPublicKey(),
  };
}

function requireFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

export class NearAgentRpc implements AgentRunnerRpc, VoterDiscoveryRpc {
  private readonly providers: JsonRpcProvider[];
  private readonly credentials: Map<string, Credential>;
  private readonly keeper: Credential;
  private readonly nonceCache = new Map<string, bigint>();
  private agentWasmSha256Cache: { seatNftId: string; hash: string; expiresAt: number } | undefined;

  constructor(rpcUrls: string[], keeper: KeyFileCredential, voters: KeyFileCredential[]) {
    if (rpcUrls.length === 0) throw new Error("At least one NEAR RPC URL is required");
    this.providers = rpcUrls.map((url) => new JsonRpcProvider({ url }, { retries: 0 }));
    this.keeper = keeper;
    this.credentials = new Map(voters.map((voter) => [voter.accountId, voter]));
  }

  addCredential(credential: KeyFileCredential): void {
    this.credentials.set(credential.accountId, {
      accountId: credential.accountId,
      signer: credential.signer,
    });
  }

  removeCredential(accountId: string): void {
    this.credentials.delete(accountId);
  }

  async getSeatTokenPage(
    seatNftId: string,
    fromIndex: number,
    limit: number,
  ): Promise<Array<{ token_id: string }>> {
    return this.view<Array<{ token_id: string }>>(seatNftId, "nft_tokens", {
      from_index: String(fromIndex),
      limit,
    });
  }

  async getSeatVoterId(seatNftId: string, tokenId: string): Promise<string | null> {
    const seat = await this.view<{ voter_id: string } | null>(
      seatNftId,
      "get_seat",
      { token_id: tokenId },
    );
    return seat?.voter_id ?? null;
  }

  async isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    try {
      const accessKey = await this.withRetry((provider) =>
        provider.viewAccessKey(accountId, publicKey, { finality: "final" }));
      return accessKey.permission === "FullAccess";
    } catch {
      return false;
    }
  }

  async getTokenOwner(seatNftId: string, tokenId: string): Promise<string | null> {
    const token = await this.view<{ owner_id: string } | null>(
      seatNftId,
      "nft_token",
      { token_id: tokenId },
    );
    return token?.owner_id ?? null;
  }

  async getVoterController(voterId: string): Promise<string | null> {
    return this.view<string | null>(voterId, "get_controller", {});
  }

  async getAccountBalance(accountId: string): Promise<string> {
    const account = await this.withRetry((provider) =>
      provider.viewAccount(accountId, { finality: "final" }));
    return account.amount.toString();
  }

  async storeProfile(
    ownerId: string,
    profile: string,
    encryptedSecretsBase64: string,
    agentWasmSha256: string,
  ): Promise<string> {
    const credential = this.credentials.get(ownerId);
    if (!credential) throw new Error("No profile owner credential configured");
    return this.call(
      credential,
      "outlayer.testnet",
      "store_secrets",
      {
        accessor: { WasmHash: { hash: agentWasmSha256 } },
        profile,
        encrypted_secrets_base64: encryptedSecretsBase64,
        access: "AllowAll",
        vault_id: null,
      },
      50n,
      100_000_000_000_000_000_000_000n,
    );
  }

  async profileExists(ownerId: string, profile: string, agentWasmSha256: string): Promise<boolean> {
    const existing = await this.view<unknown>("outlayer.testnet", "get_secrets", {
      accessor: { WasmHash: { hash: agentWasmSha256 } },
      profile,
      owner: ownerId,
    });
    return existing !== null && existing !== undefined;
  }

  async hasRequestVoteAccessKey(voterId: string, publicKey: string): Promise<boolean> {
    try {
      const accessKey = await this.withRetry((provider) =>
        provider.viewAccessKey(voterId, publicKey, { finality: "final" }));
      const permission = accessKey.permission;
      if (typeof permission !== "object" || permission === null || !("FunctionCall" in permission)) {
        return false;
      }
      const functionCall = permission.FunctionCall;
      return functionCall.receiver_id === voterId
        && functionCall.method_names.includes("request_vote");
    } catch (error) {
      if (isMissingAccessKeyError(error)) return false;
      throw error;
    }
  }

  async getBriefHash(voterId: string): Promise<string> {
    return this.view<string>(voterId, "get_brief_hash", {});
  }

  async getAgentWasmSha256(seatNftId: string): Promise<string> {
    const now = Date.now();
    if (
      this.agentWasmSha256Cache?.seatNftId === seatNftId
      && this.agentWasmSha256Cache.expiresAt > now
    ) {
      return this.agentWasmSha256Cache.hash;
    }
    const defaults = await this.view<{ agent_wasm_sha256?: unknown } | null>(
      seatNftId,
      "get_voter_defaults",
      {},
    );
    const hash = defaults?.agent_wasm_sha256;
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Seat NFT returned an invalid agent WASM hash");
    }
    this.agentWasmSha256Cache = { seatNftId, hash, expiresAt: Date.now() + 60_000 };
    return hash;
  }

  async getLastProposalId(daoId: string): Promise<number> {
    const value = await this.view<number | string>(daoId, "get_last_proposal_id", {});
    const nextId = Number(value);
    if (!Number.isSafeInteger(nextId) || nextId < 0) {
      throw new Error("DAO returned an invalid get_last_proposal_id value");
    }
    return nextId;
  }

  async getProposalPeriodNs(daoId: string): Promise<bigint> {
    const policy = await this.view<{ proposal_period: string | number }>(daoId, "get_policy", {});
    const value = String(policy.proposal_period);
    if (!/^\d+$/.test(value)) {
      throw new Error("DAO returned an invalid get_policy proposal_period value");
    }
    return BigInt(value);
  }

  async getProposals(daoId: string, fromIndex: number, limit: number): Promise<Proposal[]> {
    return this.view<Proposal[]>(daoId, "get_proposals", {
      from_index: fromIndex,
      limit,
    });
  }

  async getAccountInfo(voterId: string): Promise<{
    amount: string;
    storageUsage: number;
  }> {
    const account = await this.withRetry((provider) =>
      provider.viewAccount(voterId, { finality: "optimistic" }));
    return { amount: account.amount.toString(), storageUsage: account.storage_usage };
  }

  async getPending(voterId: string, id: number): Promise<PendingVote | null> {
    return this.view<PendingVote | null>(voterId, "get_pending", { proposal_id: id });
  }

  async getResults(voterId: string): Promise<ResultsView> {
    return this.view<ResultsView>(voterId, "get_results", {});
  }

  async requestVote(voterId: string, id: number): Promise<string> {
    const credential = this.credentials.get(voterId);
    if (!credential) {
      throw new Error(`No agent credential configured for ${voterId}`);
    }
    return this.call(credential, voterId, "request_vote", { proposal_id: id }, 300n);
  }

  async cast(voterId: string, id: number): Promise<string> {
    return this.call(this.keeper, voterId, "cast", { proposal_id: id }, 300n);
  }

  private async view<T>(accountId: string, methodName: string, args: object): Promise<T> {
    const response = await this.withRetry((provider) => provider.sendJsonRpc<CallFunctionResult>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    }));
    return JSON.parse(Buffer.from(response.result).toString("utf8")) as T;
  }

  private async withRetry<T>(
    operation: (provider: JsonRpcProvider) => Promise<T>,
    { broadcast = false }: RetryOptions = {},
  ): Promise<T> {
    const attempts = Math.max(maxRpcAttempts, this.providers.length);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const provider = this.providers[attempt % this.providers.length];
        if (!provider) throw new Error("No NEAR RPC providers configured");
        return await operation(provider);
      } catch (error) {
        if (attempt + 1 >= attempts || !isRetryableRpcError(error, { broadcast })) {
          throw error;
        }
        const baseDelayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]!;
        const delayMs = baseDelayMs * (0.5 + Math.random() * 0.5);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new Error("NEAR RPC retries exhausted");
  }

  private async call(
    credential: Credential,
    receiverId: string,
    methodName: string,
    args: object,
    gasTgas: bigint,
    deposit = 0n,
  ): Promise<string> {
    const publicKey = await credential.signer.getPublicKey();
    const nonceProvider: Pick<JsonRpcProvider, "viewAccessKey"> = {
      viewAccessKey: (accountId, key, finality) => this.withRetry((provider) =>
        provider.viewAccessKey(accountId, key, finality)),
    };
    return sendWithNonceRetry(
      nonceProvider,
      credential.accountId,
      publicKey,
      this.nonceCache,
      async (nonce) => {
        const block = await this.withRetry((provider) =>
          provider.viewBlock({ finality: "optimistic" }));
        const transaction = createTransaction(
          credential.accountId,
          publicKey,
          receiverId,
          nonce,
          [actionCreators.functionCall(
            methodName,
            args,
            gasTgas * 1_000_000_000_000n,
            deposit,
          )],
          baseDecode(block.header.hash),
        );
        const [hashBytes, signedTransaction] = await credential.signer.signTransaction(transaction);
        const outcome = await this.withRetry(
          (provider) => provider.sendTransaction(signedTransaction),
          { broadcast: true },
        );
        const failure = transactionFailure(outcome);
        if (failure !== null) {
          throw new Error(failure);
        }
        return baseEncode(hashBytes);
      },
    );
  }
}

function isRetryableRpcError(error: unknown, { broadcast = false }: RetryOptions = {}): boolean {
  const messages: string[] = [];
  const names: string[] = [];
  const codes: number[] = [];
  const statuses: number[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const details = current as {
        name?: unknown;
        message?: unknown;
        type?: unknown;
        code?: unknown;
        status?: unknown;
        statusCode?: unknown;
        cause?: unknown;
      };
      if (details.name !== undefined) {
        names.push(String(details.name));
        messages.push(String(details.name));
      }
      if (details.message !== undefined) messages.push(String(details.message));
      if (details.type !== undefined) messages.push(String(details.type));
      for (const code of [details.code, details.status, details.statusCode]) {
        if (code !== undefined) messages.push(String(code));
        const numericCode = typeof code === "number" ? code : Number(code);
        if (Number.isInteger(numericCode)) {
          codes.push(numericCode);
          if (code === details.status || code === details.statusCode) statuses.push(numericCode);
        }
      }
      current = details.cause;
    } else {
      messages.push(String(current));
      const numericCause = typeof current === "number" ? current : Number(current);
      if (Number.isInteger(numericCause)) statuses.push(numericCause);
      current = undefined;
    }
  }

  const message = messages.join(" ");
  const rateLimited = codes.includes(-429)
    || codes.includes(429)
    || statuses.includes(429)
    || /-429\b|rate limits exceeded|\bHTTP(?:\/\d(?:\.\d)?\s+)?(?:status\s+)?429\b/i.test(message);
  if (rateLimited) return true;
  if (broadcast) return false;

  const serverError = statuses.some((status) => status >= 500 && status <= 599)
    || codes.some((code) => code >= 500 && code <= 599)
    || /\bHTTP(?:\/\d(?:\.\d)?\s+)?(?:status\s+)?5\d{2}\b|(?:status|cause)\s*[:=]?\s*5\d{2}\b/i.test(message);
  if (serverError) return true;

  const timeout = /\btimeout\b|\btimed?\s*out\b|ETIMEDOUT|UND_ERR_.*TIMEOUT/i.test(message)
    || names.some((name) => /^(?:AbortError|TimeoutError|Timeout)$/i.test(name));
  const connectionError = /ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|connection (?:reset|refused|closed|timed out)|fetch failed|failed to fetch|network error/i
    .test(message);
  const fetchTypeError = names.some((name) => name === "TypeError")
    && /fetch|network|connection|socket/i.test(message);
  const fetchError = names.some((name) => name === "FetchError");
  return timeout || connectionError || fetchTypeError || fetchError;
}

function isMissingAccessKeyError(error: unknown): boolean {
  const details = error && typeof error === "object"
    ? error as { type?: unknown; name?: unknown; message?: unknown }
    : undefined;
  const message = [
    details?.type,
    details?.name,
    details?.message,
    error,
  ].map(String).join(" ");
  return /UNKNOWN_ACCESS_KEY|AccessKeyDoesNotExist|access key[^\n]*(?:not found|does not exist)/i
    .test(message);
}

function transactionFailure(outcome: unknown): string | null {
  const result = outcome as {
  status?: { Failure?: unknown };
  transaction_outcome?: { outcome?: { status?: { Failure?: unknown } } };
  receipts_outcome?: Array<{ outcome?: { status?: { Failure?: unknown } } }>;
  };
  const failures = [
    result.status?.Failure,
    result.transaction_outcome?.outcome?.status?.Failure,
    ...(result.receipts_outcome ?? []).map((receipt) => receipt.outcome?.status?.Failure),
  ].filter((failure) => failure !== undefined);
  return failures.length > 0 ? JSON.stringify(failures) : null;
}
