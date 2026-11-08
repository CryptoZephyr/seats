import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/proposal-6-override.json";
import {
  parseLatestMemberChange,
  type AccountTransactionSummary,
  type FastNearTransaction,
} from "./history";

const voterId = "s1.seatsnft3-1793848334.testnet";
const controller = "rb.seatsfund1-1793846395.testnet";
const transactionHash = "8UJ9FTgsQauPy6rZK8LhMp4ihXy4BWyLkwsx344tTypR";
const timestampNs = "1793861465477208362";
const fixtureData = fixture as {
  accountTransaction: AccountTransactionSummary;
  transactions: FastNearTransaction[];
};

function accountTransaction(
  hash = transactionHash,
  isSuccess = true,
): AccountTransactionSummary {
  return { transaction_hash: hash, tx_block_timestamp: timestampNs, is_success: isSuccess };
}

function transaction(
  method: "override_vote" | "cancel",
  proposalId = 6,
  signerId = controller,
  hash = transactionHash,
): FastNearTransaction {
  const args = method === "override_vote"
    ? { proposal_id: proposalId, vote: "Reject" }
    : { proposal_id: proposalId };
  return {
    transaction: {
      signer_id: signerId,
      receiver_id: voterId,
      actions: [{
        FunctionCall: {
          method_name: method,
          args: btoa(JSON.stringify(args)),
        },
      }],
      hash,
    },
  };
}

describe("parseLatestMemberChange", () => {
  it("parses the real proposal 6 override transaction", () => {
    expect(parseLatestMemberChange(
      [fixtureData.accountTransaction],
      fixtureData.transactions,
      voterId,
      controller,
      6,
    )).toEqual({
      method: "override_vote",
      vote: "Reject",
      txHash: transactionHash,
      timestampNs,
    });
  });

  it("parses a cancel call without inventing a vote", () => {
    const hash = "cancel-hash";
    expect(parseLatestMemberChange(
      [accountTransaction(hash)],
      [transaction("cancel", 6, controller, hash)],
      voterId,
      controller,
      6,
    )).toEqual({ method: "cancel", txHash: hash, timestampNs });
  });

  it("ignores failed transactions", () => {
    expect(parseLatestMemberChange(
      [accountTransaction(transactionHash, false)],
      [transaction("override_vote")],
      voterId,
      controller,
      6,
    )).toBeNull();
  });

  it("ignores calls from a different signer", () => {
    const otherSigner = "someone.testnet";
    expect(parseLatestMemberChange(
      [accountTransaction()],
      [transaction("override_vote", 6, otherSigner)],
      voterId,
      controller,
      6,
    )).toBeNull();
  });

  it("ignores calls for a different proposal", () => {
    expect(parseLatestMemberChange(
      [accountTransaction()],
      [transaction("override_vote", 5)],
      voterId,
      controller,
      6,
    )).toBeNull();
  });
});
