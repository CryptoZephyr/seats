import hashlib
import json
import os
import secrets
import time
from pathlib import Path

import requests
from eth_account import Account
from eth_account.messages import encode_defunct


MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
PROPOSAL_ID = 55
DAO = "dao.zspike-1793094130.testnet"
BRIEF = "back community events; reject any spend over 50 NEAR"
BASE = "https://cloud-api.near.ai/v1"
API_KEY = os.environ.get("NEAR_AI_API_KEY")

if not API_KEY:
    raise SystemExit("NEAR_AI_API_KEY_MISSING")

headers = {"Authorization": f"Bearer {API_KEY}"}
nonce = secrets.token_hex(32)
report_response = requests.get(
    f"{BASE}/attestation/report",
    params={
        "model": MODEL,
        "provider": "near",
        "signing_algo": "ecdsa",
        "nonce": nonce,
    },
    headers=headers,
    timeout=60,
)
report_response.raise_for_status()
report = report_response.json()
attestations = report.get("model_attestations") or []
attestation = next(
    (
        item
        for item in attestations
        if item.get("signing_algo") == "ecdsa"
        and item.get("request_nonce") == nonce
    ),
    None,
)
if attestation is None:
    raise SystemExit("FRESH_ATTESTATION_NOT_FOUND")
signer = attestation.get("signing_address", "").lower()
if not signer.startswith("0x"):
    raise SystemExit("ATTESTATION_SIGNER_MISSING")

request_body = json.dumps(
    {
        "model": MODEL,
        "max_tokens": 400,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a club member's voting delegate. Member brief: "
                    f"{BRIEF}. Reply with only JSON "
                    '{"proposal_id":<id>,"vote":"approve|reject","reason":"one sentence"}.'
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Proposal {PROPOSAL_ID}: Pay 80 NEAR to rent a venue "
                    "for the November meetup."
                ),
            },
        ],
    },
    separators=(",", ":"),
).encode()
request_hash = hashlib.sha256(request_body).hexdigest()
response = requests.post(
    f"{BASE}/chat/completions",
    data=request_body,
    headers={
        **headers,
        "Content-Type": "application/json",
        "x-no-aliasing": "true",
        "Accept-Encoding": "identity",
    },
    timeout=120,
)
response.raise_for_status()
response_body = response.content
completion = json.loads(response_body)
content = completion["choices"][0]["message"]["content"]
answer = json.loads(content.strip())
if answer.get("proposal_id") != PROPOSAL_ID or answer.get("vote") != "reject":
    raise SystemExit("MODEL_ANSWER_NOT_EXPECTED_REJECT")
response_hash = hashlib.sha256(response_body).hexdigest()
signed_text = f"{MODEL}:{request_hash}:{response_hash}"
chat_id = completion["id"]
signature_url = f"{BASE}/signature/{chat_id}"
signature_response = None
for attempt in range(6):
    signature_response = requests.get(
        signature_url,
        params={"signing_algo": "ecdsa", "model": MODEL},
        headers={**headers, "Accept": "application/json"},
        timeout=60,
    )
    if signature_response.status_code != 404:
        break
    time.sleep(3)
signature_response.raise_for_status()
signature = signature_response.json()
if signature.get("text") != signed_text:
    raise SystemExit("SIGNATURE_TEXT_MISMATCH")
recovered = Account.recover_message(
    encode_defunct(text=signed_text), signature=signature["signature"]
).lower()
if recovered != signer or recovered != signature.get("signing_address", "").lower():
    raise SystemExit("RECOVERED_SIGNER_MISMATCH")

fixture = {
    "model": MODEL,
    "proposal_id": PROPOSAL_ID,
    "proposal_kind": {
        "Transfer": {
            "token_id": "",
            "receiver_id": "seatfunder-1793834028.testnet",
            "amount": "80000000000000000000000000",
            "msg": None,
        }
    },
    "request_hash": request_hash,
    "response_body": response_body.decode("utf-8"),
    "signature": signature["signature"],
    "signing_address": signer,
    "recovered_address": recovered,
    "signed_text": signed_text,
    "response_bytes": len(response_body),
    "nonce": nonce,
    "attestation_request_nonce": attestation["request_nonce"],
    "attestation_signing_address": signer,
    "attestation_intel_quote_sha256": hashlib.sha256(
        attestation.get("intel_quote", "").encode()
    ).hexdigest(),
}
output = Path(__file__).parent / "tests/fixtures/d1_receipt.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(fixture, indent=2) + "\n")
print(json.dumps({
    "attestation_http": report_response.status_code,
    "nonce_bound": attestation["request_nonce"] == nonce,
    "attestation_signer": signer,
    "completion_http": response.status_code,
    "response_bytes": len(response_body),
    "answer_vote": answer["vote"],
    "signature_http": signature_response.status_code,
    "recovered_signer_matches": recovered == signer,
    "fixture": str(output),
}, indent=2))
