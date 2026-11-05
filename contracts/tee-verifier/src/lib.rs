use dcap_qvl::QuoteCollateralV3;
use near_sdk::{env, near, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct QuoteVerifierContract {
    model_signer: Option<String>,
}

#[near]
impl QuoteVerifierContract {
    #[init]
    pub fn new() -> Self {
        Self { model_signer: None }
    }

    pub fn register_model_signer(
        &mut self,
        quote_hex: String,
        collateral_json: String,
        nonce: String,
    ) -> String {
        let quote_hex = quote_hex.strip_prefix("0x").unwrap_or(&quote_hex);
        let quote = hex::decode(quote_hex).expect("ERR_QUOTE_HEX");
        let collateral: QuoteCollateralV3 =
            serde_json::from_str(&collateral_json).expect("ERR_COLLATERAL_JSON");
        let nonce_hex = nonce.strip_prefix("0x").unwrap_or(&nonce);
        let nonce = hex::decode(nonce_hex).expect("ERR_NONCE_HEX");
        assert_eq!(nonce.len(), 32, "ERR_NONCE_LENGTH");

        let report = dcap_qvl::verify::verify(
            &quote,
            &collateral,
            env::block_timestamp() / 1_000_000_000,
        )
        .expect("ERR_QUOTE_VERIFY");
        assert_eq!(report.status, "UpToDate", "ERR_TCB_STATUS");
        assert!(report.advisory_ids.is_empty(), "ERR_TCB_ADVISORIES");
        let report_data = report
            .report
            .as_td10()
            .expect("ERR_NOT_TDX")
            .report_data;
        assert_eq!(&report_data[32..], nonce.as_slice(), "ERR_NONCE_MISMATCH");
        let signer = format!("0x{}", hex::encode(&report_data[..20]));
        self.model_signer = Some(signer.clone());
        signer
    }

    pub fn get_model_signer(&self) -> Option<String> {
        self.model_signer.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const FIXTURE: &str = include_str!("../tests/fixtures/register_args.json");
    const EXPECTED_SIGNER: &str = "0xfe0071895500a9755c18044948ab4f4e1a7f337e";

    fn set_context() {
        let verifier: near_sdk::AccountId = "verifier.testnet".parse().unwrap();
        let context = VMContextBuilder::new()
            .current_account_id(verifier.clone())
            .predecessor_account_id(verifier)
            .block_timestamp(1_793_835_136_000_000_000)
            .build();
        testing_env!(context);
    }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    #[test]
    fn captured_quote_verifies_and_stores_signer() {
        set_context();
        let args = fixture();
        let mut contract = QuoteVerifierContract::new();

        let signer = contract.register_model_signer(
            args["quote_hex"].as_str().unwrap().to_string(),
            args["collateral_json"].as_str().unwrap().to_string(),
            args["nonce"].as_str().unwrap().to_string(),
        );

        assert_eq!(signer, EXPECTED_SIGNER);
        assert_eq!(contract.get_model_signer().as_deref(), Some(EXPECTED_SIGNER));
    }

    #[test]
    fn flipped_quote_byte_fails_verification() {
        set_context();
        let args = fixture();
        let mut quote = hex::decode(args["quote_hex"].as_str().unwrap()).unwrap();
        quote[100] ^= 1;
        let mut contract = QuoteVerifierContract::new();

        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.register_model_signer(
                hex::encode(quote),
                args["collateral_json"].as_str().unwrap().to_string(),
                args["nonce"].as_str().unwrap().to_string(),
            );
        }));

        assert!(result.is_err());
    }
}
