import { Buffer } from "buffer";
import { describe, expect, it, vi } from "vitest";
import { callSignMessageWithBufferNonce } from "./WalletProvider";

describe("wallet message signing", () => {
  it("passes a real 32-byte Buffer nonce to the wallet", async () => {
    const signMessage = vi.fn().mockResolvedValue(undefined);
    const nonce = new Uint8Array(32).fill(1);

    await callSignMessageWithBufferNonce(signMessage, "message", nonce, "seats-agent-runner");

    const params = signMessage.mock.calls[0][0] as { nonce: unknown };
    expect(Buffer.isBuffer(params.nonce)).toBe(true);
    expect((params.nonce as Buffer).length).toBe(32);
  });
});
