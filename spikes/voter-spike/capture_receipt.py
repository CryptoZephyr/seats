import hashlib
import json
import os
import secrets
import sys
import time
from pathlib import Path

import requests
from eth_account import Account
from eth_account.messages import encode_defunct


BASE_URL = "https://cloud-api.near.ai/v1"
MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017"


def main():
    if len(sys.argv) not in (2, 3) or not sys.argv[1].isdigit():
        raise SystemExit("usage: python capture_receipt.py <proposal_id> [output_path]")
    proposal_id = int(sys.argv[1])
    api_key = os.environ.get("NEAR_AI_API_KEY")
    if not api_key:
        raise SystemExit("NEAR_AI_API_KEY is missing from the environment")
    headers = {"Authorization": f"Bearer {api_key}"}

    nonce = secrets.token_hex(32)
    report_response = requests.get(
        f"{BASE_URL}/attestation/report",
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
            and item.get("signing_address")
        ),
        None,
    )
    if not attestation:
        raise RuntimeError("fresh ECDSA model attestation was not returned")
    attested_signer = attestation["signing_address"].lower()

    system_prompt = (
        "You are a club member's voting delegate. Member brief: back community events; "
        "reject any spend over 50 NEAR. Reply with only JSON "
        "{\"proposal_id\":<id>,\"vote\":\"approve|reject\",\"reason\":\"one sentence\"}."
    )
    user_prompt = (
        f"Proposal {proposal_id}: Pay 80 NEAR to rent a venue for the November meetup."
    )
    request_body = json.dumps(
        {
            "model": MODEL,
            "max_tokens": 400,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
        separators=(",", ":"),
    ).encode("utf-8")
    request_hash = hashlib.sha256(request_body).hexdigest()
    completion_response = requests.post(
        f"{BASE_URL}/chat/completions",
        data=request_body,
        headers={
            **headers,
            "Content-Type": "application/json",
            "x-no-aliasing": "true",
            "Accept-Encoding": "identity",
        },
        timeout=120,
    )
    completion_response.raise_for_status()
    response_bytes = completion_response.content
    response_body = response_bytes.decode("utf-8")
    completion = json.loads(response_bytes)
    chat_id = completion["id"]
    response_hash = hashlib.sha256(response_bytes).hexdigest()
    expected_text = f"{MODEL}:{request_hash}:{response_hash}"

    signature_response = None
    for _ in range(6):
        signature_response = requests.get(
            f"{BASE_URL}/signature/{chat_id}",
            params={"signing_algo": "ecdsa", "model": MODEL},
            headers={**headers, "Accept": "application/json"},
            timeout=60,
        )
        if signature_response.status_code != 404:
            break
        time.sleep(3)
    signature_response.raise_for_status()
    signed_receipt = signature_response.json()
    if signed_receipt.get("text") != expected_text:
        raise RuntimeError("NEAR AI signature text does not match exact request/response bytes")
    recovered_signer = Account.recover_message(
        encode_defunct(text=expected_text),
        signature=signed_receipt["signature"],
    ).lower()
    if recovered_signer != attested_signer:
        raise RuntimeError("recovered signer does not match the fresh attestation signer")
    if response_body.encode("utf-8") != response_bytes:
        raise RuntimeError("response body did not round-trip as UTF-8 bytes")

    fixture = {
        "model": MODEL,
        "proposal_id": proposal_id,
        "request_hash": request_hash,
        "response_hash": response_hash,
        "response_body_bytes": len(response_bytes),
        "response_body": response_body,
        "signature": signed_receipt["signature"],
        "signing_address": attested_signer,
        "recovered_address": recovered_signer,
        "request_body": request_body.decode("utf-8"),
    }
    fixture_path = (
        Path(sys.argv[2])
        if len(sys.argv) == 3
        else Path(__file__).parent / "tests" / "fixtures" / "nearai_receipt.json"
    )
    fixture_path.parent.mkdir(parents=True, exist_ok=True)
    fixture_path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "proposal_id": proposal_id,
                "model": MODEL,
                "request_hash": request_hash,
                "response_hash": response_hash,
                "response_body_bytes": len(response_bytes),
                "signing_address": attested_signer,
                "signature_verified": True,
                "fixture_path": str(fixture_path),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
