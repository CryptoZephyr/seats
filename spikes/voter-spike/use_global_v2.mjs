import fs from "node:fs";
import { KeyPair } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/crypto/lib/esm/index.js";
import { KeyPairSigner } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/signers/lib/esm/index.js";
import {
  GlobalContractIdentifier,
  actionCreators,
} from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/transactions/lib/esm/index.js";
import { baseDecode } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/utils/lib/esm/index.js";
import { prepareTransaction, sendPrepared } from "/home/ubuntu/near-spike/dao-latency/fc_key_common.mjs";

const codeHash = "4ZQhU4fA6uAmWv4jMQ6vqQPpxqJszxaqSN9WB672w8mN";
const credentials = [
  ["seatvoter-v2a-1793831906.testnet", "/home/ubuntu/near-spike/secrets/seat-voter-spike-v2/voter-a.json"],
  ["seatvoter-v2b-1793831906.testnet", "/home/ubuntu/near-spike/secrets/seat-voter-spike-v2/voter-b.json"],
];

for (const [accountId, filePath] of credentials) {
  const { private_key: secretKey } = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const account = {
    accountId,
    publicKey: KeyPair.fromString(secretKey).getPublicKey(),
    signer: KeyPairSigner.fromSecretKey(secretKey),
    nonce: null,
  };
  const identifier = new GlobalContractIdentifier({ CodeHash: baseDecode(codeHash) });
  const action = actionCreators.useGlobalContract(identifier);
  const prepared = await prepareTransaction(account, accountId, action);
  const sent = await sendPrepared(prepared);
  const record = await sent.blockPromise;
  console.log(JSON.stringify({
    account_id: accountId,
    hash: record.hash,
    block_height: record.block_height,
    status: record.status,
    error: record.error,
  }));
}
