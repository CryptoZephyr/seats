import { describe, expect, it, vi } from "vitest";
import { PendingBriefSaveButton } from "../PendingBriefSaveButton";
import {
  loadPendingBriefSave,
  pendingBriefStorageKey,
  storePendingBriefSave,
  submitPendingBriefSave,
  type BriefStorage,
  type PendingBriefSave,
} from "./pendingBrief";

function memoryStorage(): BriefStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const pending: PendingBriefSave = {
  voterId: "s1.seatsnft3-1793848334.testnet",
  seatId: "1",
  ownerAccountId: "holder.testnet",
  result: {
    secrets_account_id: "secrets.testnet",
    profile: `s1-${"ab".repeat(8)}`,
    brief_hash: "cd".repeat(32),
  },
};

describe("pending brief saves", () => {
  it("restores the relay result from session storage after a remount", () => {
    const storage = memoryStorage();
    storePendingBriefSave(storage, pending);

    expect(storage.getItem(pendingBriefStorageKey(pending.voterId))).toBe(JSON.stringify(pending.result));
    expect(loadPendingBriefSave(storage, pending.ownerAccountId)).toEqual(pending);
  });

  it("doesn't call the wallet until the save button is clicked", async () => {
    const storage = memoryStorage();
    storePendingBriefSave(storage, pending);
    const callContract = vi.fn().mockResolvedValue({ hash: "transaction" });
    const onClick = () => submitPendingBriefSave(pending, callContract, storage);
    const button = PendingBriefSaveButton({ onClick, disabled: false });

    expect(callContract).not.toHaveBeenCalled();
    expect(button.props.children).toBe("Save fingerprint on-chain");
    await button.props.onClick();

    expect(callContract).toHaveBeenCalledOnce();
  });

  it("clears the pending result only after the on-chain save succeeds", async () => {
    const storage = memoryStorage();
    storePendingBriefSave(storage, pending);
    const callContract = vi.fn().mockResolvedValue({ hash: "transaction" });

    await submitPendingBriefSave(pending, callContract, storage);

    expect(loadPendingBriefSave(storage, pending.ownerAccountId)).toBeNull();
  });

  it("keeps the pending result when the wallet call fails", async () => {
    const storage = memoryStorage();
    storePendingBriefSave(storage, pending);
    const callContract = vi.fn().mockRejectedValue(new Error("Wallet rejected"));

    await expect(submitPendingBriefSave(pending, callContract, storage)).rejects.toThrow("Wallet rejected");

    expect(loadPendingBriefSave(storage, pending.ownerAccountId)).toEqual(pending);
  });
});
