import { chainConfig } from "./config";
import {
  loadFastNearAccountTransactions,
  loadFastNearTransactions,
  type FastNearTransaction,
} from "./history";
import { SALE_LEVY_BPS, formatNearAmount } from "./transactions";

export interface SeatHolderRecord {
  ownerId: string;
  timestampNs: string;
  txHash: string;
  acquiredBy: "claim" | "purchase";
  sellerId?: string;
  priceYocto?: string;
}

export interface SeatSaleRecord {
  sellerId: string;
  buyerId: string;
  priceYocto: string;
  sellerAmountYocto: string;
  clubAmountYocto: string;
  timestampNs: string;
  txHash: string;
}

export interface SeatOwnershipHistory {
  holders: SeatHolderRecord[];
  sales: SeatSaleRecord[];
}

interface NftEventData {
  owner_id?: string;
  old_owner_id?: string;
  new_owner_id?: string;
  token_ids?: string[];
}

interface NftEvent {
  standard?: string;
  event?: string;
  data?: NftEventData[];
}

function decodeArgs(encoded: string): Record<string, unknown> | null {
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nftEvents(transaction: FastNearTransaction): NftEvent[] {
  const logs = [
    ...(transaction.execution_outcome?.outcome?.logs ?? []),
    ...(transaction.receipts ?? []).flatMap((receipt) => receipt.execution_outcome?.outcome?.logs ?? []),
  ];
  return [...new Set(logs)].flatMap((log) => {
    if (!log.startsWith("EVENT_JSON:")) return [];
    try {
      const event = JSON.parse(log.slice("EVENT_JSON:".length)) as NftEvent;
      return event.standard === "nep171" ? [event] : [];
    } catch {
      return [];
    }
  });
}

export function parseSeatOwnershipHistory(
  tokenId: string,
  accountTransactions: Array<{ transaction_hash: string; tx_block_timestamp: string | number; is_success: boolean }>,
  transactions: FastNearTransaction[],
): SeatOwnershipHistory {
  const timestampByHash = new Map(
    accountTransactions
      .filter((item) => item.is_success)
      .map((item) => [item.transaction_hash, String(item.tx_block_timestamp)]),
  );
  const holders: SeatHolderRecord[] = [];
  const sales: SeatSaleRecord[] = [];

  for (const transaction of transactions) {
    const { transaction: tx } = transaction;
    const timestampNs = timestampByHash.get(tx.hash);
    if (!timestampNs || tx.receiver_id !== chainConfig.seatNftAccountId) continue;

    const calls = tx.actions.flatMap((action) => action.FunctionCall ? [action.FunctionCall] : []);
    const claimCall = calls.find((call) => call.method_name === "claim_seat");
    if (claimCall) {
      const claimArgs = decodeArgs(claimCall.args);
      for (const event of nftEvents(transaction)) {
        if (event.event !== "nft_mint") continue;
        for (const data of event.data ?? []) {
          if (
            (claimArgs?.token_id !== tokenId && !data.token_ids?.includes(tokenId)) ||
            (!data.owner_id && !tx.signer_id)
          ) continue;
          holders.push({
            ownerId: data.owner_id ?? tx.signer_id,
            timestampNs,
            txHash: tx.hash,
            acquiredBy: "claim",
          });
        }
      }
    }

    const buyCall = calls.find((call) => call.method_name === "buy");
    const buyArgs = buyCall ? decodeArgs(buyCall.args) : null;
    if (!buyCall?.deposit || !/^\d+$/.test(buyCall.deposit)) continue;
    const price = BigInt(buyCall.deposit);
    const clubAmount = price * SALE_LEVY_BPS / 10_000n;
    for (const event of nftEvents(transaction)) {
      if (event.event !== "nft_transfer") continue;
      for (const data of event.data ?? []) {
        const sellerId = data.old_owner_id;
        const buyerId = data.new_owner_id;
        if (
          !sellerId ||
          !buyerId ||
          (buyArgs?.token_id !== tokenId && !data.token_ids?.includes(tokenId))
        ) continue;
        holders.push({
          ownerId: buyerId,
          timestampNs,
          txHash: tx.hash,
          acquiredBy: "purchase",
          sellerId,
          priceYocto: price.toString(),
        });
        sales.push({
          sellerId,
          buyerId,
          priceYocto: price.toString(),
          sellerAmountYocto: (price - clubAmount).toString(),
          clubAmountYocto: clubAmount.toString(),
          timestampNs,
          txHash: tx.hash,
        });
      }
    }
  }

  holders.sort((left, right) =>
    BigInt(left.timestampNs) < BigInt(right.timestampNs) ? -1 :
      BigInt(left.timestampNs) > BigInt(right.timestampNs) ? 1 : 0);
  sales.sort((left, right) =>
    BigInt(left.timestampNs) < BigInt(right.timestampNs) ? -1 :
      BigInt(left.timestampNs) > BigInt(right.timestampNs) ? 1 : 0);
  return { holders, sales };
}

export async function loadSeatOwnershipHistory(tokenId: string): Promise<SeatOwnershipHistory> {
  const accountTransactions = await loadFastNearAccountTransactions(chainConfig.seatNftAccountId);
  const transactions = await loadFastNearTransactions(
    accountTransactions.filter((item) => item.is_success && item.is_function_call !== false),
  );
  return parseSeatOwnershipHistory(tokenId, accountTransactions, transactions);
}

export function seatHolderDescription(holder: SeatHolderRecord): string {
  return holder.acquiredBy === "claim"
    ? "Minted"
    : `Bought from ${holder.sellerId} for ${formatNearAmount(holder.priceYocto!)} NEAR`;
}
