# Seats

Club memberships you can sell, with an AI that votes for you while you're away.

Seats is for clubs and communities that run on a NEAR Sputnik DAO. Each membership is a seat, an NFT that carries one vote in the club's DAO and opens the club's private vault. A member can sell their seat, but only to a buyer the club approves, and the club keeps a 5% levy on every sale.

Every seat comes with an AI delegate. The member writes a private brief, and the delegate reads each DAO proposal and prepares a vote with a signed receipt from NEAR AI. The member gets a window to override it before the vote is cast, and the contract enforces that window.

Example: Ada's brief says "back community events, reject any spend over 50 NEAR". A proposal asks for 80 NEAR to rent a venue. Her delegate votes Reject and gives its reason, and Ada lets it stand. Later she sells her seat to Ben with the club's approval. Ada gets 95% of the price, the club gets 5%, and the vote now belongs to Ben.

Seats runs on NEAR testnet only. Don't deploy these contracts to mainnet.

Seat voting weight sits with the voter account, not the member's wallet. Members submit proposals through the council or the voter account, rather than directly from their wallet.

## Components

- `contracts/seat-voter` holds voting weight, enforces the controller window, and checks signed receipts and the member brief before recording a pending vote.
- `contracts/seat-nft` issues membership seats, gates resale on DAO approval, rotates the voter's restricted agent key with its controller, and pays the seller and DAO in a 95/5 split.
- `contracts/tee-verifier` verifies the captured TDX quote and stores the model signer.
- `outlayer/vault-job` checks the requester's seat ownership and encrypts the vault response to the requester's public key.
- `outlayer/agent-job` checks the voter brief hash, reads a DAO proposal, requests a signed model response, and returns the result for the voter to validate.
- `services/agent-runner` watches DAO proposals, requests agent votes with voter FunctionCall keys, and casts expired pending votes with a keeper key.
- `scripts/deploy-testnet.ts` deploys and configures the contracts on testnet from an external config file.
- `spikes/` preserves the tested source and run reports used to build this scaffold.

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
cargo build --release --target wasm32-unknown-unknown \
  -p seat-nft --features sandbox-test
cargo test -p seats-integration-tests --test seat_flow -- --ignored
```

The sandbox test uses a vendored Sputnik DAO WASM. near-workspaces 0.24 does not expose a global-contract deployment action, so the test deploys a voter account per seat and mints through the DAO's restricted test mint method. It covers DAO-mediated minting, approved resale, the 95/5 payout, seller-key removal, buyer-key permissions, failed-sale refunds, and a member vote recorded under the voter. The global-voter `mint_seat` path still needs a testnet integration run.

Build the OutLayer WASI jobs:

```sh
cargo build --release --target wasm32-wasip2 \
  --manifest-path outlayer/vault-job/Cargo.toml
cargo build --release --target wasm32-wasip2 \
  --manifest-path outlayer/agent-job/Cargo.toml
```

The jobs read their runtime configuration from OutLayer. Keep API keys and vault text in OutLayer's encrypted secrets, never in source, job arguments, or this repository. `.env.example` lists variable names only.

## Agent runner

Install dependencies and check the runner:

```sh
cd services/agent-runner
npm ci
npm test
npx tsc --noEmit
```

Copy `voters.example.json` to the ignored `voters.json`, then set `NEAR_RPC_URL`, `DAO_ID`, `VOTERS` to that file path, `KEEPER_ACCOUNT_ID`, and `KEEPER_KEY_FILE`. The voter file contains `voter_id` and `agent_key_file` paths. `WINDOW_SECONDS` defaults to 120, and `REQUEST_TTL_MS` defaults to 180000. At startup, the runner warns if the DAO proposal period is shorter than the voter window plus 300 seconds. Run `npm run build && npm start` from `services/agent-runner`. The runner writes its non-secret proposal cursor, known pending IDs, and durable in-flight vote requests to the ignored `state.json`. A timed-out request isn't retried until its `REQUEST_TTL_MS` expires.

## Testnet deployment

Build the contracts first. Copy `scripts/deploy-testnet.example.json` to the ignored `scripts/deploy-testnet.json`, fill in account IDs and paths to keys under the external spike secrets directory, and provide a fresh quote-arguments file. The script is restricted to testnet, stores only account IDs, transaction hashes, and code hashes in `deployments/testnet.json`, and never copies key contents into the repository.

New DAOs use a 600-second proposal period by default. `proposal_period_seconds` must be at least `window_seconds + 300`, and an existing DAO with a shorter period is updated during deployment.

The 80 NEAR venue proposal used for the rejection test is never funded.

```sh
cd services/agent-runner
npm ci
npm run build
node dist/scripts/deploy-testnet.js --config ../../scripts/deploy-testnet.json
```
