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
