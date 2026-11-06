import { chainConfig } from "./config";
import type { ViewArgs, ViewResults } from "./types";

interface RpcResponse {
  result?: { result?: number[] };
  error?: { message?: string; data?: string };
}

function encodeArgs(args: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function callView<M extends keyof ViewArgs>(
  accountId: string,
  methodName: M,
  args: ViewArgs[M],
): Promise<ViewResults[M]> {
  if (!accountId.endsWith(".testnet")) {
    throw new Error("Frontend reads are restricted to NEAR testnet accounts.");
  }

  const response = await fetch(chainConfig.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: methodName,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: encodeArgs(args),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Testnet RPC returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as RpcResponse;
  if (payload.error) {
    throw new Error(payload.error.data ?? payload.error.message ?? `View ${methodName} failed.`);
  }
  if (!Array.isArray(payload.result?.result)) {
    throw new Error(`View ${methodName} returned no result bytes.`);
  }

  const decoded = new TextDecoder().decode(new Uint8Array(payload.result.result));
  return JSON.parse(decoded) as ViewResults[M];
}
