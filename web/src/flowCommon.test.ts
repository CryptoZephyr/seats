import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  getAccountInfo: vi.fn(),
  getGasPrice: vi.fn(),
}));

vi.mock("./chain/rpc", () => rpc);

import { checkFunds } from "./flowCommon";

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
      deposit: 999000000000000000000001n,
    })).resolves.toBe(false);
    await expect(checkFunds("member.testnet", {
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      args: {},
      gas: 0n,
      deposit: 999000000000000000000001n,
    })).resolves.toBe(true);
  });
});
