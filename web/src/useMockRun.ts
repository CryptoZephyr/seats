import { useCallback, useEffect, useRef, useState } from "react";

export type RunState = "idle" | "loading" | "success" | "error";

export function useMockRun({ ms = 1600, fail = false }: { ms?: number; fail?: boolean } = {}) {
  const [state, setState] = useState<RunState>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const start = useCallback(() => {
    window.clearTimeout(timer.current);
    setState("loading");
    timer.current = window.setTimeout(() => setState(fail ? "error" : "success"), ms);
  }, [ms, fail]);

  const reset = useCallback(() => setState("idle"), []);

  return { state, start, reset };
}
