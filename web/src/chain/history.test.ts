import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/proposal-6-override.json";
import {
  isCurrentVoteOverridden,
  originalDelegateVote,
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
  timestamp = timestampNs,
): AccountTransactionSummary {
  return { transaction_hash: hash, tx_block_timestamp: timestamp, is_success: isSuccess };
}

function transaction(
  method: "override_vote" | "cancel",
  proposalId = 6,
  signerId = controller,
  hash = transactionHash,
  vote: "Approve" | "Reject" = "Reject",
  receiverId = voterId,
): FastNearTransaction {
  const args = method === "override_vote"
    ? { proposal_id: proposalId, vote }
    : { proposal_id: proposalId };
  return {
    transaction: {
      signer_id: signerId,
      receiver_id: receiverId,
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
      6,
    )).toEqual({
      latest: {
        method: "override_vote",
        signerId: controller,
        vote: "Reject",
        txHash: transactionHash,
        timestampNs,
      },
      firstOverride: {
        method: "override_vote",
        signerId: controller,
        vote: "Reject",
        txHash: transactionHash,
        timestampNs,
      },
    });
  });

  it("parses a cancel call without inventing a vote", () => {
    const hash = "cancel-hash";
    const previousController = "former-member.testnet";
    expect(parseLatestMemberChange(
      [accountTransaction(hash)],
      [transaction("cancel", 6, previousController, hash)],
      voterId,
      6,
    )).toEqual({
      latest: { method: "cancel", signerId: previousController, txHash: hash, timestampNs },
      firstOverride: null,
    });
  });

  it("ignores failed transactions", () => {
    expect(parseLatestMemberChange(
      [accountTransaction(transactionHash, false)],
      [transaction("override_vote")],
      voterId,
      6,
    )).toEqual({ latest: null, firstOverride: null });
  });

  it("includes successful calls from a previous controller with their signer", () => {
    const previousController = "former-member.testnet";
    expect(parseLatestMemberChange(
      [accountTransaction()],
      [transaction("override_vote", 6, previousController)],
      voterId,
      6,
    )).toEqual({
      latest: {
        method: "override_vote",
        signerId: previousController,
        vote: "Reject",
        txHash: transactionHash,
        timestampNs,
      },
      firstOverride: {
        method: "override_vote",
        signerId: previousController,
        vote: "Reject",
        txHash: transactionHash,
        timestampNs,
      },
    });
  });

  it("ignores calls received by a different account", () => {
    const otherReceiver = "other-voter.testnet";
    expect(parseLatestMemberChange(
      [accountTransaction()],
      [transaction("override_vote", 6, controller, transactionHash, "Reject", otherReceiver)],
      voterId,
      6,
    )).toEqual({ latest: null, firstOverride: null });
  });

  it("ignores calls for a different proposal", () => {
    expect(parseLatestMemberChange(
      [accountTransaction()],
      [transaction("override_vote", 5)],
      voterId,
      6,
    )).toEqual({ latest: null, firstOverride: null });
  });

  it("recognizes a return to the delegate's original choice after two overrides", () => {
    const votes: Array<"Approve" | "Reject"> = ["Reject", "Approve"];
    const changes = votes.map((vote, index) => {
      const hash = `override-${index}`;
      const time = (BigInt(timestampNs) + BigInt(index)).toString();
      return {
        summary: accountTransaction(hash, true, time),
        transaction: transaction("override_vote", 6, controller, hash, vote),
      };
    });
    const history = parseLatestMemberChange(
      changes.map((change) => change.summary),
      changes.map((change) => change.transaction),
      voterId,
      6,
    );

    expect(history.firstOverride?.vote).toBe("Reject");
    expect(history.latest?.vote).toBe("Approve");
    expect(originalDelegateVote(history.firstOverride)).toBe("Approve");
    expect(isCurrentVoteOverridden(history, history.latest?.vote ?? null, "pending")).toBe(false);
  });

  it("only treats a pending-sourced cast as overridden after a third override", () => {
    const votes: Array<"Approve" | "Reject"> = ["Reject", "Approve", "Reject"];
    const changes = votes.map((vote, index) => {
      const hash = `override-${index}`;
      const time = (BigInt(timestampNs) + BigInt(index)).toString();
      return {
        summary: accountTransaction(hash, true, time),
        transaction: transaction("override_vote", 6, controller, hash, vote),
      };
    });
    const history = parseLatestMemberChange(
      changes.map((change) => change.summary),
      changes.map((change) => change.transaction),
      voterId,
      6,
    );

    expect(history.firstOverride?.vote).toBe("Reject");
    expect(history.latest?.vote).toBe("Reject");
    expect(originalDelegateVote(history.firstOverride)).toBe("Approve");
    expect(isCurrentVoteOverridden(history, history.latest?.vote ?? null, "member")).toBe(false);
    expect(isCurrentVoteOverridden(history, history.latest?.vote ?? null, "pending")).toBe(true);
  });
});
