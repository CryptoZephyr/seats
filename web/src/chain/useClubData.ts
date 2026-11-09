import { useCallback, useEffect, useState } from "react";
import { loadClubSnapshot, type ClubSnapshot } from "./club";

export const INITIAL_LOAD_RETRY_DELAYS_MS = [3_000, 8_000] as const;

type State =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; data: ClubSnapshot };

export async function retryInitialLoad<T>(
  load: () => Promise<T>,
  retryDelays: readonly number[] = INITIAL_LOAD_RETRY_DELAYS_MS,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (attempt >= retryDelays.length) throw error;
      await wait(retryDelays[attempt]);
    }
  }
}

export async function refreshClubSnapshot<T>(
  load: () => Promise<T>,
  commit: (data: T) => void,
): Promise<T> {
  const data = await load();
  commit(data);
  return data;
}

export function useClubData() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const refresh = useCallback(() =>
    refreshClubSnapshot(loadClubSnapshot, (data) => setState({ status: "ready", data })),
  []);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    setState({ status: "loading" });
    const wait = (milliseconds: number) => new Promise<void>((resolve, reject) => {
      if (!active) {
        reject(new Error("Snapshot load was cancelled."));
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        resolve();
      }, milliseconds);
    });
    retryInitialLoad(loadClubSnapshot, INITIAL_LOAD_RETRY_DELAYS_MS, wait)
      .then((data) => {
        if (active) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "error",
            error: error instanceof Error ? error : new Error("Testnet views could not be loaded."),
          });
        }
      });
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [attempt]);

  return { ...state, retry, refresh };
}
