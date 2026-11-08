import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainConfig } from "./config";
import { loadClubSnapshot } from "./club";

const { callViewMock } = vi.hoisted(() => ({ callViewMock: vi.fn() }));

vi.mock("./rpc", () => ({ callView: callViewMock }));

describe("loadClubSnapshot", () => {
  beforeEach(() => {
    callViewMock.mockReset();
    callViewMock.mockImplementation(async (_accountId: string, methodName: string) => {
      switch (methodName) {
        case "nft_metadata":
          return {};
        case "nft_tokens":
          return [{
            token_id: "4",
            owner_id: "member.testnet",
            metadata: null,
            approved_account_ids: {},
          }];
        case "get_config":
          return { name: "Club", purpose: "", metadata: "" };
        case "get_policy":
          return { proposal_period: "1000", proposal_bond: "0" };
        case "get_last_proposal_id":
          return 3;
        case "get_proposals":
          return [
            { id: 0, status: "InProgress" },
            { id: 1, status: "Approved" },
            { id: 2, status: "Expired" },
          ];
        case "get_seat":
          return { voter_id: "s4.seatsnft3-1793848334.testnet", approval: null };
        case "get_controller":
          return "member.testnet";
        case "get_dao":
          return chainConfig.daoAccountId;
        case "get_brief_hash":
          return "";
        case "get_results":
          return { results: [], storage_usage_bytes: 0 };
        case "get_pending":
          return null;
        default:
          throw new Error(`Unexpected view ${methodName}`);
      }
    });
  });

  it("reads pending votes only for in-progress proposals", async () => {
    await loadClubSnapshot();

    const pendingCalls = callViewMock.mock.calls
      .filter(([, methodName]) => methodName === "get_pending")
      .map(([, , args]) => args.proposal_id);

    expect(pendingCalls).toEqual([0]);
  });
});
