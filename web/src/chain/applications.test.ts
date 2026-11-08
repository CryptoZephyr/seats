import { describe, expect, it, vi } from "vitest";
import { findApplication, recordSuccessfulAction } from "../ApplyClaimPage";
import { chainConfig } from "./config";

const args = (value: object) => btoa(JSON.stringify(value));

describe("application proposal matching", () => {
  it("ignores a spoofed description and matches the approve_application applicant", () => {
    const proposals = [
      {
        id: 2,
        description: "Apply for a seat for visitor.testnet",
        kind: { ChangeConfig: { config: {} } },
      },
      {
        id: 3,
        description: "Apply for a seat for someone-else.testnet",
        kind: { FunctionCall: {
          receiver_id: chainConfig.seatNftAccountId,
          actions: [{ method_name: "approve_application", args: args({ applicant: "someone-else.testnet" }) }],
        } },
      },
      {
        id: 4,
        description: "Unrelated description",
        kind: { FunctionCall: {
          receiver_id: chainConfig.seatNftAccountId,
          actions: [{ method_name: "approve_application", args: args({ applicant: "visitor.testnet" }) }],
        } },
      },
    ] as never;
    expect(findApplication(proposals, "visitor.testnet")?.id).toBe(4);
  });
});

describe("claim success", () => {
  it("refreshes viewer membership after recording the claim result", () => {
    const setResult = vi.fn();
    const retryViewer = vi.fn();

    recordSuccessfulAction("claim", "claim-transaction", setResult, retryViewer);

    expect(setResult).toHaveBeenCalledWith({ hash: "claim-transaction", action: "claim" });
    expect(retryViewer).toHaveBeenCalledOnce();
  });
});
