# Seats

Ada belongs to a DAO and wants to delegate a vote without giving up her membership. Seats represents that membership as an NFT paired with a voter account. The voter can act only for its current controller and within the member's chosen window. If Ada resells her seat with DAO approval, control moves with the NFT and the sale is split between Ada and the DAO.

Seats is an early backend scaffold for DAO memberships managed by voters and AI agents. It is testnet-only. Do not deploy or use these contracts on mainnet.

## Components

- `contracts/seat-voter` holds voting weight, enforces the controller window, and checks signed receipts and the member brief before recording a pending vote.
- `contracts/seat-nft` issues membership seats, gates resale on DAO approval, updates voter control before completing a sale, and pays the seller and DAO in a 95/5 split.
- `contracts/tee-verifier` verifies the captured TDX quote and stores the model signer.
- `outlayer/vault-job` checks the requester's seat ownership and encrypts the vault response to the requester's public key.
- `outlayer/agent-job` checks the voter brief hash, reads a DAO proposal, requests a signed model response, and returns the result for the voter to validate.
- `spikes/` preserves the tested source and run reports used to build this scaffold.

The agent runner and testnet deployment scripts from the broader plan are not included in this scaffold.

## Tests and builds

Install the Rust targets:

```sh
rustup target add wasm32-unknown-unknown wasm32-wasip2
```

Run contract unit tests:

```sh
cargo test --workspace
```

Build the three NEAR contracts and run the sandbox integration test:

```sh
cargo build --release --target wasm32-unknown-unknown \
  -p seat-voter -p seat-nft -p tee-verifier
cargo test -p seats-integration-tests --test seat_flow -- --ignored
```

The sandbox test uses a vendored Sputnik DAO WASM. near-workspaces 0.24 does not expose a global-contract deployment action, so the test deploys a voter account per seat and mints through the DAO's restricted test mint method. It covers DAO-mediated minting, approved resale, the 95/5 payout, failed-sale refunds, and a member vote recorded under the voter. The global-voter `mint_seat` path still needs a testnet integration run.

Build the OutLayer WASI jobs:

```sh
cargo build --release --target wasm32-wasip2 \
  --manifest-path outlayer/vault-job/Cargo.toml
cargo build --release --target wasm32-wasip2 \
  --manifest-path outlayer/agent-job/Cargo.toml
```

The jobs read their runtime configuration from OutLayer. Keep API keys and vault text in OutLayer's encrypted secrets, never in source, job arguments, or this repository. `.env.example` lists variable names only.
