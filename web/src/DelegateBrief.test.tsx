import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storePendingBriefSave, type BriefStorage, type PendingBriefSave } from "./chain/pendingBrief";

const mocks = vi.hoisted(() => ({
  state: {} as {
    status: "error";
    error: Error;
    retry: () => void;
    refresh: () => Promise<void>;
  },
  viewer: {} as {
    accountId: string | null;
    seatIds: string[];
    isSeatHolder: boolean;
    isVoterController: boolean;
    isLoading: boolean;
    walletReady: boolean;
    error: Error | null;
    retry: () => void;
    callVoter: () => void;
    callContract: ReturnType<typeof vi.fn>;
    signMessage: () => void;
  },
}));

vi.mock("./chain/useClubData", () => ({
  useClubData: () => mocks.state,
}));

vi.mock("./chain/WalletProvider", () => ({
  useViewer: () => mocks.viewer,
}));

vi.mock("./flowCommon", () => ({
  friendly: (error: unknown) => error instanceof Error ? error.message : "Request failed.",
  useGasEstimate: () => "0.001",
}));

import { DelegateBrief } from "./screens";

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

describe("DelegateBrief pending save recovery", () => {
  beforeEach(() => {
    const storage = memoryStorage();
    storePendingBriefSave(storage, pending);
    vi.stubGlobal("sessionStorage", storage);
    mocks.state = {
      status: "error",
      error: new Error("Failed to fetch"),
      retry: vi.fn(),
      refresh: vi.fn().mockRejectedValue(new Error("Failed to fetch")),
    };
    mocks.viewer = {
      accountId: "holder.testnet",
      seatIds: ["1"],
      isSeatHolder: true,
      isVoterController: false,
      isLoading: false,
      walletReady: true,
      error: null,
      retry: vi.fn(),
      callVoter: vi.fn(),
      callContract: vi.fn(),
      signMessage: vi.fn(),
    };
  });

  it("keeps the fingerprint button visible with an inline retry when reads fail", () => {
    const markup = renderToStaticMarkup(<DelegateBrief />);
    const remountedMarkup = renderToStaticMarkup(<DelegateBrief />);

    expect(markup).toContain("Save fingerprint on-chain");
    expect(remountedMarkup).toContain("Save fingerprint on-chain");
    expect(markup).toContain("Failed to fetch");
    expect(markup).toContain("Try again");
    expect(mocks.viewer.callContract).not.toHaveBeenCalled();
  });
});
