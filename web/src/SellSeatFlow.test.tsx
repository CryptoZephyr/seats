import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainConfig } from "./chain/config";

const mocks = vi.hoisted(() => ({
  state: undefined as unknown,
  viewer: undefined as unknown,
}));

vi.mock("./chain/useClubData", () => ({
  useClubData: () => mocks.state as never,
}));

vi.mock("./chain/WalletProvider", () => ({
  useViewer: () => mocks.viewer as never,
}));

vi.mock("./flowCommon", async () => {
  const actual = await vi.importActual<typeof import("./flowCommon")>("./flowCommon");
  return { ...actual, useGasEstimate: () => "0.001" };
});

import { SellSeatFlow } from "./SellSeatFlow";

describe("SellSeatFlow", () => {
  beforeEach(() => {
    const args = btoa(JSON.stringify({
      token_id: "7",
      buyer: "buyer.testnet",
      price: "1000000000000000000000000",
    }));
    mocks.state = {
      status: "ready",
      data: {
        seats: [{
          token: { token_id: "7", owner_id: "seller.testnet" },
          record: { approval: null },
        }],
        proposals: [{
          id: 33,
          proposer: "seller.testnet",
          description: "Sell Seat 7 to buyer.testnet",
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
        }],
        proposalPeriodNs: "100",
        proposalBond: "100000000000000000000000",
      },
      retry: vi.fn(),
    };
    mocks.viewer = {
      accountId: "seller.testnet",
      seatIds: ["7"],
      error: null,
      isLoading: false,
      callContract: vi.fn(),
      retry: vi.fn(),
    };
  });

  it("shows the offer form when the seat's only sale proposal has expired", () => {
    const markup = renderToStaticMarkup(<SellSeatFlow />);

    expect(markup).toContain("Buyer&#x27;s .testnet account");
    expect(markup).toContain("Price in NEAR");
    expect(markup).toContain("Submit sale for club vote");
    expect(markup).not.toContain("A sale offer for this seat is already in the club vote.");
  });
});
