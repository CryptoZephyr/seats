# NEAR AI hardware quote

Final status: PASS for TDX verification and on-chain signer registration. GPU evidence passed. Measurement matching is partial.

| Check | Result | Final evidence |
|---|---|---|
| Fresh TDX quote and nonce | PASS | The 5,006-byte quote has 10,012 hex characters. Its 64-byte `report_data` is signer `0xfe0071895500a9755c18044948ab4f4e1a7f337e`, 12 zero bytes, then nonce `ace2d81259b901daa92f9630b4019a094fe64407a7070cf3d6047ada3859dad0`. |
| Intel PCS collateral and quote verification | PASS | `dcap-qvl` 0.7.1 fetched 24,241 bytes of collateral from Intel PCS and verified status `UpToDate`, with no advisories. |
| NVIDIA NRAS | PASS | HTTP 200, nonce matched, eight GPU attestations, overall verdict true. |
| Measurements | PARTIAL | Compose hash matched `app_compose` and MRCONFIGID. RTMR3 replay matched 10 IMR events. |
| Verifier WASM and deployment | PASS | 821,107 bytes, SHA-256 `202e1279749dfb8f1ca2ef19ae294c4ddb7ae1a8bc5b1cf96dee4836bf9cca7a`. Deployment tx `9FUnUf24V8kQBMHYgk9eLzjcQwyy6JPHUvTv1VpjKZBH`, 5.9 Tgas and 0.0005887026419893 NEAR fee. |
| On-chain `register_model_signer` | PASS | Tx `96cMLVe7VoSAjrk3eFRG2RK1ZiDvMoQZr8dj2bExzytQ`. Total receipt gas was 118.017122947281 Tgas, below the 300 Tgas ceiling. The return value and finality view both equal the attested signing address. |
| Stored signer match | PASS | `get_model_signer` at finality block 276269246 returned `0xfe0071895500a9755c18044948ab4f4e1a7f337e`. |

The verifier account is `tdxv-1793838446.testnet`. Its constructor call was tx `5yTZf5Fvt9w9QkYj9gfZ4zEyAHZ55Q8iUdcawUwu9bbz`. The registration transaction used a 300 Tgas limit. The receipts used 0.38949221628 Tgas for the transaction outcome, 117.404448168501 Tgas for quote verification and storage, and 0.2231825625 Tgas for the final receipt.

The Intel collateral bundle is in `collateral.json`, and the exact registration arguments are in `register_args.json`. `raw.json` retains the fresh API response and NRAS evidence. NRAS response SHA-256 is `66838c3472a8d3282423da3f6005bfc97befa817bfb4f21bc11c3c17d0068e4a`.

## Failed attempts

- An earlier strict-policy verification returned `Dynamic platform is not allowed by policy`. The non-strict verification accepted the quote as `UpToDate` with no advisories.
- Building the collateral-fetch helper inside the contract package initially hit near-sdk's native-target guard. Moving the helper into a separate native-only crate resolved that issue. No testnet transaction was sent for the failed helper build.
