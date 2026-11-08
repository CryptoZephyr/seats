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
  it("records the claim result before awaiting a membership refresh", async () => {
    const events: string[] = [];
    const setResult = vi.fn(() => events.push("result"));
    let finishRefresh: () => void = () => undefined;
    const refreshMembership = vi.fn(() => {
      events.push("refresh");
      return new Promise<void>((resolve) => { finishRefresh = resolve; });
    });

    const completion = recordSuccessfulAction("claim", "claim-transaction", setResult, refreshMembership);

    expect(events).toEqual(["result", "refresh"]);
    expect(setResult).toHaveBeenCalledWith({ hash: "claim-transaction", action: "claim" });
    expect(refreshMembership).toHaveBeenCalledOnce();
    let finished = false;
    void completion.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    finishRefresh();
    await completion;
    expect(finished).toBe(true);
  });
});
