import { describe, expect, it } from "vitest";
import { saleListings } from "./sales";
import { chainConfig } from "./config";

describe("sale proposal parsing", () => {
  it("recognizes the new sale description and approve_sale arguments", () => {
    const args = btoa(JSON.stringify({
      token_id: "3",
      buyer: "buyer.testnet",
      price: "1000000000000000000000000",
      expires_in_ns: 86_400_000_000_000,
    }));
    const proposals = [{
      id: 17,
      proposer: "seller.testnet",
      description: "Seat sale: token 3, buyer buyer.testnet, price 1000000000000000000000000",
      kind: {
        FunctionCall: {
          receiver_id: chainConfig.seatNftAccountId,
          actions: [{ method_name: "approve_sale", args, deposit: "0", gas: "10000000000000" }],
        },
      },
      status: "InProgress",
      vote_counts: {},
      votes: {},
      submission_time: "1000",
    }] as never;
    expect(saleListings(proposals)).toMatchObject([{
      seatId: "3",
      buyerId: "buyer.testnet",
      price: "1000000000000000000000000",
    }]);
  });
});
