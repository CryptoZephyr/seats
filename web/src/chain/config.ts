import deployment from "../../../deployments/testnet.json";

export const chainConfig = {
  networkId: "testnet",
  rpcUrl: "https://rpc.testnet.fastnear.com",
  readRpcUrls: [
    "https://rpc.testnet.fastnear.com",
    "https://test.rpc.fastnear.com",
    "https://rpc.testnet.near.org",
  ],
  explorerTxBaseUrl: "https://testnet.nearblocks.io/txns/",
  daoAccountId: deployment.accounts.dao,
  seatNftAccountId: deployment.accounts.seat,
  outlayerAccountId: "outlayer.testnet",
  runnerAgentPublicKey: "ed25519:5xUyVeJwwZrWzMozcdW5GaLQ4xEdbmwbXMbBGsbMzKfX",
  runnerUrl: import.meta.env?.VITE_RUNNER_URL || "https://seats-agent-runner.onrender.com",
} as const;
