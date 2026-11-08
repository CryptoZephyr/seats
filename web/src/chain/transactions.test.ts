import { describe, expect, it } from "vitest";
import { contractErrorCode, explorerTxUrl, friendlyVoteError } from "./transactions";

describe("contractErrorCode", () => {
  it("extracts a code from a realistic Wallet Selector error message", () => {
    const error = new Error(
      'FunctionCallError ExecutionError "Smart contract panicked: ERR_WINDOW_CLOSED"',
    );

    expect(contractErrorCode(error)).toBe("ERR_WINDOW_CLOSED");
  });

  it("extracts a code from a final execution failure", () => {
    const outcome = {
      status: {
        Failure: {
          ActionError: {
            kind: {
              FunctionCallError: {
                ExecutionError: "Smart contract panicked: ERR_NOT_CONTROLLER",
              },
            },
          },
        },
      },
    };

    expect(contractErrorCode(outcome)).toBe("ERR_NOT_CONTROLLER");
  });

  it("returns null when there is no contract error code", () => {
    expect(contractErrorCode(new Error("The wallet request timed out."))).toBeNull();
  });
});

describe("friendlyVoteError", () => {
  it.each([
    ["ERR_NOT_CONTROLLER", "This account doesn't control this seat."],
    ["ERR_NO_PENDING", "This vote is no longer waiting to be sent."],
    ["ERR_WINDOW_CLOSED", "The time to change this vote has passed."],
    ["ERR_CASTING", "Your delegate's vote is already being sent."],
    ["ERR_INVALID_VOTE", "That vote choice isn't allowed."],
  ])("maps %s to member-facing copy", (code, message) => {
    expect(friendlyVoteError(code)).toBe(message);
  });

  it("includes unknown contract codes in the fallback copy", () => {
    expect(friendlyVoteError("ERR_OTHER")).toContain("ERR_OTHER");
  });
});

describe("explorerTxUrl", () => {
  it("links to the NEAR testnet explorer", () => {
    expect(explorerTxUrl("tx-hash")).toBe("https://testnet.nearblocks.io/txns/tx-hash");
  });
});
