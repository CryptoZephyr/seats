import { describe, expect, it } from "vitest";
import {
  APPLICATION_DURATION_NS,
  CLAIM_SEAT_DEPOSIT,
  CLAIM_SEAT_GAS,
  PROPOSAL_ACTION_GAS,
  PROPOSAL_CALL_GAS,
  VAULT_REQUEST_GAS,
  buildApplyRequest,
  buildBuyRequest,
  buildClaimRequest,
  buildSaleRequest,
  buildVaultRequest,
  calculateSaleSplit,
  parseNearAmount,
} from "./transactions";
import { chainConfig } from "./config";
import { decryptVaultResponse, generateVaultKeyPair } from "./vaultCrypto";
import nacl from "tweetnacl";

const decode = (encoded: string) => JSON.parse(atob(encoded)) as object;

describe("flow transaction builders", () => {
  it("builds the exact Apply proposal and uses the DAO policy bond", () => {
    const request = buildApplyRequest("visitor.testnet", "100000000000000000000000");
    expect(request).toMatchObject({
      receiverId: chainConfig.daoAccountId,
      methodName: "add_proposal",
      gas: PROPOSAL_CALL_GAS,
      deposit: 100_000_000_000_000_000_000_000n,
      args: {
        proposal: {
          description: "Apply for a seat for visitor.testnet",
          kind: { FunctionCall: { receiver_id: chainConfig.seatNftAccountId, actions: [{
            method_name: "approve_application",
            args: expect.any(String),
            deposit: "0",
            gas: String(PROPOSAL_ACTION_GAS),
          }] } },
        },
      },
    });
    const action = ((request.args.proposal as any).kind.FunctionCall.actions[0]);
    expect(decode(action.args)).toEqual({
      applicant: "visitor.testnet",
      expires_in_ns: APPLICATION_DURATION_NS,
    });
  });

  it("builds Claim with the exact deposit and gas", () => {
    expect(buildClaimRequest("ed25519:public")).toMatchObject({
      methodName: "claim_seat",
      args: { agent_public_key: "ed25519:public" },
      gas: CLAIM_SEAT_GAS,
      deposit: CLAIM_SEAT_DEPOSIT,
    });
  });

  it("builds a Sell proposal and computes the contract's rounded 95/5 split", () => {
    const request = buildSaleRequest("1", "buyer.testnet", "101", 86_400_000_000_000, "100");
    const action = (request.args.proposal as any).kind.FunctionCall.actions[0];
    expect(request.receiverId).toBe(chainConfig.daoAccountId);
    expect(request.methodName).toBe("add_proposal");
    expect((request.args.proposal as any).description)
      .toBe("Seat sale: token 1, buyer buyer.testnet, price 101");
    expect((request.args.proposal as any).kind.FunctionCall).toMatchObject({
      receiver_id: chainConfig.seatNftAccountId,
      actions: [{ method_name: "approve_sale", deposit: "0", gas: String(PROPOSAL_ACTION_GAS) }],
    });
    expect(decode(action.args)).toEqual({
      token_id: "1",
      buyer: "buyer.testnet",
      price: "101",
      expires_in_ns: 86_400_000_000_000,
    });
    expect(request.gas).toBe(PROPOSAL_CALL_GAS);
    expect(request.deposit).toBe(100n);
    expect(calculateSaleSplit("101", 500)).toEqual({ seller: 96n, club: 5n });
    expect(() => calculateSaleSplit("101", 499)).toThrow(/require 500 bps/);
    expect(parseNearAmount("1.25")).toBe(1_250_000_000_000_000_000_000_000n);
  });

  it("attaches the approved Buy price and uses the E2E-proven gas", () => {
    const request = buildBuyRequest("1", "2500000000000000000000000");
    expect(request.receiverId).toBe(chainConfig.seatNftAccountId);
    expect(request.methodName).toBe("buy");
    expect(request.deposit).toBe(2_500_000_000_000_000_000_000_000n);
    expect(request.gas).toBe(300_000_000_000_000n);
    expect(request.args.token_id).toBe("1");
    expect(request.args.agent_public_key).toBe(chainConfig.runnerAgentPublicKey);
  });

  it("builds Vault args with the estimate plus buffer", () => {
    const request = buildVaultRequest("ab".repeat(32), "2000000000000000000000");
    expect(request).toMatchObject({
      receiverId: "outlayer.testnet",
      methodName: "request_execution",
      gas: VAULT_REQUEST_GAS,
      deposit: 2_000_000_000_500_000_000_000n,
      args: {
        params: null,
        payer_account_id: null,
        resource_limits: { max_execution_seconds: 10, max_instructions: 1_000_000_000, max_memory_mb: 128 },
        response_format: "Json",
        secrets_ref: { account_id: "seatfunder-1793834028.testnet", profile: "vault-seats3" },
        source: { Project: { project_id: "seatfunder-1793834028.testnet/vault-check-job", version_key: null } },
      },
    });
    expect((request.args as { input_data: string }).input_data).toBe(
      JSON.stringify({ requester_pubkey: "ab".repeat(32) }),
    );
  });

  it("decrypts a fixture encrypted with the same SalsaBox-compatible scheme", () => {
    const recipient = generateVaultKeyPair();
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box(
      new TextEncoder().encode("fixture"),
      nonce,
      recipient.publicKey,
      ephemeral.secretKey,
    );
    const hex = (data: Uint8Array) => Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(decryptVaultResponse({
      ok: true,
      ephemeral_pubkey: hex(ephemeral.publicKey),
      nonce: hex(nonce),
      ciphertext: hex(encrypted),
    }, recipient.secretKey)).toBe("fixture");
  });
});
