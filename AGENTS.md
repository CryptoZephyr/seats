# AGENTS.md

Seats: club memberships you can sell, with an AI delegate that votes for you while you're away. NEAR testnet only, $0 budget.

## Layout

- `contracts/seat-nft` issues seat NFTs, gates resale on DAO approval, and pays seller 95% / DAO levy 5% in one atomic flow.
- `contracts/seat-voter` holds voting weight per seat, enforces the override window, and verifies signed NEAR AI receipts plus the member brief.
- `contracts/tee-verifier` verifies the Intel TDX quote and stores the model signer.
- `outlayer/vault-job`, `outlayer/agent-job` are WASI jobs for vault decryption and agent voting.
- `services/agent-runner` is the TypeScript keeper that polls the DAO and casts expired pending votes.
- `web/` is the frontend visual design: React + Vite + TypeScript, CSS Modules, no backend wiring yet.
- `web/src/content/docs/` holds the in-app docs as MDX, grouped by folder and listed in `nav.ts`. Every page needs `title`, `summary`, `lastVerified`, and `commit` frontmatter. Add a page by creating the file and listing it in `nav.ts`.
- `docs/` holds product and measurement docs. `spikes/` preserves tested spike sources and run reports.
- `deployments/testnet.json` records the live testnet deployment and E2E evidence.

## Commands

```sh
rustup target add wasm32-unknown-unknown wasm32-wasip2
cargo test --workspace
cargo build --release --target wasm32-unknown-unknown -p seat-voter -p seat-nft -p tee-verifier
cargo build --release --target wasm32-wasip2 --manifest-path outlayer/vault-job/Cargo.toml
cargo build --release --target wasm32-wasip2 --manifest-path outlayer/agent-job/Cargo.toml
cd web && npm install && npm run dev    # dev server on 127.0.0.1:5199
cd web && npm run build                  # tsc --noEmit && vite build
cd web && npm run docs:check             # docs frontmatter, nav, internal links, external links
```

## Rules

- Testnet only. Never deploy these contracts to mainnet.
- The frontend is a visual mock with hash routes and static data. Do not wire it to chain, wallet, or backend unless asked.
- Design system is locked (Chamber direction, Two-tone surfaces). Tokens live in `web/src/tokens.css`; do not hardcode colors or fonts.
- Member-facing copy says "your delegate", never "the AI" or "agent". Hardware wording is exactly "Verified public OS on genuine Intel and NVIDIA hardware".
- Status is always word plus shape, never color alone. No em dashes in UI copy.
- Vote override deadline must always show clock time and countdown. The 95/5 split must be visible before signing.
