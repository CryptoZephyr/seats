import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshClubSnapshot, retryInitialLoad } from "./useClubData";

afterEach(() => {
  vi.useRealTimers();
});

describe("retryInitialLoad", () => {
  it("retries after the configured delays and resolves on the third load", async () => {
    vi.useFakeTimers();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"))
      .mockResolvedValueOnce("snapshot");
    const result = retryInitialLoad(load);

    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(result).resolves.toBe("snapshot");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("rejects after the initial load and two retries fail", async () => {
    vi.useFakeTimers();
    const failure = new Error("last failure");
    const load = vi.fn().mockRejectedValue(failure);
    const result = retryInitialLoad(load);
    const rejected = expect(result).rejects.toBe(failure);

    await vi.runAllTimersAsync();

    await rejected;
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe("refreshClubSnapshot", () => {
  it("doesn't replace the last good data when a refresh fails", async () => {
    const lastGood = { value: "ready" };
    let displayed = lastGood;
    const commit = vi.fn((data: typeof lastGood) => {
      displayed = data;
    });

    await expect(refreshClubSnapshot(
      async () => { throw new Error("refresh failed"); },
      commit,
    )).rejects.toThrow("refresh failed");

    expect(displayed).toBe(lastGood);
    expect(commit).not.toHaveBeenCalled();
  });
});
