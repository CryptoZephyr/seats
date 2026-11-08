export function buildBriefMessage(tokenId: string, hash: string, issuedAt: number): string {
  if (!/^\d+$/.test(tokenId) || !/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(issuedAt)) {
    throw new Error("The brief signature data is invalid.");
  }
  return JSON.stringify({ action: "seats-save-brief", token_id: tokenId, brief_hash: hash, issued_at: issuedAt });
}

export async function hashBrief(salt: string, brief: string): Promise<string> {
  if (!/^[0-9a-fA-F]{64}$/.test(salt)) throw new Error("The brief salt is invalid.");
  const bytes = new TextEncoder().encode(salt + brief);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildBriefRequestBody(
  accountId: string,
  publicKey: string,
  signature: string,
  nonce: Uint8Array,
  message: string,
  brief: string,
  salt: string,
) {
  if (nonce.length !== 32) throw new Error("The brief signature nonce must be 32 bytes.");
  const binary = String.fromCharCode(...nonce);
  return {
    account_id: accountId,
    public_key: publicKey,
    signature,
    nonce: btoa(binary),
    message,
    brief,
    salt,
  };
}

export function randomBriefSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(salt, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
