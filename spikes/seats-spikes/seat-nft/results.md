# Seat NFT spike

Status: Part A complete for the resale atomicity follow-up. The testnet contract was redeployed, and fresh token 3 changed controller and owner in one successful buy.

| Check | Result | Evidence |
|---|---|---|
| Previous failed buy refund | FAIL | Tx `GULsa1iGnEuLA2Tc2S4bFTTgToCi2gBdyErjBRqQsnqo` had no seat-to-buyer refund receipt. Buyer lost 0.1007722552439808 NEAR including 0.0007722552439808 NEAR gas. |
| Callback fix and redeploy | PASS | Callback returns unit, makes detached payout/refund transfers, and uses a per-token in-progress lock. Deploy tx `EX4npJgCANupnEdxsn5XkHRkJxPmo7RtdcATbaTkrtyy`, WASM 320,672 bytes, SHA-256 `d3d94b0b62411e8b8b4acb9ee37f455d9faaf271ff0e9e44440e34c1b4a48b31`. |
| Fresh-seat resale | PASS | Token 3 controller changed seller to buyer in buy tx `88XyxbR9vRKYDatKtYEfbhWSjG2YMuNyZCUWUR1UyEYy`; owner also changed to buyer. Seller gained 0.095 NEAR and DAO gained 0.005 NEAR. |
| Buyer vote after same sale | PASS | Tx `H2pAVSqQb5PT9APzQskXEz3ZfzizTwaxJavE1L2jGgqG` recorded Approve from voter `s3.<seat>` on proposal 15. |
| A6 bad-admin refund rerun | PASS | Tx `TMbGtdEU7WHvJ25miWn2VUzPLoPJqr6LBbd7Bmcgdfp`; controller call failed `ERR_NOT_ADMIN`, refund receipt `GCH9vHWqm1rbHEa9fqVdeNqcrZ4etAzPHLGGpFnMweb4` returned 0.1 NEAR. Buyer net debit matched 0.0006346753752821 NEAR gas. |
| Previous A2-A4 and A7 checks | PASS | See earlier transaction evidence below and `raw.json`. |
| Build and tests | PASS | `cargo test` passed with 0 tests. Release WASM build passed. |

Successful buy gas was 9.85 Tgas across its receipts. The previous measured seat storage was 322,087 bytes. The follow-up storage usage was not remeasured.

## Failed attempts and superseded runs

| Check | Result | Evidence |
|---|---|---|
| A2 refund | PASS | Refund receipt `3aseZcn7XTvgVihutZAwDVGCVzEa8UfunLPjD3wygYAX` transferred 0.05 NEAR to the DAO. DAO and seat balances were unchanged across the DAO call. |
| A3 direct transfer | PASS | `ERR_APPROVAL_REQUIRED`. |
| A4 buy guards | PASS | `ERR_NO_APPROVAL`, `ERR_WRONG_BUYER`, and `ERR_WRONG_DEPOSIT`; the wrong-deposit transfer was refunded. |
| A5 resale and buyer vote | FAIL | Buy `GULsa1iGnEuLA2Tc2S4bFTTgToCi2gBdyErjBRqQsnqo` failed `Returning joint promise is currently prohibited.` The token remains with the seller. The later buyer vote failed `Exceeded the prepaid gas.` |
| A6 bad voter admin | PARTIAL | Buy failed `ERR_NOT_ADMIN`, and the token remains with seller. Refund was not independently checked from balances. |
| A7 expired approval | FAIL | Approval failed `ERR_SAME_BUYER` because the current owner was passed as buyer. The expired-buy assertion was not reached. |

Resale, controller handoff, and the post-resale Part C test remain unverified.

## Final follow-up

The continuation table above is superseded by these final outcomes. A5 resale passed on retry after the `on_buy` callback was changed to detach the seller and DAO transfers and return `true`.

| Check | Final result | Evidence |
|---|---|---|
| A2 refund | PASS | DAO and seat balances were unchanged across the failed mint. Refund receipt `3aseZcn7XTvgVihutZAwDVGCVzEa8UfunLPjD3wygYAX` transferred 0.05 NEAR to the DAO. |
| A3 direct transfer | PASS | `ERR_APPROVAL_REQUIRED`. |
| A4 buy guards | PASS | No approval, wrong buyer, and wrong deposit returned the expected errors. Wrong-deposit funds were refunded. |
| A5 approved resale | PASS | Buy `3sPYsbHFbaMKfLhtaFJpQUC7UUTvXwH9Jwh6zvUhPsKy` transferred token 1 to the buyer. Seller gained 0.095 NEAR, DAO gained 0.005 NEAR, and voter controller is the buyer. |
| A5 buyer vote | PASS | Buyer vote tx `2w4PxTEstN2cmHjmh4k3u4JE5fWw1wwXU8DZ5JxP43DQ` recorded the voter account on fresh proposal 11. DAO status is Approved and the players vote count is 1. |
| A6 bad voter admin | PASS | `ERR_NOT_ADMIN`; refund receipt `Dxqvy6di8pyXUmwZN2hhva3kujEDMe538AxBNHG77uNN` returned 0.1 NEAR. Buyer net debit equals gas burn, `607006555022800000000` yoctoNEAR. |
| A7 expired approval | PASS | Buy tx `6ojy7fnuP7J2TqQiZUHAi63mHgBFft3GmMWcdvKKJTJC` returned `ERR_APPROVAL_EXPIRED`. Token remained buyer-owned. |

The successful resale used 9.775 Tgas. The fresh buyer vote used 13.388 Tgas. Seat storage usage after the final sale and approval checks was 322,087 bytes. The updated seat WASM is 319,979 bytes, SHA-256 `b003f7f66c8b0ec0d8af49e5616df14725690284e71605c7b8367929c4fae1a3`.

Two non-passing buyer vote attempts are retained in `raw.json`. One targeted already-approved proposal 9 and returned `ERR_PROPOSAL_NOT_READY_FOR_VOTE`. The other used a FunctionCall action with 200 Tgas while the voter reserves 150 Tgas for the DAO call, and returned `Exceeded the prepaid gas.` A fresh proposal using 50 Tgas succeeded.
