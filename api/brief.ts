import type { IncomingMessage, ServerResponse } from "node:http";
import { createBriefRelayFromEnv } from "../services/agent-runner/src/briefRelayFactory.js";
import { credentialFromPrivateKey, NearAgentRpc } from "../services/agent-runner/src/rpc.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const ownerAccountId = required("BRIEF_OWNER_ACCOUNT_ID");
const seatNftId = required("SEAT_NFT_ID");
if (!ownerAccountId.endsWith(".testnet") || !seatNftId.endsWith(".testnet")) {
  throw new Error("Brief relay accounts must be on testnet");
}

function assertTestnetRpcUrl(value: string): string {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error("Brief relay RPC URL must be valid");
  }
  if (!hostname.includes("testnet") && hostname !== "test.rpc.fastnear.com") {
    throw new Error("Brief relay RPC URL must point to testnet");
  }
  return value;
}

const ownerCredential = credentialFromPrivateKey(ownerAccountId, required("BRIEF_OWNER_PRIVATE_KEY"));
const rpcUrls = [
  assertTestnetRpcUrl(required("NEAR_RPC_URL")),
  ...(process.env.NEAR_RPC_FALLBACK_URLS ?? "https://test.rpc.fastnear.com,https://rpc.testnet.near.org")
    .split(",").map((url) => url.trim()).filter(Boolean).map(assertTestnetRpcUrl),
];
const rpc = new NearAgentRpc([...new Set(rpcUrls)], ownerCredential, [ownerCredential]);
const handler = createBriefRelayFromEnv(process.env, rpc, { allowSameOrigin: true });

export default function brief(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return handler(request, response);
}
