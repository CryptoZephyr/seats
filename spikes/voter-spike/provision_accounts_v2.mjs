import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { KeyPair } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/crypto/lib/esm/index.js";

const timestamp = "1793831906";
const secretsDir = "/home/ubuntu/near-spike/secrets/seat-voter-spike-v2";
const nearCli = "/home/ubuntu/.cargo/bin/near";
const agentPath = path.join(secretsDir, "voter-a-agent.json");
const accounts = [
  ["global-deployer", `global-seat-${timestamp}.testnet`],
  ["voter-a", `seatvoter-v2a-${timestamp}.testnet`],
  ["voter-b", `seatvoter-v2b-${timestamp}.testnet`],
];
const generated = new Map();
const sanitize = (text) =>
  text.replace(/(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+/g, "[KEY OMITTED]");

fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
fs.chmodSync(secretsDir, 0o700);

for (const [label] of accounts) {
  const keyPath = path.join(secretsDir, `${label}.json`);
  if (fs.existsSync(keyPath)) {
    throw new Error(`refusing to replace existing key file ${keyPath}`);
  }
}
if (fs.existsSync(agentPath)) {
  throw new Error(`refusing to replace existing key file ${agentPath}`);
}

for (const [label, accountId] of accounts) {
  const pair = KeyPair.fromRandom("ed25519");
  const secret = pair.toString();
  const keyPath = path.join(secretsDir, `${label}.json`);
  const keyFile = {
    account_id: accountId,
    public_key: pair.getPublicKey().toString(),
    private_key: secret,
  };
  fs.writeFileSync(keyPath, `${JSON.stringify(keyFile, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  generated.set(label, { accountId, keyPath, publicKey: keyFile.public_key });
}

const agentPair = KeyPair.fromRandom("ed25519");
const agentSecret = agentPair.toString();
const agentFile = {
  account_id: generated.get("voter-a").accountId,
  public_key: agentPair.getPublicKey().toString(),
  private_key: agentSecret,
};
fs.writeFileSync(agentPath, `${JSON.stringify(agentFile, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(agentPath, 0o600);

for (const [label, accountId] of accounts) {
  const { keyPath, publicKey } = generated.get(label);
  const child = spawnSync(
    nearCli,
    [
      "account",
      "create-account",
      "sponsor-by-faucet-service",
      accountId,
      "use-manually-provided-public-key",
      publicKey,
      "network-config",
      "testnet",
      "create",
    ],
    { encoding: "utf8", input: "\n", timeout: 120_000 },
  );
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  if (child.error || child.status !== 0) {
    const safeOutput = sanitize(output).split("\n").slice(-20).join("\n");
    throw new Error(
      `faucet account creation failed for ${accountId}: ${child.error?.message ?? safeOutput}`,
    );
  }
  const txHash = output.match(/(?:Transaction ID|transaction hash):\s*([1-9A-HJ-NP-Za-km-z]{30,})/i)?.[1] ?? null;
  console.log(JSON.stringify({ account_id: accountId, key_file: keyPath, transaction_hash: txHash }));
}

console.log(JSON.stringify({
  agent_key_file: agentPath,
  account_ids: accounts.map(([, accountId]) => accountId),
  key_file_modes: "0600",
}));
