import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { KeyPairSigner } from "@near-js/signers";
import { baseDecode, baseEncode } from "@near-js/utils";
import { JsonRpcProvider } from "@near-js/providers";
import { actionCreators, createTransaction } from "@near-js/transactions";
import { chainConfig } from "../src/chain/config";
import { buildVaultRequest } from "../src/chain/transactions";
import { estimateVaultExecutionCost } from "../src/chain/rpc";
import { decryptVaultResponse, generateVaultKeyPair, type VaultCiphertext } from "../src/chain/vaultCrypto";

const signer = "rb.seatsfund1-1793846395.testnet";
const keyPath = "/home/ubuntu/near-spike/secrets/.near-credentials/testnet/rb.seatsfund1-1793846395.testnet.json";
const marker = "/home/ubuntu/seats/.vault-live-request-attempted";

function outputPayload(outcome: unknown): VaultCiphertext | null {
  const receipts = (outcome as { receipts_outcome?: Array<{ outcome?: { status?: { SuccessValue?: string } } }> }).receipts_outcome ?? [];
  for (const receipt of receipts) {
    const value = receipt.outcome?.status?.SuccessValue;
    if (!value) continue;
    try { return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as VaultCiphertext; } catch { continue; }
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && existsSync(marker)) throw new Error("The one-shot Vault proof has already been attempted.");
  if (!existsSync(keyPath)) throw new Error("The authorized testnet key file is unavailable.");
  const credentials = JSON.parse(readFileSync(keyPath, "utf8")) as {
    public_key?: string;
    private_key?: string;
    secret_key?: string;
  };
  const secretKey = credentials.private_key ?? credentials.secret_key;
  if (!secretKey) throw new Error("The authorized key file has no signing key.");
  const accountSigner = KeyPairSigner.fromSecretKey(secretKey);
  const publicKey = await accountSigner.getPublicKey();
  if (credentials.public_key && credentials.public_key !== publicKey.toString()) {
    throw new Error("The key file's public and private keys don't match.");
  }
  const provider = new JsonRpcProvider({ url: chainConfig.rpcUrl });
  const before = (await provider.viewAccount(signer)).amount;
  const keyPair = generateVaultKeyPair();
  const requester = Buffer.from(keyPair.publicKey).toString("hex");
  const estimate = await estimateVaultExecutionCost({
    max_execution_seconds: 10,
    max_instructions: 1_000_000_000,
    max_memory_mb: 128,
  });
  const request = buildVaultRequest(requester, estimate);
  if (request.receiverId !== chainConfig.outlayerAccountId || request.methodName !== "request_execution") {
    throw new Error("Unexpected Vault request builder output.");
  }

  const accessKey = await provider.viewAccessKey(signer, publicKey);
  const block = await provider.viewBlock({ finality: "final" });
  const transaction = createTransaction(
    signer,
    publicKey,
    request.receiverId,
    accessKey.nonce + 1n,
    [actionCreators.functionCall(request.methodName, request.args, request.gas, request.deposit)],
    baseDecode(block.header.hash),
  );
  const [transactionHash, signedTransaction] = await accountSigner.signTransaction(transaction);
  const hash = baseEncode(transactionHash);
  if (dryRun) {
    console.log(JSON.stringify({
      dry_run: true,
      tx_hash: hash,
      estimate_yocto: estimate,
      deposit_yocto: request.deposit.toString(),
    }));
    return;
  }
  writeFileSync(marker, `attempted ${new Date().toISOString()}\n`, { mode: 0o600, flag: "wx" });
  let outcome: Awaited<ReturnType<typeof provider.sendTransaction>>;
  try {
    outcome = await provider.sendTransaction(signedTransaction);
  } catch (error) {
    try {
      outcome = await provider.viewTransactionStatusWithReceipts(transactionHash, signer, "FINAL");
    } catch {
      throw new Error("The one-shot Vault transaction has an ambiguous result. Do not retry it.", { cause: error });
    }
  }
  let payload = outputPayload(outcome);
  if (!payload) {
    outcome = await provider.viewTransactionStatusWithReceipts(transactionHash, signer, "FINAL");
    payload = outputPayload(outcome);
  }
  if (!payload) throw new Error("The final transaction has no readable Vault result.");
  if (!payload.ok) throw new Error("The Vault job refused the request.");
  const plaintext = decryptVaultResponse(payload, keyPair.secretKey);
  if (!plaintext.length) throw new Error("The Vault job returned empty text.");
  const after = (await provider.viewAccount(signer)).amount;
  const cost = before - after;
  const costWhole = cost / 10n ** 24n;
  const costFraction = (cost % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  console.log(JSON.stringify({
    tx_hash: hash,
    estimate_yocto: estimate,
    deposit_yocto: request.deposit.toString(),
    cost_yocto: cost.toString(),
    cost_near: costFraction ? `${costWhole}.${costFraction}` : costWhole.toString(),
    decrypted_ok: true,
  }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Vault proof failed.");
  process.exitCode = 1;
});
