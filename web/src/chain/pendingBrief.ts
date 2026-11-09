import {
  buildSetBriefRequest,
  type FunctionCallRequest,
  type FunctionCallResult,
} from "./transactions";

export interface BriefRelayResult {
  secrets_account_id: string;
  profile: string;
  brief_hash: string;
}

export interface PendingBriefSave {
  voterId: string;
  seatId: string;
  ownerAccountId: string;
  result: BriefRelayResult;
}

export type BriefStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type BriefCallContract = (request: FunctionCallRequest) => Promise<FunctionCallResult>;

const STORAGE_PREFIX = "seats:pending-brief:";
const ACTIVE_STORAGE_KEY = `${STORAGE_PREFIX}active`;

export function pendingBriefStorageKey(voterId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(voterId)}`;
}

export function pendingBriefSessionStorage(): BriefStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isBriefRelayResult(value: unknown): value is BriefRelayResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.secrets_account_id === "string"
    && typeof result.profile === "string"
    && typeof result.brief_hash === "string";
}

export function storePendingBriefSave(
  storage: BriefStorage | null,
  pending: PendingBriefSave,
): void {
  if (!storage) return;
  storage.setItem(pendingBriefStorageKey(pending.voterId), JSON.stringify(pending.result));
  storage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify({
    voterId: pending.voterId,
    seatId: pending.seatId,
    ownerAccountId: pending.ownerAccountId,
  }));
}

export function loadPendingBriefSave(
  storage: BriefStorage | null,
  ownerAccountId?: string | null,
): PendingBriefSave | null {
  if (!storage) return null;
  try {
    const active = JSON.parse(storage.getItem(ACTIVE_STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (
      !active
      || typeof active.voterId !== "string"
      || typeof active.seatId !== "string"
      || typeof active.ownerAccountId !== "string"
      || (ownerAccountId && active.ownerAccountId !== ownerAccountId)
    ) {
      return null;
    }
    const result = JSON.parse(storage.getItem(pendingBriefStorageKey(active.voterId)) ?? "null") as unknown;
    if (!isBriefRelayResult(result)) return null;
    return {
      voterId: active.voterId,
      seatId: active.seatId,
      ownerAccountId: active.ownerAccountId,
      result,
    };
  } catch {
    return null;
  }
}

export function clearPendingBriefSave(storage: BriefStorage | null, voterId: string): void {
  if (!storage) return;
  storage.removeItem(pendingBriefStorageKey(voterId));
  try {
    const active = JSON.parse(storage.getItem(ACTIVE_STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (active?.voterId === voterId) storage.removeItem(ACTIVE_STORAGE_KEY);
  } catch {
    storage.removeItem(ACTIVE_STORAGE_KEY);
  }
}

export async function submitPendingBriefSave(
  pending: PendingBriefSave,
  callContract: BriefCallContract,
  storage: BriefStorage | null,
): Promise<FunctionCallResult> {
  const request = buildSetBriefRequest(
    pending.voterId,
    pending.result.brief_hash,
    pending.result.secrets_account_id,
    pending.result.profile,
  );
  const result = await callContract(request);
  clearPendingBriefSave(storage, pending.voterId);
  return result;
}
