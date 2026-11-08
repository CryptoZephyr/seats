import { chainConfig } from "./config";
import type { ViewArgs, ViewResults } from "./types";

interface RpcResponse {
  result?: { result?: number[]; [key: string]: unknown };
  error?: { message?: string; data?: string };
}

export interface AccountInfo {
  amount: string;
  locked: string;
  storage_usage: number;
}

async function rpcRequest<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(chainConfig.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
  if (!response.ok) throw new Error(`Testnet RPC returned HTTP ${response.status}.`);
  const payload = await response.json() as { result?: T; error?: { message?: string; data?: string } };
  if (payload.error) throw new Error(payload.error.data ?? payload.error.message ?? `${method} failed.`);
  if (payload.result === undefined) throw new Error(`${method} returned no result.`);
  return payload.result;
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

  const payload = await rpcRequest<RpcResponse["result"]>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: encodeArgs(args),
  }).then((result) => ({ result }));
  if (!Array.isArray(payload.result?.result)) {
    throw new Error(`View ${methodName} returned no result bytes.`);
  }

  const decoded = new TextDecoder().decode(new Uint8Array(payload.result.result));
  return JSON.parse(decoded) as ViewResults[M];
}

export async function getAccountInfo(accountId: string): Promise<AccountInfo> {
  if (!accountId.endsWith(".testnet")) throw new Error("Account reads are restricted to NEAR testnet.");
  return rpcRequest<AccountInfo>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
}

export async function getGasPrice(): Promise<bigint> {
  const result = await rpcRequest<{ gas_price: string }>("gas_price", { block_id: null });
  return BigInt(result.gas_price);
}

export async function readSeatNftLevyBps(): Promise<number> {
  const result = await rpcRequest<{ values: Array<{ key: string; value: string }> }>("query", {
    request_type: "view_state",
    finality: "final",
    account_id: chainConfig.seatNftAccountId,
    prefix_base64: btoa("STATE"),
  });
  const row = result.values.find((item) => atob(item.key) === "STATE");
  if (!row) throw new Error("The seat contract levy could not be verified.");
  const bytes = Uint8Array.from(atob(row.value), (character) => character.charCodeAt(0));
  if (bytes.length < 38) throw new Error("The seat contract state is invalid.");
  const accountLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const levyOffset = 4 + accountLength + 32;
  if (levyOffset + 2 > bytes.length) throw new Error("The seat contract levy could not be decoded.");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(levyOffset, true);
}

export async function estimateVaultExecutionCost(resourceLimits: {
  max_execution_seconds: number;
  max_instructions: number;
  max_memory_mb: number;
}): Promise<string> {
  const result = await callViewRaw<unknown>(
    chainConfig.outlayerAccountId,
    "estimate_execution_cost",
    resourceLimits,
  );
  if (typeof result === "string" && /^\d+$/.test(result)) return result;
  if (typeof result === "object" && result !== null) {
    for (const key of ["total_cost", "cost", "execution_cost"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string" && /^\d+$/.test(value)) return value;
      if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    }
  }
  throw new Error("OutLayer returned an invalid execution cost estimate.");
}

export async function callViewRaw<T>(accountId: string, methodName: string, args: object): Promise<T> {
  if (!accountId.endsWith(".testnet")) throw new Error("Frontend reads are restricted to NEAR testnet accounts.");
  const result = await rpcRequest<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64: encodeArgs(args),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
}

export async function getTransactionStatus(txHash: string, signerId: string): Promise<unknown> {
  if (!signerId.endsWith(".testnet")) throw new Error("Transaction status is restricted to NEAR testnet.");
  return rpcRequest<unknown>("EXPERIMENTAL_tx_status", {
    tx_hash: txHash,
    sender_account_id: signerId,
    wait_until: "FINAL",
  });
}
