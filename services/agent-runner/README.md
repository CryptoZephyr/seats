# Agent runner

The runner polls the DAO and submits expired pending votes. It supports explicit voter keys from `VOTERS`, seat discovery from the seat NFT, or both.

## Configuration

Required values are `NEAR_RPC_URL`, `DAO_ID`, `KEEPER_ACCOUNT_ID`, and `KEEPER_KEY_FILE`. Use a NEAR testnet RPC and `.testnet` account IDs.

`VOTERS` is an optional path to a JSON array with `voter_id` and `agent_key_file` fields. Explicit entries keep their own key files and take precedence over discovery.

To enable discovery, set both:

- `SEAT_NFT_ID`: the seat NFT contract account
- `RUNNER_AGENT_KEY_FILE`: a shared NEAR key file used to check request-vote access keys and sign voter calls

Discovery runs at startup and then at intervals of at least 60 seconds. It pages `nft_tokens`, resolves each seat's voter, and includes voters only when the shared key has FunctionCall permission for that voter and `request_vote`. Voters without a brief hash or a valid pinned agent WASM are skipped. A skipped voter is logged once. A failed scan leaves the last good discovered list in place and does not stop the tick loop.

`/health` lists voter IDs with source `file` or `discovered`. It includes `agent_public_key` when a shared key is configured. The endpoint never includes private key material.

Copy `.env.example` to an external environment file and set the paths to secret files. See the root README for Render setup and testnet proposal scripts.
