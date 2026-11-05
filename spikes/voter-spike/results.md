# Seat voter testnet spike

Status: complete. Testnet only. No private-key or API-key values are included in this report or `raw.json`.

## Setup

- DAO: `dao.zspike-1793094130.testnet`
- Staking proxy: `weight.zspike-1793094130.testnet`
- Voter: `seatvoter-1793829831.testnet`
- Seller: `seller-1793829831.testnet`
- Buyer: `buyer-1793829831.testnet`
- Initial controller: seller. Final controller: buyer.
- Initial DAO delegation supply was `10`. Seller and buyer each had weight `0`.
- Voter WASM: 191,236 bytes, SHA-256 `6b9294a50cd3f13f19d7e99414211c2bc649d12f085f7d390f28f54ea20c14d4`.
- Final voter account storage usage: 192,886 bytes, about 1.92886 NEAR locked at `10^19` yoctoNEAR per byte. `get_results` reported 192,968 bytes before FullAccess-key deletion.
- Final voter weight: `1`. Final delegation supply: `11`.
- Final voter keys: one FunctionCall key, receiver is the voter account, method `submit_pending`, allowance `0.2491952028543604 NEAR`. The FullAccess key was deleted.

## Pass/fail

| Test | Result | Evidence |
|---|---|---|
| T1, assign seat weight | PASS | Register and add-weight receipts succeeded. Final voter weight `1`, total supply `11`. |
| T2, controller votes through seat | PASS | Seller called `member_vote` on P1, proposal 45. DAO records `seatvoter-1793829831.testnet` as Approve, not seller. |
| T3, override window | PASS, with override timing noted below | P2, proposal 46. Immediate cast returned `ERR_TOO_EARLY` with no DAO receipt. Seller changed the pending vote to Reject. A later public cast succeeded and the DAO recorded Reject from the voter account. |
| T4, cancellation | PASS | Seller canceled P3, proposal 47. Later cast returned `ERR_NO_PENDING`. |
| T5, agent-key restrictions | PASS | The key could submit only `submit_pending`. `override_vote`, `cancel`, `set_controller`, and `member_vote` were rejected before inclusion by access-key validation. Transfer and direct DAO calls were also rejected before inclusion. Duplicate submission reached the contract and returned `ERR_PENDING_EXISTS`. |
| T6, resale | PASS | P4, proposal 48, was still InProgress at the final preflight view, but its pending entry was cleared after controller change. Cast returned `ERR_NO_PENDING`. Seller override and member vote returned `ERR_NOT_CONTROLLER`. On fresh P6, proposal 50, buyer's `member_vote` succeeded and the DAO counted Approve under the voter account. P1 was InProgress before the duplicate attempt, which returned `ERR_ALREADY_VOTED`. |
| T7, no-weight failure and restore | PASS | On fresh P7, proposal 51, owner removed the seat's weight. Buyer `member_vote` received DAO error `ERR_PERMISSION_DENIED`; callback result was Failed with `cast: false`, and P7 had no votes. Owner restored weight to `1`. |
| T8, remove FullAccess key | PASS | DeleteKey transaction succeeded. Final access-key list contains only the restricted agent FunctionCall key. |

P5, proposal 49, was also checked before the resumed tests and was InProgress. Fresh proposals P6 and P7 were created for the remaining votes and each was checked InProgress before use.

T3 timing from finalized block timestamps: the immediate cast was 3.383 seconds after submission, 56.617 seconds before the deadline. The seller's override was accepted 54.519 seconds after the deadline, and the public cast succeeded 58.698 seconds after the deadline. `override_vote` checks controller and pending state but does not check the deadline. The public cast still enforced `ERR_TOO_EARLY` before the deadline. The implementation therefore verifies the cast delay, while also showing that a controller can override a pending vote after the delay has elapsed.

## Key transaction hashes

All submitted transaction hashes, per-transaction outcomes, receipt outcomes, gas, tokens burnt, timestamps, and final views are in `raw.json`.

- Deployment: `6qZUEPNJ3ZoKqUgxtX4W9EsMF6fUQ7CtYoTrxwut6wQ6`, succeeded.
- Initialization: `5EFdw9hBho8sfN9f88xL8a7XiBEeJELY36PkbhBuTpvi`, succeeded.
- Agent FunctionCall key: `5tuqEpNYyBeJ52RufSy72pQ3DKhYcTuqYDzrw8MH2qY6`, succeeded.
- T1 register: `Sbq93cBtHk2qremni8VBajnoTDusZEGGmtTz49zWnaN`, succeeded.
- T1 add weight: `4yYNb6aJoHoEWxGZkLvCb734y9p6Agg28bj75uMFZUqA`, succeeded.
- P1: `5by8ABJQfrmwTHjRjPwKhXGtJvfZbwz8aZp32KXioCRJ`, proposal 45.
- T2 seller member vote: `3oFvfQSVsoifdRfVWLn99gcXBY3QuzBL8i7rx8HGQEKN`, succeeded.
- T6 old P4 cast: `5HJK8X3NZfKP9iGUbmwW6Z3XRxo7c4mw9baK66XKgD7Y`, `ERR_NO_PENDING`.
- T6 seller override: `GXj6XvEmL66TCRm7UL4KnQwTHjUYBhxTSiCyL1SSPhxz`, `ERR_NOT_CONTROLLER`.
- T6 seller member vote: `Gb9Lytyt3N5aoJTS3eJUf1LzNyPiyZq7Wd8tyRzDgTwe`, `ERR_NOT_CONTROLLER`.
- P6: `3yxQAxP578smt9n31NWhXrruaWvcFCxJFKvAv1v7VcRr`, proposal 50.
- T6 buyer vote on P6: `ApLk24ysuFEMDm29HeFrnUEHoPxktJu7dZ5qjQgofeaR`, succeeded.
- T6 duplicate vote on P1: `5evAQW4byKDwYMqq9ngjR4fi7dwnYRRoLCiraVYXWsrF`, `ERR_ALREADY_VOTED`.
- P7: `5PS3gWc5GvED2Jt5wiwa4GmwdE2shuh4rqEcjie6RLqC`, proposal 51.
- T7 successful weight removal retry: `9Ly4ZzLmKjDvSdhMsXc5uEKrCjYpuUehCGd4EBz7wNuX`, succeeded.
- T7 buyer vote without weight: `FShEU8zUeBea6otnM9EvrAyBK5M8JNxC8n78Mih1GZiN`, DAO returned `ERR_PERMISSION_DENIED`.
- T7 restore weight: `F2E76i3qAe5FvARBuEQrDSpLQixH5zb4aU9fJ6desigZ`, succeeded.
- T8 DeleteKey: `57pWwzziXno2neiusUxN9R7TpZ93PN1Q41QqWrhmuJ8n`, succeeded.

## Gas and balances

Gas totals below include the transaction and all receipts. In particular, the successful cast includes the DAO call and callback.

| Method/sample | Gas burnt | Tokens burnt |
|---|---:|---:|
| `submit_pending`, P2 | 2,282,700,699,673 | 0.0002059518137173 NEAR |
| `submit_pending`, P3/P4 | 2,359,109,103,108 each | 0.0002135926540608 NEAR each |
| `cast`, successful P2 | 8,157,672,506,051 | 0.0007488124818551 NEAR |
| `cast`, early P2 | 1,863,433,582,786 | 0.0001640251020286 NEAR |
| `cast`, canceled P3 | 1,837,835,559,604 | 0.0001614652997104 NEAR |
| `member_vote`, successful P1 | 7,665,202,190,847 | 0.0006995654503347 NEAR |
| `member_vote`, successful P6 | 7,687,461,847,727 | 0.0007017914160227 NEAR |
| `member_vote`, P1 duplicate | 7,217,928,817,031 | 0.0006548381129531 NEAR |
| `member_vote`, P7 without weight | 7,203,420,420,464 | 0.0006533872732964 NEAR |

Owner balance fell from `0.421698085525494` to `0.4182024061083776 NEAR`, a decrease of `0.0034956794171164 NEAR`. The owner remained above the 0.3 NEAR floor. DAO balance rose from `4.9505263036084932` to `4.9506863036084932 NEAR`, a net increase of `0.00016 NEAR` from delegation registration, with no net treasury spend. The weight proxy balance decreased by the same `0.00016 NEAR`. Voter final balance was `9.997527983115954 NEAR`.

The first T7 removal attempt was rejected before inclusion because the owner transaction nonce was stale. A fresh finality access-key nonce was read before the resumed send. The new removal transaction succeeded, and no duplicate included transaction resulted.

All credential JSON files under the testnet credentials directory were set to mode 600. No commits, pushes, or mainnet actions were made.
