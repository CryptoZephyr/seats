import { main } from "../services/agent-runner/src/stage3-testnet.js";

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${String(error).replace(/(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+/g, "[key omitted]")}\n`);
  process.exitCode = 1;
});
