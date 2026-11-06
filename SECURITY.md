# Security policy

Seats runs on NEAR testnet only. Do not deploy these contracts to mainnet.

## Reporting a vulnerability

Open a private security advisory on this repository, or contact the maintainer directly. Do not file public issues for unpatched vulnerabilities.

## Scope

- `contracts/` NEAR smart contracts (seat-nft, seat-voter, tee-verifier)
- `outlayer/` WASI jobs (vault-job, agent-job)
- `services/agent-runner` keeper service
- `web/` frontend

## Notes for reviewers

- The seat-voter contract verifies NEAR AI ECDSA receipts, the Intel TDX quote via tee-verifier, the member brief hash, and the override window deadline. Changes to signature verification, window enforcement, or controller rotation need testnet E2E evidence before merge.
- Resale is the highest-risk flow: escrow, DAO approval, atomic ownership and voter-controller move, and the 95/5 payout must stay atomic. `contracts/seat-nft` enforces this; see `spikes/` and `deployments/testnet.json` for prior test evidence.
- Never commit private keys, `.env` files, or OutLayer secrets. `.env.example` documents required variables without values.
