import { describe, expect, it } from "vitest";
import { parseRoute } from "./App";

describe("parseRoute", () => {
  it("routes public per-seat history", () => {
    expect(parseRoute("#/seat/4/history")).toEqual({
      route: "seat-history",
      tokenId: "4",
    });
  });
});
