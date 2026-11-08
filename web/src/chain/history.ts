export interface AccountTransactionSummary {
  transaction_hash: string;
  tx_block_timestamp: string | number;
  is_success: boolean;
}

export interface FastNearTransaction {
  transaction: {
    signer_id: string;
    receiver_id: string;
    actions: Array<{
      FunctionCall?: {
        method_name: string;
        args: string;
      };
    }>;
    hash: string;
  };
}

export interface MemberChange {
  method: "override_vote" | "cancel";
  vote?: string;
  txHash: string;
  timestampNs: string;
}

export interface MemberChangeHistory {
  latest: MemberChange | null;
  firstOverride: MemberChange | null;
}

export function originalDelegateVote(
  firstOverride: MemberChange | null | undefined,
): "Approve" | "Reject" | null {
  if (firstOverride?.method !== "override_vote") return null;
  if (firstOverride.vote === "Approve") return "Reject";
  if (firstOverride.vote === "Reject") return "Approve";
  return null;
}

export function isCurrentVoteOverridden(
  history: MemberChangeHistory | null,
  currentVote: string | null,
): boolean {
  const originalVote = originalDelegateVote(history?.firstOverride);
  return history?.latest?.method === "override_vote" &&
    (currentVote === "Approve" || currentVote === "Reject") &&
    originalVote !== null &&
    currentVote !== originalVote;
}

interface AccountPage {
  account_txs: AccountTransactionSummary[];
  resume_token?: string | null;
}

interface TransactionsResponse {
  transactions: FastNearTransaction[];
}

const ACCOUNT_URL = "https://tx.test.fastnear.com/v0/account";
const TRANSACTIONS_URL = "https://tx.test.fastnear.com/v0/transactions";
const ACCOUNT_PAGE_LIMIT = 200;
const MAX_HISTORY_PAGES = 10;
const TRANSACTION_BATCH_SIZE = 20;

function decodeArgs(encoded: string): Record<string, unknown> | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseLatestMemberChange(
  accountTransactions: AccountTransactionSummary[],
  transactions: FastNearTransaction[],
  voterId: string,
  controller: string,
  proposalId: number,
): MemberChangeHistory {
  const successfulByHash = new Map(
    accountTransactions
      .filter((item) => item.is_success)
      .map((item) => [item.transaction_hash, item]),
  );
  const changes: MemberChange[] = [];

  for (const item of transactions) {
    const transaction = item.transaction;
    const accountRecord = successfulByHash.get(transaction.hash);
    if (
      !accountRecord ||
      transaction.signer_id !== controller ||
      transaction.receiver_id !== voterId
    ) {
      continue;
    }

    for (const action of transaction.actions) {
      const call = action.FunctionCall;
      if (!call || (call.method_name !== "override_vote" && call.method_name !== "cancel")) {
        continue;
      }

      const args = decodeArgs(call.args);
      if (Number(args?.proposal_id) !== proposalId) continue;

      const timestampNs = String(accountRecord.tx_block_timestamp);
      try {
        BigInt(timestampNs);
      } catch {
        continue;
      }

      changes.push(
        call.method_name === "override_vote"
          ? {
              method: call.method_name,
              vote: typeof args?.vote === "string" ? args.vote : undefined,
              txHash: transaction.hash,
              timestampNs,
            }
          : {
              method: call.method_name,
              txHash: transaction.hash,
              timestampNs,
            },
      );
    }
  }

  changes.sort((left, right) => {
    const leftTimestamp = BigInt(left.timestampNs);
    const rightTimestamp = BigInt(right.timestampNs);
    return leftTimestamp < rightTimestamp ? -1 : leftTimestamp > rightTimestamp ? 1 : 0;
  });

  return {
    latest: changes.at(-1) ?? null,
    firstOverride: changes.find((change) => change.method === "override_vote") ?? null,
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Vote history returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

export async function latestMemberChange(
  voterId: string,
  controller: string,
  proposalId: number,
): Promise<MemberChangeHistory> {
  const accountTransactions: AccountTransactionSummary[] = [];
  const seenTokens = new Set<string>();
  let resumeToken: string | undefined;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const body: Record<string, unknown> = {
      account_id: voterId,
      is_function_call: true,
      limit: ACCOUNT_PAGE_LIMIT,
    };
    if (resumeToken) body.resume_token = resumeToken;

    const result = await postJson<AccountPage>(ACCOUNT_URL, body);
    accountTransactions.push(...result.account_txs);
    const nextToken = result.resume_token;
    if (!nextToken || seenTokens.has(nextToken) || result.account_txs.length === 0) break;
    seenTokens.add(nextToken);
    resumeToken = nextToken;
  }

  const hashes = [...new Set(
    accountTransactions
      .filter((item) => item.is_success)
      .map((item) => item.transaction_hash),
  )];
  const transactionBatches = await Promise.all(
    Array.from({ length: Math.ceil(hashes.length / TRANSACTION_BATCH_SIZE) }, (_, index) =>
      postJson<TransactionsResponse>(
        TRANSACTIONS_URL,
        { tx_hashes: hashes.slice(index * TRANSACTION_BATCH_SIZE, (index + 1) * TRANSACTION_BATCH_SIZE) },
      ),
    ),
  );

  return parseLatestMemberChange(
    accountTransactions,
    transactionBatches.flatMap((batch) => batch.transactions),
    voterId,
    controller,
    proposalId,
  );
}
