import nacl from "tweetnacl";

export interface VaultCiphertext {
  ok: boolean;
  error?: string;
  ephemeral_pubkey?: string;
  nonce?: string;
  ciphertext?: string;
}

export function generateVaultKeyPair() {
  return nacl.box.keyPair();
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error("Vault response contains invalid encrypted data.");
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function decryptVaultResponse(payload: VaultCiphertext, secretKey: Uint8Array): string {
  if (!payload.ok) throw new Error(payload.error || "ERR_NO_SEAT");
  if (!payload.ephemeral_pubkey || !payload.nonce || !payload.ciphertext) {
    throw new Error("Vault response is missing encrypted fields.");
  }
  const plaintext = nacl.box.open(
    fromHex(payload.ciphertext),
    fromHex(payload.nonce),
    fromHex(payload.ephemeral_pubkey),
    secretKey,
  );
  if (!plaintext) throw new Error("Vault response couldn't be decrypted.");
  return new TextDecoder().decode(plaintext);
}
