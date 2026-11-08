import { describe, expect, it } from "vitest";
import { canChangePendingVote } from "./voteControls";

describe("canChangePendingVote", () => {
  it("allows the seat controller to change an open pending vote", () => {
    expect(canChangePendingVote({ kind: "pending" }, "member.testnet", "member.testnet")).toBe(true);
  });

  it.each(["casting", "retry", "windowClosed"])(
    "hides controls for the %s sublabel",
    (sublabel) => {
      expect(canChangePendingVote(
        { kind: "pending", sublabel },
        "member.testnet",
        "member.testnet",
      )).toBe(false);
    },
  );

  it("hides controls from non-controllers and signed-out viewers", () => {
    expect(canChangePendingVote({ kind: "pending" }, "controller.testnet", "member.testnet")).toBe(false);
    expect(canChangePendingVote({ kind: "pending" }, "controller.testnet", null)).toBe(false);
  });

  it("hides controls outside a pending state", () => {
    expect(canChangePendingVote({ kind: "cast" }, "member.testnet", "member.testnet")).toBe(false);
  });
});
