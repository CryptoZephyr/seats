import { useCallback, useEffect, useState } from "react";
import { loadClubSnapshot, type ClubSnapshot } from "./club";

type State =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; data: ClubSnapshot };

export function useClubData() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const refresh = useCallback(async () => {
    const data = await loadClubSnapshot();
    setState({ status: "ready", data });
  }, []);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    loadClubSnapshot()
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
    };
  }, [attempt]);

  return { ...state, retry, refresh };
}
