# Agent runner

The runner polls the DAO and submits expired pending votes. It supports explicit voter keys from `VOTERS`, seat discovery from the seat NFT, or both.

## Configuration

Required values are `NEAR_RPC_URL`, `DAO_ID`, `KEEPER_ACCOUNT_ID`, and `KEEPER_KEY_FILE`. Use a NEAR testnet RPC and `.testnet` account IDs.

`VOTERS` is an optional path to a JSON array with `voter_id` and `agent_key_file` fields. Explicit entries keep their own key files and take precedence over discovery.

To enable discovery, set both:

- `SEAT_NFT_ID`: the seat NFT contract account
- `RUNNER_AGENT_KEY_FILE`: a shared NEAR key file used to check request-vote access keys and sign voter calls

Discovery runs at startup and then at intervals of at least 60 seconds. It pages `nft_tokens`, resolves each seat's voter, and includes voters only when the shared key has FunctionCall permission for that voter and `request_vote`, and the voter has a non-empty brief hash. Per-voter view errors skip that voter and are logged once. A failed `nft_tokens` page leaves the last good discovered list in place and does not stop the tick loop. If `request_vote` returns `ERR_AGENT_WASM_NOT_PINNED` or `ERR_BRIEF_NOT_SET` for a discovered voter, the runner logs the failure once and backs that voter off for one hour. Explicit file voters are not affected.

`/health` lists voter IDs with source `file` or `discovered`. It includes `agent_public_key` when a shared key is configured. The endpoint never includes private key material.

Copy `.env.example` to an external environment file and set the paths to secret files. See the root README for Render setup and testnet proposal scripts.
