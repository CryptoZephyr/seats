import deployment from "../../../deployments/testnet.json";

export const chainConfig = {
  networkId: "testnet",
  rpcUrl: "https://rpc.testnet.fastnear.com",
  daoAccountId: deployment.accounts.dao,
  seatNftAccountId: deployment.accounts.seat,
} as const;
