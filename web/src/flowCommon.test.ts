import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const rpc = vi.hoisted(() => ({
  getAccountInfo: vi.fn(),
  getGasPrice: vi.fn(),
}));

vi.mock("./chain/rpc", () => rpc);

import {
  canAffordRequest,
  checkFunds,
  FaucetLink,
  friendly,
  InsufficientFundsError,
  isInsufficientFundsError,
  requiredWalletBalance,
  TESTNET_FAUCET_URL,
} from "./flowCommon";

describe("friendly", () => {
  const walletConfirmMessage = "The wallet didn't confirm the result. Check the transaction before trying again.";

  it("preserves insufficient-funds messages that mention the network fee", () => {
    const message = "This account needs 4.5 NEAR for the deposit and about 0.01 testnet NEAR for the network fee.";
    expect(friendly(new InsufficientFundsError(message))).toBe(message);
  });

  it("doesn't treat ordinary network wording as a wallet error", () => {
    expect(friendly(new Error("This needs a network fee"))).toBe("This needs a network fee");
  });

  it("maps wallet balance errors to the low-balance message and faucet path", () => {
    const error = new Error("Account has 4.74 NEAR but needs 4.81 NEAR to complete the request.");

    expect(friendly(error)).toBe("You need at least 4.81 NEAR in your wallet.");
    expect(isInsufficientFundsError(error)).toBe(true);
  });

  it("uses the wallet confirmation message for timeouts and failed fetches", () => {
    expect(friendly(new Error("Request timed out"))).toBe(walletConfirmMessage);
    expect(friendly(new TypeError("Failed to fetch"))).toBe(walletConfirmMessage);
  });

  it("prefers a contract error code to the network error message", () => {
    expect(friendly(new Error("network error: ERR_NO_SEAT"))).toBe(
      "This account no longer holds the required seat.",
    );
  });
});

describe("checkFunds", () => {
  beforeEach(() => {
    rpc.getAccountInfo.mockReset();
    rpc.getGasPrice.mockReset();
    rpc.getGasPrice.mockResolvedValue(0n);
  });

  it("subtracts the storage reserve from the account balance", async () => {
    rpc.getAccountInfo.mockResolvedValueOnce({
      amount: "1000000000000000000000000",
      storage_usage: 100,
    }).mockResolvedValueOnce({
      amount: "1000000000000000000000000",
      storage_usage: 0,
    });
    await expect(checkFunds("member.testnet", {
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      args: {},
      gas: 0n,
      deposit: 989000000000000000000001n,
    })).resolves.toBe(false);
    await expect(checkFunds("member.testnet", {
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      args: {},
      gas: 0n,
      deposit: 989000000000000000000001n,
    })).resolves.toBe(true);
  });

  it("requires the deposit, 0.001 NEAR per Tgas, and a 0.01 NEAR margin", () => {
    const request = {
      receiverId: "seat-nft.testnet",
      methodName: "claim_seat",
      args: {},
      gas: 300_000_000_000_000n,
      deposit: 4_500_000_000_000_000_000_000_000n,
    };

    expect(requiredWalletBalance(request)).toBe(4_810_000_000_000_000_000_000_000n);
  });

  it("blocks the request below the required balance", () => {
    const request = {
      receiverId: "seat-nft.testnet",
      methodName: "claim_seat",
      args: {},
      gas: 300_000_000_000_000n,
      deposit: 4_500_000_000_000_000_000_000_000n,
    };
    const required = requiredWalletBalance(request);

    expect(canAffordRequest(required - 1n, request)).toBe(false);
    expect(canAffordRequest(required, request)).toBe(true);
  });
});

describe("faucet link", () => {
  it("renders a link to the NEAR testnet faucet", () => {
    const markup = renderToStaticMarkup(createElement(FaucetLink));

    expect(markup).toContain(`href="${TESTNET_FAUCET_URL}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain("Get testnet NEAR from the faucet");
  });

  it("identifies insufficient-funds errors", () => {
    expect(isInsufficientFundsError(new InsufficientFundsError("Insufficient funds"))).toBe(true);
    expect(isInsufficientFundsError(new Error("Other error"))).toBe(false);
  });
});
