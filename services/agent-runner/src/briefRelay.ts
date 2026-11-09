import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PublicKey } from "@near-js/crypto";

const BRIEF_SIGN_TAG = 2_147_484_061;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_BRIEF_CHARS = 4_000;
const NONCE_TTL_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60 * 60_000;
const MIN_OWNER_BALANCE = 200_000_000_000_000_000_000_000n;

export interface BriefRelayRpc {
  isFullAccessKey(accountId: string, publicKey: string): Promise<boolean>;
  getTokenOwner(tokenId: string): Promise<string | null>;
  getSeatVoterId(tokenId: string): Promise<string | null>;
  getVoterController(voterId: string): Promise<string | null>;
  getAccountInfo(accountId: string): Promise<{ amount: string; storageUsage: number }>;
  getAgentWasmSha256(): Promise<string>;
  profileExists(ownerId: string, profile: string, agentWasmSha256: string): Promise<boolean>;
  storeProfile(profile: string, secretsJson: string, agentWasmSha256: string): Promise<string>;
}

interface BriefRequest {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
  brief: string;
  salt: string;
}

export interface BriefRelayOptions {
  rpc: BriefRelayRpc;
  apiKey: string;
  ownerAccountId: string;
  recipient?: string;
  webOrigins?: string;
  allowSameOrigin?: boolean;
  now?: () => number;
}

function borshU32(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value);
  return output;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([borshU32(bytes.length), bytes]);
}

export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Buffer {
  if (nonce.length !== 32) throw new Error("Invalid NEP-413 nonce");
  const payload = Buffer.concat([
    borshString(message),
    Buffer.from(nonce),
    borshString(recipient),
    Buffer.from([0]),
  ]);
  return createHash("sha256").update(borshU32(BRIEF_SIGN_TAG)).update(payload).digest();
}

export function briefHash(salt: string, brief: string): string {
  return createHash("sha256").update(salt, "utf8").update(brief, "utf8").digest("hex");
}

export function briefProfileName(tokenId: string, hash: string): string {
  if (!/^\d+$/.test(tokenId) || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("Invalid brief profile identity");
  }
  return `s${tokenId}-${hash.slice(0, 16)}`;
}

function parseRequest(value: unknown): BriefRequest | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const fields = ["account_id", "public_key", "signature", "nonce", "message", "brief", "salt"];
  if (fields.some((field) => typeof row[field] !== "string")) return null;
  return row as unknown as BriefRequest;
}

function sendJson(response: ServerResponse, status: number, value: object): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES && !tooLarge) {
        tooLarge = true;
        chunks.length = 0;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => tooLarge
      ? reject(new Error("BODY_TOO_LARGE"))
      : resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function validateMessage(message: string): { tokenId: string; hash: string; issuedAt: number } | null {
  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    if (
      value.action !== "seats-save-brief"
      || typeof value.token_id !== "string"
      || !/^\d+$/.test(value.token_id)
      || typeof value.brief_hash !== "string"
      || !/^[0-9a-f]{64}$/.test(value.brief_hash)
      || !Number.isSafeInteger(value.issued_at)
    ) return null;
    const issuedAt = value.issued_at as number;
    const canonical = JSON.stringify({
      action: "seats-save-brief",
      token_id: value.token_id,
      brief_hash: value.brief_hash,
      issued_at: issuedAt,
    });
    if (canonical !== message) return null;
    return { tokenId: value.token_id, hash: value.brief_hash, issuedAt };
  } catch {
    return null;
  }
}

export function createBriefHandler(options: BriefRelayOptions) {
  const recipient = options.recipient?.trim() || "seats-agent-runner";
  const allowedOrigins = new Set(
    (options.webOrigins ?? "http://127.0.0.1:5199,http://localhost:5199")
      .split(",").map((origin) => origin.trim()).filter(Boolean),
  );
  const usedNonces = new Map<string, number>();
  const accountRates = new Map<string, number[]>();
  const globalRates: number[] = [];
  const now = options.now ?? Date.now;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const origin = request.headers.origin;
    const sameOrigin = options.allowSameOrigin
      && typeof origin === "string"
      && typeof request.headers.host === "string"
      && origin === `https://${request.headers.host}`;
    const originAllowed = typeof origin === "string" && (allowedOrigins.has(origin) || sameOrigin);
    if (originAllowed) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-methods", "POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(origin && !originAllowed ? 403 : 204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      sendJson(response, 413, { error: "BODY_TOO_LARGE" });
      return;
    }
    let body: BriefRequest | null;
    try {
      body = parseRequest(JSON.parse((await readBody(request)).toString("utf8")));
    } catch (error) {
      sendJson(response, error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400, {
        error: error instanceof Error && error.message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON",
      });
      return;
    }
    if (!body || !/^[a-z0-9._-]+\.testnet$/.test(body.account_id)) {
      sendJson(response, 400, { error: "INVALID_REQUEST" });
      return;
    }
    const message = validateMessage(body.message);
    if (!message) {
      sendJson(response, 400, { error: "INVALID_MESSAGE" });
      return;
    }
    if (message.issuedAt > now() || now() - message.issuedAt > 5 * 60_000) {
      sendJson(response, 400, { error: "MESSAGE_EXPIRED" });
      return;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(body.salt)) {
      sendJson(response, 400, { error: "INVALID_SALT" });
      return;
    }
    if (!body.brief.trim() || body.brief.length > MAX_BRIEF_CHARS) {
      sendJson(response, 400, { error: "INVALID_BRIEF" });
      return;
    }
    if (briefHash(body.salt, body.brief) !== message.hash) {
      sendJson(response, 400, { error: "BRIEF_HASH_MISMATCH" });
      return;
    }
    let nonce: Buffer;
    try {
      nonce = Buffer.from(body.nonce, "base64");
      if (nonce.length !== 32 || nonce.toString("base64") !== body.nonce) throw new Error();
    } catch {
      sendJson(response, 400, { error: "INVALID_NONCE" });
      return;
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(body.signature, "base64");
      if (signature.length !== 64 || signature.toString("base64") !== body.signature) throw new Error();
      const key = PublicKey.fromString(body.public_key);
      if (key.keyType !== 0 || !key.verify(nep413Hash(body.message, nonce, recipient), signature)) {
        throw new Error();
      }
    } catch {
      sendJson(response, 401, { error: "INVALID_SIGNATURE" });
      return;
    }
    const time = now();
    for (const [key, expiresAt] of usedNonces) if (expiresAt <= time) usedNonces.delete(key);
    const nonceKey = body.nonce;
    if (usedNonces.has(nonceKey)) {
      sendJson(response, 409, { error: "NONCE_REUSED" });
      return;
    }
    for (const [accountId, times] of accountRates) {
      const recent = times.filter((at) => at > time - RATE_WINDOW_MS);
      if (recent.length === 0) accountRates.delete(accountId);
      else accountRates.set(accountId, recent);
    }
    const accountTimes = accountRates.get(body.account_id) ?? [];
    const recentGlobal = globalRates.filter((at) => at > time - RATE_WINDOW_MS);
    if (accountTimes.length >= 5 || recentGlobal.length >= 30) {
      sendJson(response, 429, { error: "RATE_LIMITED" });
      return;
    }
    usedNonces.set(nonceKey, time + NONCE_TTL_MS);
    accountRates.set(body.account_id, [...accountTimes, time]);
    globalRates.splice(0, globalRates.length, ...recentGlobal, time);
    try {
      if (!await options.rpc.isFullAccessKey(body.account_id, body.public_key)) {
        sendJson(response, 403, { error: "FULL_ACCESS_REQUIRED" });
        return;
      }
      if (await options.rpc.getTokenOwner(message.tokenId) !== body.account_id) {
        sendJson(response, 403, { error: "NOT_TOKEN_OWNER" });
        return;
      }
      const voterId = await options.rpc.getSeatVoterId(message.tokenId);
      if (!voterId || await options.rpc.getVoterController(voterId) !== body.account_id) {
        sendJson(response, 403, { error: "NOT_VOTER_CONTROLLER" });
        return;
      }
      const profile = briefProfileName(message.tokenId, message.hash);
      const agentWasmSha256 = await options.rpc.getAgentWasmSha256();
      if (await options.rpc.profileExists(options.ownerAccountId, profile, agentWasmSha256)) {
        sendJson(response, 200, {
          secrets_account_id: options.ownerAccountId,
          profile,
          brief_hash: message.hash,
          already_stored: true,
        });
        return;
      }
      const owner = await options.rpc.getAccountInfo(options.ownerAccountId);
      const spendableBalance = BigInt(owner.amount) - BigInt(owner.storageUsage) * 10n ** 19n;
      if (spendableBalance < MIN_OWNER_BALANCE) {
        sendJson(response, 503, { error: "BRIEF_OWNER_LOW_BALANCE" });
        return;
      }
      const secretsJson = JSON.stringify({
        BRIEF: body.brief,
        SALT: body.salt,
        NEAR_AI_API_KEY: options.apiKey,
      });
      const txHash = await options.rpc.storeProfile(profile, secretsJson, agentWasmSha256);
      sendJson(response, 200, {
        secrets_account_id: options.ownerAccountId,
        profile,
        brief_hash: message.hash,
        tx_hash: txHash,
      });
    } catch {
      sendJson(response, 500, { error: "PROFILE_STORE_FAILED" });
    }
  };
}
