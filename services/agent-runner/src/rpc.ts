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
import type { AgentRunnerRpc } from "./runner.js";
import type { PendingVote, Proposal, ResultsView } from "./logic.js";

type CallFunctionResult = {
  result: number[];
};

type Credential = {
  accountId: string;
  signer: KeyPairSigner;
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

function requireFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

export class NearAgentRpc implements AgentRunnerRpc {
  private readonly provider: JsonRpcProvider;
  private readonly credentials: Map<string, Credential>;
  private readonly keeper: Credential;
  private readonly nonceCache = new Map<string, bigint>();

  constructor(rpcUrl: string, keeper: KeyFileCredential, voters: KeyFileCredential[]) {
    this.provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 0 });
    this.keeper = keeper;
    this.credentials = new Map(voters.map((voter) => [voter.accountId, voter]));
  }

  async getLastProposalId(daoId: string): Promise<number> {
    const value = await this.view<number | string>(daoId, "get_last_proposal_id", {});
    const nextId = Number(value);
    if (!Number.isSafeInteger(nextId) || nextId < 0) {
      throw new Error("DAO returned an invalid get_last_proposal_id value");
    }
    return nextId;
  }

  async getProposals(daoId: string, fromIndex: number, limit: number): Promise<Proposal[]> {
    return this.view<Proposal[]>(daoId, "get_proposals", {
      from_index: fromIndex,
      limit,
    });
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
    const response = await this.provider.sendJsonRpc<CallFunctionResult>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(response.result).toString("utf8")) as T;
  }

  private async call(
    credential: Credential,
    receiverId: string,
    methodName: string,
    args: object,
    gasTgas: bigint,
  ): Promise<string> {
    const publicKey = await credential.signer.getPublicKey();
    return sendWithNonceRetry(
      this.provider,
      credential.accountId,
      publicKey,
      this.nonceCache,
      async (nonce) => {
        const block = await this.provider.viewBlock({ finality: "optimistic" });
        const transaction = createTransaction(
          credential.accountId,
          publicKey,
          receiverId,
          nonce,
          [actionCreators.functionCall(
            methodName,
            args,
            gasTgas * 1_000_000_000_000n,
            0n,
          )],
          baseDecode(block.header.hash),
        );
        const [hashBytes, signedTransaction] = await credential.signer.signTransaction(transaction);
        const outcome = await this.provider.sendTransaction(signedTransaction);
        const failure = transactionFailure(outcome);
        if (failure !== null) {
          throw new Error(failure);
        }
        return baseEncode(hashBytes);
      },
    );
  }
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
