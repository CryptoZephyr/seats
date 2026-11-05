# OutLayer vault

Final status: C1 holder encryption and decryption passed, C2 non-holder rejection passed, and the C3 buyer decrypted the vault text. C3 seller rejection did not pass because the seller still owns a second token, `bad-admin`.

| Check | Result | Evidence |
|---|---|---|
| WASI job and public release | PASS | 689,499 bytes, SHA-256 `5a4b90b80d23ce077814c77e720c1e324e18fd32bdb4535fcce7573e24a6ef4e`, release `vault-check-v0.1.0`. |
| C1 holder | PASS | Original run decrypted to the sample text. Minimized run succeeded at 5M instructions, 16 MB, 10 seconds, and charged 0.0014126004 NEAR. |
| C2 non-holder | PASS | Returned `{"error":"ERR_NO_SEAT"}`. Charge was 0.0015611 NEAR. |
| C3 buyer after resale | PASS | Fresh-key run returned ciphertext that decrypted to `Seats test vault: meetup venue code 4417`. Charge was 0.0014376004 NEAR, 4,376 ms. |
| C3 seller after resale | FAIL, test precondition | Seller still owns token `bad-admin`, so the job correctly returned success instead of `ERR_NO_SEAT`. |
| OutLayer pricing | PASS | Testnet pricing, estimates, and limits are recorded below. |

The previous report mislabeled yoctoNEAR values as NEAR. NEAR is `10^24` yoctoNEAR, so historical C1's `1,408,700,400,000,000,000,000` yoctoNEAR charge is 0.0014087004 NEAR, not 1.4087004 NEAR. C2's charge is 0.0015611 NEAR. The apparent 1.4 NEAR run cost was a unit-conversion error.

| Run | Transaction | Request | Used instructions / time | Charged | Refunded |
|---|---|---:|---:|---:|---:|
| C1 historical | `2kcZL8DTk7fNRGEWseJAZUagXWuzuLNm93cxFU3vCvo8` | 9364 | not recorded / 4,087 ms | 0.0014087004 NEAR | 0.0005913996 NEAR |
| C2 | `BZW5uUebDMbTJB5ctTjhue18cWAEwxwSWa4fgroerdZy` | 9365 | 131,018 / 4,074 ms | 0.0015611 NEAR | 0.000439 NEAR |
| C1 minimized | `9s3NpEXTXatJDfjrDBrYdiYQrjQAyokpVT9EosY2Apue` | 9373 | 4,553,520 / 4,126 ms | 0.0014126004 NEAR | 0.0005874001 NEAR |
| C3 seller | `413mL38EP2HnUcMbbPFVhZnA8DKF916EjN48iZgE6a2C` | 9371 | 4,550,852 / 4,498 ms | 0.0014498004 NEAR | 0.0005502996 NEAR |
| C3 buyer initial | `452iN2bENivFEJUXvSSgPQ3TBsU2Vk7s2YsF2rMyyU9z` | 9372 | 4,534,868 / 4,482 ms | 0.0014482004 NEAR | 0.0005518996 NEAR |
| C3 buyer decryptable | `3c1kEYVGrARoxJDbgTN6we5uSowLwjbCbzhez1VWX3ae` | 9374 | 4,534,184 / 4,376 ms | 0.0014376004 NEAR | 0.0005624996 NEAR |

Testnet `get_pricing` returned base fee `1000000000000000000000` yoctoNEAR, per-million-instructions fee `100000000000000`, and per-ms fee `100000000000000000`. `get_max_limits` returned 500 billion instructions, 180 seconds, and 300 compile seconds. `estimate_execution_cost` returned 0.0070001 NEAR for 1B instructions / 128 MB / 60 seconds, 0.0040001 NEAR for 30 seconds, and 0.0020001 NEAR for 10 seconds. For 5M instructions / 16 MB / 10 seconds, the estimate was 0.0020000005 NEAR. The minimized run used the smallest limits tested, not a proof that lower limits cannot work.

The C3 buyer decryption key is stored mode 0600 at `/home/ubuntu/near-spike/secrets/outlayer-requester-c3.hex`. The seller's remaining `bad-admin` token is the reason C3 cannot prove non-holder behavior for that seller account. C1/C2/C3 raw transaction evidence is in `raw.json`.

## Failed attempts

- The initial project used `vault-check.wasm`, but the actual release asset was `vault_check.wasm`. The corrected project used the underscore path.
- An initial minimized C1 deposit was short by 500,000,000,000 yoctoNEAR. The exact error was `Insufficient payment: required 2000000500000000000000 yoctoNEAR ... got 2000000000500000000000 yoctoNEAR`. Retrying with the corrected deposit and fresh CLI nonce succeeded.
- The first C3 buyer run used an all-zero requester public key and was not decryptable. A fresh X25519 key and testnet run produced decryptable output.
