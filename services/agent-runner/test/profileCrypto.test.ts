import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptProfileSecretsFixture, encryptProfileSecrets } from "../src/profileCrypto.js";

describe("OutLayer ECIES profile encryption", () => {
  it("round-trips the CLI ECIES v1 format", () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const plaintext = JSON.stringify({
      BRIEF: "private value",
      SALT: "ab".repeat(32),
      NEAR_AI_API_KEY: "secret value",
    });
    const encrypted = encryptProfileSecrets(publicKeyHex, plaintext);
    const bytes = Buffer.from(encrypted, "base64");
    expect(bytes[0]).toBe(1);
    expect(bytes.length).toBeGreaterThan(61);
    expect(decryptProfileSecretsFixture(privateKey, encrypted)).toBe(plaintext);
  });
});
