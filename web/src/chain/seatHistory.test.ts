import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/seat-4-ownership-history.json";
import { parseSeatOwnershipHistory, seatHolderDescription } from "./seatHistory";
import type { AccountTransactionSummary, FastNearTransaction } from "./history";

const fixtureData = fixture as {
  accountTransactions: AccountTransactionSummary[];
  transactions: FastNearTransaction[];
};

describe("parseSeatOwnershipHistory", () => {
  it("parses Seat 4's real claim, sale, and resale", () => {
    const history = parseSeatOwnershipHistory(
      "4",
      fixtureData.accountTransactions,
      fixtureData.transactions,
    );

    expect(history.holders.map((holder) => ({
      ownerId: holder.ownerId,
      description: seatHolderDescription(holder),
      txHash: holder.txHash,
    }))).toEqual([
      {
        ownerId: "seats-final-1794157607.testnet",
        description: "Claimed",
        txHash: "4rLzf36PgdCwMhBhwRRAXHeADNjteRztppsuy6cMXSRm",
      },
      {
        ownerId: "seats-buyer-1794158448.testnet",
        description: "Bought from seats-final-1794157607.testnet for 1 NEAR",
        txHash: "J29XAdseALfDtPpPmV8TNPCAvGP6Arvknz37eYo7gco4",
      },
      {
        ownerId: "seats-final-1794157607.testnet",
        description: "Bought from seats-buyer-1794158448.testnet for 0.5 NEAR",
        txHash: "DiNLcScc7K81KTFXve1p9P7nxu55DxywcHhbrSPJJDgh",
      },
    ]);
    expect(history.sales.map((sale) => [
      sale.priceYocto,
      sale.sellerAmountYocto,
      sale.clubAmountYocto,
    ])).toEqual([
      ["1000000000000000000000000", "950000000000000000000000", "50000000000000000000000"],
      ["500000000000000000000000", "475000000000000000000000", "25000000000000000000000"],
    ]);
  });

  it("ignores history for other token IDs", () => {
    expect(parseSeatOwnershipHistory(
      "5",
      fixtureData.accountTransactions,
      fixtureData.transactions,
    )).toEqual({ holders: [], sales: [] });
  });

  it("ignores failed transaction summaries", () => {
    expect(parseSeatOwnershipHistory(
      "4",
      fixtureData.accountTransactions.map((item) => ({ ...item, is_success: false })),
      fixtureData.transactions,
    )).toEqual({ holders: [], sales: [] });
  });
});
