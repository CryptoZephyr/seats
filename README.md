# Seats

Club DAOs lose votes from members who aren't around, and they can't let members sell out without losing control of who gets in. Proposals close on a deadline, so a member who's travelling, busy or asleep loses their say, and handing the vote to someone else means trusting them with it. A membership that's a plain token can be bought by anyone, and one that can't be sold leaves a departing member with nothing and the vote with someone who's gone.

Seats is club memberships you can sell, with an AI that votes for you while you're away. It's live on NEAR testnet at https://seats-web-ne6k.onrender.com.

Seats is for clubs and communities that run on a NEAR Sputnik DAO. Each membership is a seat, an NFT that carries one vote in the club's DAO and opens the club's private vault. A member can sell their seat, but only to a buyer the club approves, and the club keeps a 5% levy on every sale.

Every seat comes with an AI delegate. The member writes a private brief, and the delegate reads each DAO proposal and prepares a vote with a signed receipt from NEAR AI. The member gets a window to override it before the vote is cast, and the contract enforces that window.

Example: Ada's brief says "back community events, reject any spend over 50 NEAR". A proposal asks for 80 NEAR to rent a venue. Her delegate votes Reject and gives its reason, and Ada lets it stand. Later she sells her seat to Ben with the club's approval. Ada gets 95% of the price, the club gets 5%, and the vote now belongs to Ben.

Seats runs on NEAR testnet only. Don't deploy these contracts to mainnet.

Seat voting weight sits with the voter account, not the member's wallet. Anyone can submit a function-call proposal from their own wallet with a 0.1 NEAR bond, which is how visitors apply to join and holders offer a seat for sale.

## Components

- `contracts/seat-voter` holds voting weight, enforces the controller window, and checks signed receipts and the member brief before recording a pending vote.
- `contracts/seat-nft` issues membership seats, gates resale on DAO approval, rotates the voter's restricted agent key with its controller, and pays the seller and DAO in a 95/5 split.
- `contracts/tee-verifier` verifies the captured TDX quote and stores the model signer. The model's Intel TDX quote and NVIDIA GPU evidence verify, and its MRTD, RTMR0-2 and OS image hash reproduce exactly from the public dstack-nvidia-0.5.12 image (see docs/nearai-measurements.md). The model-serving containers are pulled at runtime by NEAR AI's compose-manager, so the hardware measurement doesn't cover which serving code ran.
- `outlayer/vault-job` checks the requester's seat ownership and encrypts the vault response to the requester's public key.
- `outlayer/agent-job` checks the voter brief hash, reads a DAO proposal, requests a signed model response, and returns the result for the voter to validate.
- `services/agent-runner` watches DAO proposals, requests agent votes with voter FunctionCall keys, and casts expired pending votes with a keeper key.
- `scripts/deploy-testnet.ts` deploys and configures the contracts on testnet from an external config file.
- `spikes/` preserves the tested source and run reports used to build this scaffold.

The seat NFT artwork is compiled into the contract and added when tokens are viewed, so every seat, including already-minted seats, shows it. Changing the art requires redeploying the contract code.

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

The deployed vault-check job is v0.2.0, built from `outlayer/vault-job`.

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

Set `NEAR_RPC_URL`, `DAO_ID`, `KEEPER_ACCOUNT_ID`, and `KEEPER_KEY_FILE`. `NEAR_RPC_FALLBACK_URLS` optionally accepts comma-separated NEAR testnet RPC URLs. When unset, reads fall back to `https://test.rpc.fastnear.com` and `https://rpc.testnet.near.org` after retryable errors. Transaction broadcasts fail over only after a rate-limit response and reuse the same signed transaction. Voters can be configured with `VOTERS`, a JSON file containing `voter_id` and `agent_key_file` paths, or discovered by setting both `SEAT_NFT_ID` and `RUNNER_AGENT_KEY_FILE`. When both sources include a voter, its explicit `VOTERS` key file wins. Discovery runs at startup and no more than once every 60 seconds. It only includes seats with the shared request-vote key and a non-empty brief hash. A discovered voter that rejects `request_vote` because its brief is missing or its WASM is unpinned is backed off for one hour. `RUNNER_AGENT_KEY_FILE` is a secret file containing the shared key, never the public key.

`WINDOW_SECONDS` defaults to 120, `REQUEST_TTL_MS` defaults to 180000, and `LOOKBACK_PROPOSALS` defaults to 20. On fresh state, the runner checks the most recent proposals in that lookback window. `START_PROPOSAL_ID` overrides the initial proposal.

When `PORT` is set, the runner binds an HTTP health server on `0.0.0.0` and serves `/health`. It reports voters with their `file` or `discovered` source, and includes `agent_public_key` when shared-key discovery is configured. Health reports `starting` with no successful tick for up to 600 seconds, `ok` while the last successful tick is within `Math.max(3 * pollMs + 60000, 600000)` ms, and `stale` otherwise. `KEEPALIVE_URL` enables periodic requests. If it is unset and `RENDER_EXTERNAL_URL` is available, the runner uses `${RENDER_EXTERNAL_URL}/health`. `KEEPALIVE_MS` defaults to 600000 and must be between 60000 and 840000.

Run `npm run build && npm start` from `services/agent-runner`. The runner writes its non-secret proposal cursor, known pending IDs, and durable in-flight vote requests to the ignored `state.json`. A timed-out request isn't retried until its `REQUEST_TTL_MS` expires.

### Render free service

The root `render.yaml` defines a free web service with the runner health check. Render supplies `PORT` and `RENDER_EXTERNAL_URL`. Add these secret files in the service settings:

- `/etc/secrets/keeper.json`
- `/etc/secrets/voters.json`
- `/etc/secrets/runner-agent.json`
- Each agent key file referenced by `voters.json`, stored under `/etc/secrets/`

Set `KEEPER_ACCOUNT_ID` to the keeper account. Set `SEAT_NFT_ID` and `RUNNER_AGENT_KEY_FILE` together to enable seat discovery. `VOTERS` is optional when discovery is configured. Explicit entries keep their own key files and take precedence over discovered entries. Keep each `agent_key_file` path in `voters.json` pointed at its secret file under `/etc/secrets/`. Before each request, the runner subtracts the account's estimated storage reserve from its balance and skips voters below `VOTER_MIN_AVAILABLE_YOCTO`, default `4350000000000000000000000`. The value is a decimal yoctoNEAR string. The free service has an ephemeral disk, so `state.json` is lost on restart or spin-down. The in-flight retry guard resets with it, and a restart during a request could cause one extra paid request.

Stage 3 testnet scripts live in `scripts/stage3-testnet.ts`. Build them with `npm run build --prefix services/agent-runner`, then use `services/agent-runner/dist/scripts/stage3-testnet.js`. `generate-runner-key` writes the shared key to `~/near-spike/secrets/runner-agent.json` and prints only its public key. Run the commands in this order after upgrading `seat-nft`: `propose-voter-defaults`, `propose-policy`, `apply`, then `claim`. Voter defaults must be proposed first because the council loses its `call:VoteApprove` permission in the policy change. The council loses votes on call, transfer, and bounty proposals while retaining its governance votes. `propose-policy` reads the live DAO policy, prints the changes, and submits one `ChangePolicy` proposal that preserves the members role and unrelated policy parameters. After the council approves it, run `propose-policy` again to read back and verify the applied policy. `apply` checks that the visitor role and 0.1 NEAR proposal bond are ready and that the council no longer has `call:VoteApprove`, then proposes a seven-day `approve_application` call with 10 Tgas of action gas. The action stays small because delegate votes forward only 150 Tgas to the DAO. For a new visitor, use a fresh top-level `.testnet` account ID. `apply` creates it through the faucet sponsor service with the visitor key stored outside the repo, so the funder does not pay for visitor creation or funding. The visitor balance check includes the proposal bond, Apply gas, a 4.5 NEAR claim deposit, and claim gas. After approval, `claim` calls `claim_seat` with the runner public key and 300 Tgas. The 4.5 NEAR deposit funds your delegate, less the registration deposit, and nearly all of it comes back after each vote. The measured net cost was about 0.004 NEAR per vote. The OutLayer request temporarily needs 4.0000005 NEAR liquid on the voter, most of which is refunded. The scripts then read the token and voter IDs from the seat NFT. The voter-defaults proposal reads signer, model, and pinned WASM values from `deployments/testnet.json`. The scripts refuse non-testnet accounts and check live DAO or account state before writing. The scripts have not been run as part of this code change.

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

### Stage 3 recovery run

The recovery proof ran on NEAR testnet on 2026-11-08. It reused Render service `srv-dbm7iubbc2fs738hta7g`, deployment `dep-dbo54irrjlhs73aeldkg`, at `https://seats-agent-runner.onrender.com`. Detailed proof transaction and receipt hashes are in `deployments/testnet.json`.

Accounts used:

- Funder: `seatsfund1-1793846395.testnet`
- DAO: `seats2-1793847972.sputnikv2.testnet`
- Seat NFT: `seatsnft3-1793848334.testnet`
- Visitor and Seat 3 controller: `visitor.seatsfund1-1793846395.testnet`
- Keeper: `keeper.seatsfund1-1793846395.testnet`
- Seat 1 voter: `s1.seatsnft3-1793848334.testnet`
- Seat 3 voter: `s3.seatsnft3-1793848334.testnet`
- Orphaned voter: `s2.seatsnft3-1793848334.testnet`
- Faucet sponsor: `s3faucet-1794137860.testnet`

The in-place Seat NFT upgrade for commit `f6a4f3c7cf192270158c86153d24bab8c2406c2d` was transaction `3kHRo9qyf6ZprKo3ttKFordjjggwidzguT5FYtAGoZnW`, receipt `wKTyyzaZX63Axo5Ly2LQ4k8tYByyZrgMKCFjryqXo4S`, code hash `B64N7rjVL2yxsTGvUiRoyu2v8aW1oGAhtv87QjSdALDF`. Seat 1 ownership and its record were unchanged, `next_seat` decoded as 3, and live voter defaults matched the deployment config. Voter-defaults proposal 9 was submitted in `5vtf6Hch5d4fveoVit4nqjVykBhd5k6YjnbmYbZPS6gA` and approved in `Hh2o3jKjMrGTpehTLSAuJKhW25crM7HZ5NyJ1XNQhTzj`. Policy proposal 10 was submitted in `HEVs9bamPfZqWD6SiKsEWke9eWGhHk2YqbuzF7CpVcBq` and approved in `B99sDF2X9mXLxYZ97umz9yCjwSebMFsFoHAQhXRbXdPk`.

The visitor received 0.2 NEAR in `5z5HR3SXwoXr3X6V93VRDSBVcDHdnZ8StCdd9SzBxoW`, then 0.3 NEAR in `2PQLHpAqTnAYWFGTdU1XYJUAM27JDV6p4B4uNq7aucpN`. An attempted Apply `41J6U53vKvRA66hsociA7hdgCoE8ZPT7AXwzHMNVGgwo` did not create a proposal. Proposal 11 used transaction `Heh7vwZzDxa4qeFHC4pGZwvzE2AqTTu6yG5jFZn6K77j`, and Seat 1's delegate approved it with request `SzWbvZVDzEDow1YkQqHrVUMcu3BtXCo7yWh3Rapun6a` and cast `MxbX3cimwDVRDXVhhx1gwqpzHTyCbBSy2A5tm6jYR2y`. After the first claim failed, transaction `9vsqAGcS9RXP26h7pKok6EQbSYgpiNPZwkWwUsrRfYhK` left `s2.seatsnft3-1793848334.testnet` as an orphan with a restricted runner key but no NFT or seat record. Discovery reads `nft_tokens`, so the runner does not discover s2.

The visitor received a further 0.0582948671265055 NEAR in `D73yuqzx1VzcpUqQaUpzFp7tAm8VDfGFzqmAyNXKNhjZ`. Apply proposal 12 was submitted in `5D2HND41dGFXeLepAQDdww9BQBdMm1ujxSjZYfUFSJNR`. Seat 1's first timed-out request, `88dnPLm1SdXhQK8Q1mgb6uPi2eHRpYWmr4pwHEAm2THT`, landed but the agent callback returned `ERR_AGENT_OUTPUT`. The runner's TTL retry `Eb4WwZo6uuBFKuZuk2PwAKW563gqucvM2uVALqsqsFye` produced pending Approve receipt `e9c8b55cc9fc7a003dd2a77564f1c12a258e43c94f6ab036e9de7066cd29f497`. Keeper cast `Ef3yMwttpTmWmsEFNi7CsnL8ZSn86RLb8bQed64MApH5` approved proposal 12 and returned its full 0.1 NEAR bond to the visitor.

The successful claim transaction `DBPfPVQiqeSQxCRWwDTTkoJ6pcpgFTduDf6drFWHpDXJ` minted token 3 to the visitor, with voter `s3.seatsnft3-1793848334.testnet`. The controller, shared key restriction (`request_vote` only), model signer, pinned WASM, and DAO delegation total of 2 were verified. Seat 3's brief was set in `4cLyN1TaPh3bbz1D25cJnRfmXfaJr78YH8LrYmztBCap`, reusing brief hash `648ecae07ec5dd816c22e3571242859871a2dcc4f70ed1b3954dba6f6d63435d`.

Proposal 13 was a harmless `get_voter_defaults` call with zero deposit and 5 Tgas, submitted in `6VWXmfX6oPWdcrkpMZZb32tCeLBFC9v6D8oSZW8YqfD7`. Seat 1 requested and cast Approve in `F2ZAgQK6M9zzAMe1VjBFN4k49F1EBqw5m81rNntsPiQ2` and `G5rTEx92DgMqruALR6sPPbHPY6sYDqz2vAyBQ4oR9UCA`. A prior authorized 0.3 NEAR transfer from the funder to s3, `6wE5XyG8u5TUqFfb52pzFBwB74H1ZUMms3R5Kp4NmFTy`, did not cover the 4.0000005 NEAR OutLayer payment. The automatic s3 request `93nBHE2y1PwUZ2FsXyNos36a9KjYoP7G1o7SxSbBJomT` failed on chain. After proposal 13 closed, the council finalized it in `7gCa2JfVP3XCfHLG4JGsuNaKhB6JMMWY4dfYDsAqNHUJ`, returning its full 0.1 NEAR bond to the funder.

For the final proof, faucet-sponsored account `s3faucet-1794137860.testnet` was created in `6N8zcxvydQyg3Rn7Gkr3frysKcUQH8Vgz7zVNa5VpnSC`. It transferred 4.2 NEAR to s3 in `BpiS9C5UPn9zz7tcxRoa8su27fqhc5KJWeS9LGqBsvzb`, leaving s3 with 4.549604963848036 NEAR before its request. No further funder or keeper transfer was sent for proposal 14.

Proposal 14 was submitted in `3kEGbgmkKGwqgkqKvNpVnWg5sBqBmx2JBbuuecVpv8SN`. Seat 1's request `816D2MSXirVRNqyUNMmptfZvm9w71zWaK2xWbun5hXZN` logged a timeout but landed, producing pending Approve receipt `ac5bbd295afa7bf54173444eacb7c447b103e65fea62857a68c1d36f6da5fee1`. Seat 3's runner request `52FF7LHVG91p5qqaR5RhoiEfkeatq8LitD329KYDCrjk` produced pending Reject receipt `10cbdb42b7fba3264f6a3180a629839984d23c9fba191168d73df913794c2058`, because the internal proof item falls outside its member brief. The keeper cast Seat 1's vote in `Dho47ZAfdWvB9deSxJx6shZVs2TNLkr4DaXTQFSx5Hi8` and Seat 3's vote in `EfgJTVnrDUj4reywjG5bnnbrxZynJJc2BAJFFQD6MMP8`. Proposal 14 remains `InProgress` with one Approve and one Reject, so its 0.1 NEAR bond is still held. No override was submitted.

One request plus cast cost 0.004023539233024 NEAR net from Seat 1's balance, measured from 4.965246888031220 NEAR before the proposal 13 cycle to 4.961223348798196 NEAR after it. The 4.0000005 NEAR OutLayer deposit is paid by the voter account, not seatfunder. Of that payment, 0.0027431001 NEAR was charged and 3.9972573999 NEAR was refunded. The voter needs the full deposit liquid while the job runs.

The final `/health` snapshot captured after the casts was `ok`, with s1 listed as `file`, s3 as `discovered`, cursor 14, and public key `ed25519:5xUyVeJwwZrWzMozcdW5GaLQ4xEdbmwbXMbBGsbMzKfX`. Its `last_tick_at` was 2026-11-08T11:42:54.641Z and `last_tick_ok_at` was 2026-11-08T11:42:55.231Z. Final balances were funder 0.655358897996756 NEAR, visitor 0.440663245872605 NEAR, keeper 2.993262325618428 NEAR, s3 4.545843526424313 NEAR, and faucet sponsor 5.799955363487500 NEAR.

### Phase 3A Vault frontend proof

The browser-only Vault request from Seat 1 holder `rb.seatsfund1-1793846395.testnet` succeeded in transaction `BqR6a2ajQMo8DHKwXhF8qCwv5yRSwcVVtqdmr4ZkY9Kj`. The live estimate was `0.0070001` NEAR, so the request attached `0.0070001000005` NEAR including the 500,000,000,000 yocto buffer. The holder's measured net balance decrease was `0.0024259193923695` NEAR, and the result decrypted successfully. The vault text is not recorded.

### Seat 1 brief proof recovery

The brief profile was stored under `seatsbriefs-1794146327.testnet`, profile `s1-ad583f34b7478b80`, in `GHd7E8z1rUszdKKQnYMuQjjYbahAdWBXSTetBxx8KyEF`. The measured owner balance decrease was `0.0130519366507306` NEAR. Seat 1's new profile reference was set in `64C3JF3uLM3rWpbFndG1bXvpp2YD1SZovCf9a8c583e5` and again in `2CioBQ4xx2BmtiNp8vZMm1nFHUXeKyboAXStWYSis4y9`.

The recovered OutLayer request `Btk1qzMkhDsYpDyyDnt2KPzRTjttZ2Lgbw9S8fLmWpdW` and the single retry `CpkqryemnTmBETmPA8xm2ducX1QzV9Kwj29d28jHer66` both used proposal ID 15. `get_last_proposal_id` returns the next ID, so `get_proposal(15)` panicked with `ERR_NO_PROPOSAL`, surfaced by `rpc_view` as `rpc result`. The agent reads `get_brief_hash` before `get_proposal`, so both requests passed the brief-hash check. Neither produced a vote decision. Their measured net costs were `0.0027790853721591` NEAR and `0.00278031289895` NEAR. OutLayer charged `0.0020677` and `0.0020691` NEAR respectively and refunded most of each deposit.

After those attempts, Seat 1's old brief reference was restored in `5a7HuX7TowVLLhhpJ3ffg977PBgvYjGC7aLsCY2o39Zz` and again in `HK9UwDRGX1e6o4NPp2bEhbqnjCk1zJkY3peKndFtkuT4`. For the proposal 14 proof, rb set the new profile in `7bRVjFAhx929q5jwtjE4JSSwgxTnnpLF5whtQ2HfDwX1`, costing `0.0001804620261747` NEAR.

The proposal 14 request `ARy9myExdEZ3M5TLrGVGzm3chxTuo63y1PXhdZqmkMWB` from `s3faucet-1794137860.testnet` reached `FINAL`. All seven receipt outcomes were examined. It returned the decision `Reject`. The estimate was `0.0070001` NEAR and the deposit was `0.0070001000005` NEAR. OutLayer charged `0.0024224001` NEAR and refunded `0.0045776999005` NEAR. The measured payer balance decrease was `0.0031428328907213` NEAR. The final `get_brief` read confirms Seat 1 now uses hash `ad583f34b7478b80d0ae695cde784eb45db19c3778d9e934c2079413df16d6af`, account `seatsbriefs-1794146327.testnet`, profile `s1-ad583f34b7478b80`. No brief text is recorded.

### Current voter agent configuration

Proposal 29 set the current voter default to H2, SHA-256 `cdbd2c1fb58a2eee865c1d7349c5d28a39bf4def15e116ac60dd4d124a550a0e`, at the commit-pinned URL in `deployments/testnet.json`. Seat 1 and Seat 4 were pinned by `C75jozYeLA18hiF3ZY3Ukf7JH6AWrua1HwsugP44iDKi`. Proposal 29 pinned Seat 5, with receipt `GQ8htz9Bhe6RED5XXDSeEwxokoCTenthULiP7bKuo1xN`. Seat 3 remains pinned to v0.1.0, SHA-256 `a2db80036766e04aab58c50b09387c033f0617a7cb3580d82482ca8756b6519d`. Finalized view heights and proposal transactions are recorded in `deployments/testnet.json`.
