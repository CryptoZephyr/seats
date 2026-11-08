import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  createPublicKey,
  type KeyObject,
} from "node:crypto";

const HKDF_INFO = Buffer.from("outlayer-keystore-v1", "utf8");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function publicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error("OutLayer returned an invalid encryption key");
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

export function encryptProfileSecrets(publicKeyHex: string, plaintext: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    throw new Error("OutLayer returned an invalid encryption key");
  }
  const recipient = publicKeyObject(Buffer.from(publicKeyHex, "hex"));
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublic = ephemeral.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from([1]), ephemeralPublic, nonce, encrypted]).toString("base64");
}

export async function fetchOutlayerSecretsPubkey(
  owner: string,
  profile: string,
  secretsJson: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher("https://testnet-api.outlayer.ai/secrets/pubkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accessor: {
        type: "WasmHash",
        hash: "a2db80036766e04aab58c50b09387c033f0617a7cb3580d82482ca8756b6519d",
      },
      owner,
      profile,
      secrets_json: secretsJson,
    }),
  });
  if (!response.ok) throw new Error("Could not get the OutLayer encryption key");
  const payload = await response.json() as { pubkey?: unknown };
  if (typeof payload.pubkey !== "string") throw new Error("OutLayer returned no encryption key");
  return payload.pubkey;
}

export function decryptProfileSecretsFixture(
  privateKey: KeyObject,
  ciphertextBase64: string,
): string {
  const bytes = Buffer.from(ciphertextBase64, "base64");
  if (bytes.length < 61 || bytes[0] !== 1) throw new Error("Invalid OutLayer ciphertext");
  const ephemeral = publicKeyObject(bytes.subarray(1, 33));
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32));
  const nonce = bytes.subarray(33, 45);
  const encrypted = bytes.subarray(45, -16);
  const tag = bytes.subarray(-16);
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
