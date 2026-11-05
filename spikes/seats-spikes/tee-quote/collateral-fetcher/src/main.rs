use dcap_qvl::{
    collateral::{CollateralClient, INTEL_PCS_URL},
    verify,
};
use std::{fs, time::SystemTime};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let quote_hex = fs::read_to_string("../model.quote.hex")?;
    let quote = hex::decode(quote_hex.trim())?;
    let client = CollateralClient::with_default_http(INTEL_PCS_URL)?;
    let collateral = client.fetch(&quote).await?;
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_secs();
    let report = verify::verify(&quote, &collateral, now)?;
    let report_data = report.report.as_td10().ok_or("quote is not TDX")?.report_data;
    let signer = format!("0x{}", hex::encode(&report_data[..20]));
    fs::write("../collateral.json", serde_json::to_vec_pretty(&collateral)?)?;
    println!(
        "status={} advisories={} signer={} collateral_bytes={}",
        report.status,
        report.advisory_ids.len(),
        signer,
        fs::metadata("../collateral.json")?.len()
    );
    Ok(())
}
