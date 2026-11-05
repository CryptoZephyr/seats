# Seat-voter v2 testnet results

All transactions in this run used NEAR testnet. The original v1 report and raw evidence were left unchanged. Transaction receipts, RPC views, final account state, and raw NEAR AI response/signature evidence are recorded in `raw-v2.json`. No private key or API key is included.

## Summary

| Check | Result | Evidence |
|---|---|---|
| Deadline guard and receipt-verification unit tests | PASS | `cargo test`: 11 passed. |
| Global contract deployment by code hash | PASS | Transaction `7fFtxQtZpFGXSJmDXp3XpU2XZWF1Dqp57ekDifTSk1Uc`. |
| Two fresh global-backed voter accounts initialized | PASS | Both `UseGlobalContract` and `new` calls finalized. |
| Weight 1 on voter A | PASS | `delegation_balance_of` is `1`; DAO supply increased from 11 to 12. |
| Fresh NEAR AI receipt verified off-chain and on-chain | PASS | Proposal 53 receipt signer matched the fresh attestation signer; voter contract accepted it and stored Reject. |
| Tampered body and receipt replay rejected | PASS | Fresh-proposal tamper returned `ERR_WRONG_SIGNER`; reuse returned `ERR_RECEIPT_USED`. |
| Override inside window | PASS | Controller changed the pending vote to Approve and back to Reject before deadline. |
| Override and cancel after deadline | PASS | Both failed with `ERR_WINDOW_CLOSED`. |
| Public cast after deadline | PASS | DAO recorded Reject under voter A. Proposal 53 remains `InProgress`, since the seat has weight 1. |
| FullAccess key removed | PASS | Final key list contains only the `submit_pending` FunctionCall key. |

## Contract and WASM

`override_vote` and `cancel` now require `block_timestamp < pending.deadline`, and panic with `ERR_WINDOW_CLOSED` at or after the deadline. The `cast` early-window guard continues to panic with `ERR_TOO_EARLY`.

The receipt verification implementation stores the configured model signer and model, verifies the EIP-191 signed text with `env::ecrecover`, rejects reused receipt IDs, parses the signed JSON answer, and stores the signed vote and reason. Admin-only `set_model_signer` was used for this test.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| v1 optimized WASM | 191,236 | `6b9294a50cd3f13f19d7e99414211c2bc649d12f085f7d390f28f54ea20c14d4` |
| v2 raw WASM before cargo-near optimization | 247,518 | - |
| v2 optimized WASM | 205,581 | `34e071162894fb6966f55ae5e71b541b21d049757bd9d97746474c9985bcca89` |

The optimized v2 WASM is 14,345 bytes, or about 7.5%, larger than v1. Standalone `wasm-opt` was unavailable. `cargo near build` used its bundled optimizer.

## Global deployment and account storage

The first deploy-by-hash transaction was included but its deployment receipt failed with `LackBalanceForState`, requiring 20.5581 NEAR for storage. It burned 0.0016376943647419 NEAR in fees. After faucet-funded testnet transfers, deployment succeeded.

| Transaction | Hash | Outcome | Gas burnt | Tokens burnt |
|---|---|---|---:|---:|
| Initial global deploy attempt | `6oAjA73A6xTe8LSdgHjwf8G4Vuqa2UYZUhFtyJPbW6yw` | Included, deployment receipt failed for insufficient storage balance | 16,600,126,209,919 | 0.0016376943647419 NEAR |
| Successful deploy-by-hash | `7fFtxQtZpFGXSJmDXp3XpU2XZWF1Dqp57ekDifTSk1Uc` | Success | 16,600,126,209,919 | 20.5597376943647419 NEAR total debit |
| Voter A faucet transfer to deployer, 9 NEAR | `HVzsTwnb6Y7CS3ZJh9cUWhhsYH7ZwAqrAUhjuvq65bUp` | Final | 669,547,687,500 | 0.0000446365125 NEAR |
| Voter B faucet transfer to deployer, 2 NEAR | `6df2mF3awrfSoeMUkvGHxb6eSveHehAijJHumnT1TYnk` | Final | 669,547,687,500 | 0.0000446365125 NEAR |

The successful deployment reduced the deployer balance from 20.9983623056352581 NEAR to 0.4386246112705162 NEAR. The total debit was 20.5597376943647419 NEAR, including a 20.5581 NEAR storage charge and 0.0016376943647419 NEAR in gas fees. The deployment receipt was `3gWYDRvFHDDfu66yeyzzHzn7pMPx3pFscmMFsJg8y5tF`, which succeeded.

| Account | UseGlobalContract transaction | `new` transaction | Storage after init | Estimated reserve at 10^19 yocto/byte | Account `locked` field |
|---|---|---|---:|---:|---:|
| `seatvoter-v2a-1793831906.testnet` | `9tXwQUaBkX7je4cMA9wmT4fMvSJNSpEsm3sT4DUnjxmX`, Success | `Ag48LkidnryA4HviAS81bZ6pNQU7k9QYwwiLgSgng1pu`, Success | 433 bytes | 0.00433 NEAR | 0 |
| `seatvoter-v2b-1793831906.testnet` | `F5DKdkA71ioGEmFkmejkXcGHAf2XfCJ4DsV7WDr5Xt4p`, Success | `fHDFFv46me7jxeoU9z5fSUAkm7TWrPfUcB2LHyjTXG9`, Success | 433 bytes | 0.00433 NEAR | 0 |

Both accounts selected the shared code hash `4ZQhU4fA6uAmWv4jMQ6vqQPpxqJszxaqSN9WB672w8mN` with `UseGlobalContract`, then initialized with the DAO, admin, seller controller, and 60-second window. The v1 baseline was 192,886 bytes, an estimated 1.92886 NEAR at the same storage rate. The global-backed initialized state uses about 445 times less storage. After voter A's vote and receipt state were stored, its final usage was 944 bytes, with an estimated reserve of 0.00944 NEAR.

One extra deterministic account, `0s52e3b2e8c3950dbad352754791fbde35cbf264ee`, was created by an exploratory `near contract state-init` invocation. It has zero balance, 132 bytes of storage, and no access keys. The transaction `Azs1Z26snV1awvv98QhsG3ZTUCWLBdnHtynswdSLeQN8` succeeded and burned 0.0070946119 NEAR, including its storage charge. It was not initialized or used as a voter, and was not deleted. The two intended voters were then configured directly with `UseGlobalContract` and both initialized successfully.

## Voter A DAO and receipt test

Fresh FunctionCall proposal 53 was created on `dao.zspike-1793094130.testnet` for race leg 1000. The model returned Reject for the 80 NEAR venue proposal, matching the member brief. The 926-byte response and signature are preserved in `tests/fixtures/nearai_receipt_v2.json`; the existing proposal-52 unit-test fixture remains unchanged. The freshly attested signing address and off-chain recovered address both were `0xfe0071895500a9755c18044948ab4f4e1a7f337e`.

| Action | Transaction hash | Outcome | Gas burnt | Tokens burnt |
|---|---|---|---:|---:|
| Add `submit_pending` FunctionCall key | `Hx7DSH67nzwJ5NskjnbKgFcPBeFzpnbif8E6fBjNm24c` | Success | 643,794,572,430 | 0.000042061200993 NEAR |
| Register voter A | `vnu5kU9CXmXaHsPmJPKjRLSXj5cQMYSRZJrso1xDhG5` | Success | 4,170,687,140,860 | 0.000372432201586 NEAR |
| Add weight 1 | `6MbPme3Ui5pgJEcctnRJV5Mwo9ReZhhfU4JwajQUXxr1` | Success | 4,280,107,905,464 | 0.0003833742780464 NEAR |
| Create receipt proposal 53 | `76VwjEma88m83v8kymNF1qoLHLEUd8DspSALWRbp3myo` | Success | 2,705,961,051,965 | 0.0002482778489465 NEAR |
| Set model signer | `DJaGnRNCqjjn3Gj5jSZA3BTddsWJF3BdqogcNTBN8Hws` | Success | 1,920,081,114,945 | 0.0001696898552445 NEAR |
| Create replay-target proposal 54 | `3RJr15RjN4suNjnHg8pJbBetMJhPZpz9hZgPHbACWzTM` | Success | 2,704,703,327,698 | 0.0002481520765198 NEAR |
| Submit valid receipt with full response body | `6GDEWgg8cU1CHM6xvWp6FKWj8PmiFCF41WVtnKZqn1gV` | Success, pending vote Reject | 3,184,303,868,255 | 0.0002961121305755 NEAR |
| Tamper body on proposal 53 | `AhDYhaNwqBFq3gzTmwEdEwLuhXVD3oEyAxsB54tdkiP5` | `ERR_PENDING_EXISTS`, pending-entry guard ran first | 2,038,674,251,032 | 0.0001815491688532 NEAR |
| Tamper body on fresh proposal 54 | `FpKa9U9jatwirjfS8YEU52j1e7ajVSx4HwGF1idRuEH2` | `ERR_WRONG_SIGNER` | 2,511,101,209,476 | 0.0002287918646976 NEAR |
| Reuse receipt on proposal 54 | `913YBqstnG7trZDTdpiX6sG4wy3YHbhgQTbXqZFXtLME` | `ERR_RECEIPT_USED` | 2,507,225,007,492 | 0.0002284042444992 NEAR |
| Override inside window to Approve | `6SPJxsASfJKEheK3Nqq3VzAMqe7b5PVZZxhDL2BRzcVi` | Success | 2,196,453,088,021 | 0.0001973270525521 NEAR |
| Restore Reject inside window | `7eLzAXNtf5hPwzgmi71Es33zmTDGFi71i7aYz9qTrDtq` | Success | 2,196,435,071,595 | 0.0001973252509095 NEAR |
| Override after deadline | `4sdzgwzy3fJyBxVdyVburnr5bdfpyvfXmE1iqkEAg4ao` | `ERR_WINDOW_CLOSED` | 1,906,860,044,659 | 0.0001683677482159 NEAR |
| Cancel after deadline | `AsjUvEdSkVTn59cuiP9rcvQz3SvZefxii4s2BvKcxfQ9` | `ERR_WINDOW_CLOSED` | 1,903,688,744,365 | 0.0001680506181865 NEAR |
| Public cast after deadline | `8BP71XawShwwpgW9FXcnb765Zf4ae2TUtT9FSmHpjH4s` | Success | 8,318,583,233,867 | 0.0007649035546367 NEAR |
| Delete voter A FullAccess key | `A7cMJ6AR9Xfdh5VUk2CAHszLzYHkMFwHfo1Pmh7JLTmB` | Success | 629,194,812,500 | 0.000040601225 NEAR |

The valid full-body submission used 3.184 Tgas and stored receipt hash `22ee6c5d01672d28422dfcdf2d3eb9cd840e6d0390f604894f9889d70ff9033e`. The pending view stored Reject and the model's reason. On finality, proposal 53 was `InProgress` with `seatvoter-v2a-1793831906.testnet: Reject`; its player vote counts were `["0", "1", "0"]`. The contract's final controller remained the seller. The final voter access-key list contains one FunctionCall key restricted to `submit_pending`, with 0.2490651425913745 NEAR allowance remaining.

The first tamper attempt targeted proposal 53 after its valid pending entry existed, so the contract returned `ERR_PENDING_EXISTS` before checking the changed signature. The follow-up used fresh proposal 54 and returned `ERR_WRONG_SIGNER`, confirming the tampered response was rejected by signature verification. Reuse of the valid receipt on proposal 54 returned `ERR_RECEIPT_USED`.

Final voter A balance was 0.9916215080911718 NEAR. The owner ended at 0.4165319501563286 NEAR, above the required 0.3 NEAR floor. Voter A's final storage usage was 944 bytes. Voter B remained at 433 bytes with delegation weight 0.

The receipt capture script initially ran under system Python, which lacked `eth_account`. It then ran successfully with the existing `/home/ubuntu/near-research/.venv-ai` environment. The NEAR AI API key was present and was never printed or saved.

No Git operations, commits, pushes, mainnet transactions, or private-key disclosures occurred. Key files remained under `/home/ubuntu/near-spike/secrets` with mode 0600.
