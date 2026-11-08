import { describe, expect, it } from "vitest";
import { buildBriefMessage, buildBriefRequestBody, hashBrief } from "./brief";
import { buildSetBriefRequest, SET_BRIEF_GAS } from "./transactions";

describe("brief relay builders", () => {
  it("builds the required signed message string", () => {
    expect(buildBriefMessage("1", "ab".repeat(32), 1_800_000_000_000)).toBe(
      '{"action":"seats-save-brief","token_id":"1","brief_hash":"abababababababababababababababababababababababababababababababab","issued_at":1800000000000}',
    );
  });

  it("hashes salt bytes followed by brief bytes", async () => {
    expect(await hashBrief("00".repeat(32), "brief")).toBe(
      "1779b0d320fe38c32c49c0e0192c06d5ca2cb28f79af2b574f8b50b19d9f7569",
    );
  });

  it("builds set_brief with a 30 Tgas call and no deposit", () => {
    const profile = `s1-${"cd".repeat(8)}`;
    const request = buildSetBriefRequest("s1.seatsnft.testnet", "cd".repeat(32), "owner.testnet", profile);
    expect(request).toMatchObject({
      receiverId: "s1.seatsnft.testnet",
      methodName: "set_brief",
      args: {
        brief_hash: "cd".repeat(32),
        secrets_account_id: "owner.testnet",
        secrets_profile: profile,
      },
      gas: SET_BRIEF_GAS,
      deposit: 0n,
    });
  });

  it("encodes the wallet nonce for the relay request", () => {
    const nonce = new Uint8Array(32).fill(1);
    expect(buildBriefRequestBody("owner.testnet", "ed25519:key", "sig", nonce, "message", "brief", "ab".repeat(32)).nonce)
      .toBe(Buffer.from(nonce).toString("base64"));
  });
});
