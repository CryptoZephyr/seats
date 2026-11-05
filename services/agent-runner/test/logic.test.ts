import { describe, expect, it } from "vitest";
import {
  deadlineHasPassed,
  hasResult,
  inProgressProposals,
  proposalsAfterCursor,
  shouldRequestVote,
} from "../src/logic.js";

describe("proposal selection", () => {
  it("selects only proposals newer than the cursor, sorted by id", () => {
    const proposals = [
      { id: 4, status: "InProgress" },
      { id: 2, status: "Approved" },
      { id: 3, status: "InProgress" },
      { id: 8, status: "InProgress" },
    ];
    expect(proposalsAfterCursor(proposals, 2, 5).map(({ id }) => id)).toEqual([3, 4]);
  });

  it("selects only in-progress proposals", () => {
    expect(inProgressProposals([
      { id: 1, status: "InProgress" },
      { id: 2, status: "Approved" },
    ]).map(({ id }) => id)).toEqual([1]);
  });
});

describe("request and deadline rules", () => {
  const results = { results: [{ proposal_id: 7 }] };

  it("skips a proposal that already has a result", () => {
    expect(hasResult(results, 7)).toBe(true);
    expect(shouldRequestVote(null, results, 7)).toBe(false);
  });

  it("skips a proposal with a pending vote", () => {
    expect(shouldRequestVote({ deadline: "1000", casting: false }, { results: [] }, 7)).toBe(false);
  });

  it("requests a proposal with neither a pending vote nor a result", () => {
    expect(shouldRequestVote(null, { results: [] }, 7)).toBe(true);
  });

  it("casts only after the deadline and while not already casting", () => {
    expect(deadlineHasPassed({ deadline: "1000", casting: false }, 1000n)).toBe(true);
    expect(deadlineHasPassed({ deadline: "1001", casting: false }, 1000n)).toBe(false);
    expect(deadlineHasPassed({ deadline: "999", casting: true }, 1000n)).toBe(false);
  });
});
