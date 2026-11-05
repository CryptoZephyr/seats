# Part D: brief-bound voting

Final status: PASS on testnet for D1-D4.

| Check | Result | Evidence |
|---|---|---|
| Contract unit tests | PASS | 14 tests passed, including the zero-promise callback guard, pinned `submit_pending`, and non-admin pin-change checks |
| D1, 80 NEAR venue Transfer | PASS | Proposal 63 received a Reject from the bound job. `request_vote` tx `99kcshqqaqtJjfLk7jbj8Ncyr5PHqXcQSYWh4cpJubcV`; post-window cast tx `4zaanaeJ3ppVp4899FYWjiVqg7C51k2AGubpY2j8RWwG`. DAO records Reject under `briefvoter-1793834028.testnet`; contract result is Cast and no pending entry remains. |
| D2, changed brief hash | PASS | Hash-change tx `Gfroc92o2cTDzdDcrSmEmv2A8h7tPiZzCPJP5KdzjhQ9`; job request tx `chr5q3bpa33id5ULWpzANYy1bAmM8FM6sQZjEoFMJ2M` aborted with `ERR_BRIEF_HASH_MISMATCH`; no pending vote. Original hash restored in tx `2SDneZiw9R9cTXTGRzbMojuVZEFM7U69GU7s6ZRQZAR6`. |
| D3, callback access control | PASS | Agent-key call was denied before inclusion because `on_agent_result` is not allowed. A call from another account failed `#[private]` in tx `GMuiyCSGRtpnMV9MMVhTueJvg4vMbZ5fNbUgFJDmLzX5`. |
| D4, pinned receipt and pin access | PASS | Valid-fixture `submit_pending` while pinned failed `ERR_USE_REQUEST_VOTE` in tx `6daFsWypsc6GEpYr2iFhAdYEYrKRPeSzBSydqLLZvFd5`. The agent-key pin change was denied before inclusion because `pin_agent_wasm` is not an allowed method. |
| Agent key scope | PASS | Final access-key view shows the FunctionCall key can call only `request_vote`. The account also retains its separate FullAccess key. |

## Final implementation and testnet state

`on_agent_result` uses `#[private]` and requires exactly one promise result, otherwise it fails with `ERR_NOT_CALLBACK`. It checks the job output's `brief_hash` and `proposal_id`. While a WASM is pinned, `submit_pending` fails with `ERR_USE_REQUEST_VOTE`. Pin changes remain admin-only, and `request_vote` always sends the pinned URL and SHA-256. The final contract WASM is 251,849 bytes, SHA-256 `939f044961ea23a60074bb466226aaf66284f195329994b9e8e34e42ba4b2dc0`, deployed in tx `EBKgDGt641He9BFBEZfYpTNwDcTjbcX4b1JSe1217NkH`; its on-chain code hash is `AwFZsfm9Xf1gisxMRoGAXAxKXBzzUp2h4shS6ibGWVV1`. The pinned agent WASM is 688,426 bytes, SHA-256 `a2db80036766e04aab58c50b09387c033f0617a7cb3580d82482ca8756b6519d`.

The contract's FunctionCall key is restricted to `request_vote`. The direct callback zero-result unit test returns `ERR_NOT_CALLBACK`. The final on-chain access-key view contains the account's separate FullAccess key plus the restricted agent key.

The existing `players` role initially allowed only `call:` actions, so it could not cast a Transfer proposal. The voter was registered with weight 1 and its weight added in txs `8My8btFhveq8Uc7guR7xAAT2BnQ6tUMfxHG3sEmL8cxK` and `DDwKZVBZSgnSMpDVddYjFwFfFdJceMe3FwfKCp4MhmUa`, taking DAO delegation supply to 13. For the final D1 Transfer, DAO proposal 62 temporarily added TokenWeight Transfer voting permissions to `players`, approved in tx `J3ge6S6HgPpJgbW6DHUVtQuaseutHaWZUTB2VTPz9QXq`. After the vote, proposal 64 restored the original call-only policy, approved in tx `4s5CVRkt7BW9HTiZpr1uMiHfibp9uYzob49GKJ76hpZK`.

Proposal 63 is a real `Transfer` proposal for 80 NEAR to `seatfunder-1793834028.testnet`. The OutLayer request used the pinned WASM with limits of 5,000,000 instructions, 16 MB, and 30 seconds. The previous 10-second cap was raised because the successful NEAR AI job took 11,958 ms. Request 9386 used 959,649 instructions, returned 1,316 bytes, charged `2195800000000000000000` yoctoNEAR (0.0021958 NEAR), and refunded `3997804700000000000000000` yoctoNEAR (3.9978047 NEAR) from the 4.0000005 NEAR payment.

The pending result was Reject with reason: “The 80 NEAR venue rental exceeds the 50 NEAR spending limit.” Its deadline was `1793842075775960287`. The cast was submitted after that deadline and succeeded with 300 Tgas in tx `4zaanaeJ3ppVp4899FYWjiVqg7C51k2AGubpY2j8RWwG`. Final RPC views show `proposal 63` has `briefvoter-1793834028.testnet: Reject`, the voter result is `status: Cast` and `cast: true`, and `get_pending(63)` is `null`. The DAO proposal remains `InProgress` because the single Reject vote has weight 1 of total supply 13. The vote was recorded, but the proposal was not executed.

For D2, the controller changed the on-chain brief hash to `748ecae07ec5dd816c22e3571242859871a2dcc4f70ed1b3954dba6f6d63435d` without changing the OutLayer secret. Request 9384 logged `ERR_BRIEF_HASH_MISMATCH`. The job returned `null`, so the callback also failed with `ERR_AGENT_OUTPUT`; `get_pending(60)` was `null`. The original hash `648ecae07ec5dd816c22e3571242859871a2dcc4f70ed1b3954dba6f6d63435d` was restored, and is the final on-chain value.

The NEAR AI API key was not printed or placed in the WASM or call arguments. Credential files under `/home/ubuntu/near-spike/secrets` are mode 600. No commits or pushes were made.

## Failed attempts and superseded runs

- The earlier callback guard required predecessor `outlayer.testnet`. OutLayer's callback predecessor was the voter contract, so the previous D1 attempt failed `ERR_WRONG_PREDECESSOR` and stored no pending vote. The user corrected the guard to the standard `#[private]` pattern used in the final implementation.
- An earlier D2 attempt set the brief hash to zero in tx `6uzndLfJNowZeoPCvLxCE7wRGbLYcHaGgKqzqKk8gyj7` and restored it in `Bb9VCkx1SRVYdcXTqqJHZVbcENFW5sELkEQk6uesjiAh`. The old callback parser failed on OutLayer's `null` output with `invalid type: null, expected a sequence at line 1 column 4`. The final D2 run used a distinct mismatched hash and demonstrated the job's `ERR_BRIEF_HASH_MISMATCH`.
- The first Transfer attempt was proposal 59, added in tx `7q9Uy9WTbAkYfCcCqdzacpuHAAiJ1wYkmKycFYHNdZmM`. Its request tx `34vLouRFJq1u1J5mhSnJgdrpoCbmLJjjz7LHnmnnD6N4` produced a Reject. Cast tx `FC6Fqe7nNSbF4dQHYQ3rjmDZDRWhXZJJH2F1mcamdty3` failed with `ERR_PERMISSION_DENIED` when voter weight was zero. After weight was registered, retry tx `5jUpXTEkNh4WXeH9jxUHPupiLhHk1S8prkRHhyiPaLsR` still failed because `players` had no Transfer permission. The final run temporarily added that permission and restored the original policy afterward.
- Proposal 61 was an earlier FunctionCall fallback with a venue-spend description and a harmless `get_policy` action. It received a bound Reject and cast successfully in tx `69AZpzb2DVLcEkbC7pZzaxMznwAMXKtHJshV3EckA35F`, but it was not a Transfer proposal. The final D1 result uses proposal 63, a real 80 NEAR Transfer.
- A first post-deadline cast attempt for proposal 63 with 100 Tgas returned `Exceeded the prepaid gas.` without a transaction ID. No matching voter transaction appeared in the scanned final testnet blocks around the attempt. The owner access-key nonce was refreshed from final state, then the cast was retried with 300 Tgas and succeeded in tx `4zaanaeJ3ppVp4899FYWjiVqg7C51k2AGubpY2j8RWwG`.
- Agent-key calls to `on_agent_result` and `pin_agent_wasm` were rejected before inclusion with `Transaction method name <on_agent_result> isn't allowed by the access key.` and `Transaction method name <pin_agent_wasm> isn't allowed by the access key.` respectively. These expected access-control rejections have no transaction hashes.
