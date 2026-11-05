# NEAR AI model CVM measurement match (fix 5), checked 2026-11-05

Attestation: seats-spikes/tee-quote/raw.json, model_attestations[0], model deepseek-ai/DeepSeek-V4.1-Flash-1017, signer 0xfe0071895500a9755c18044948ab4f4e1a7f337e.

| Field | Live quote | Public reproduction | Match |
|---|---|---|---|
| os_image_hash | 91fd5d69ccee3e5ea4f2aeb8c9b632c4358c4ecfc29ba1aa6fb1e402af209829 | sha256(sha256sum.txt) of dstack-nvidia-0.5.12.tar.gz from github.com/Dstack-TEE/meta-dstack/releases/tag/v0.5.12, and listed in that release's OS image hash table | yes |
| MRTD | df4d77c857de652bd0fafa343a2026b51071ee03773d076d283abf1a7d36ff91ffa279ee4a617ac664f7e2a2c8d5891b | dstack-mr measure (Dstack-TEE/dstack, dstack-mr v0.6.3) | yes |
| RTMR0 | bc122d143ab768565ba5c3774ff5f03a63c89a4df7c1f5ea38d3bd173409d14f8cbdcc36d40e703cccb996a9d9687590 | same | yes |
| RTMR1 | 4ae609807c765916a31d724786ed74bcb97e168a9d937b04936aeef2015c907eba5ac352c6bcd749c246fd62ffb659ec | same | yes |
| RTMR2 | bd67ab7554dc27ab03a077bc1447a1a67d0624ff547c4c809a8626f12d6a89712f8ec60e781e99b98208574065d21a71 | same | yes |
| RTMR3 / compose | compose_hash ae66f844658a7aee331dcb9fb59bd40323d71d192d37719e022cc4af8389265b | sha256(app_compose) and 10-event RTMR3 replay (earlier spike) | yes |
| compose-manager image | nearaidev/compose-manager@sha256:6e035c8fb99c1d31f41760d25af178683a658cca4afd73cd0d366fbb5bf884be | GitHub SLSA provenance: nearai/compose-manager commit f91a204549b64218a92c9bada84f8129de3c1f45, .github/workflows/build.yml, run 29635749941 | yes |

dstack-mr command (vm_config from the quote: cpu 64, memory 2199023255552, pci_hole64_size 1125899906842624, 8 GPUs, 4 NVSwitches, hotplug_off, qemu 9.2.1, ovmf pre202505 from image metadata):

    dstack-mr measure img/dstack-nvidia-0.5.12/metadata.json --cpu 64 --memory 2048G --pci-hole64-size 1125899906842624 --num-gpus 8 --num-nvswitches 4 --hotplug-off true --qemu-version 9.2.1 --json

Image file hashes: bzImage 400428f0..., ovmf.fd 983aa76e..., initramfs.cpio.gz 0037a55e..., metadata.json a29b7b4b... (all match sha256sum.txt).

## Remaining gap
The measured compose pins compose-manager and its launcher, not the inference engine or inference-proxy that holds the signing key. compose-manager checks out tagged compose files from github.com/nearai/cvm-compose-files at runtime (GITHUB_REPO env in the measured compose). The model app_compose contains no inference-proxy, vLLM or SGLang service, and RTMR3 has no events after system-ready. So the hardware measurement proves the public dstack OS and NEAR AI's attested launcher, but not which model-serving containers were running. The launcher image (079a14b4...) had no GitHub attestation found under nearai/compose-manager.

kms.near on mainnet does not expose the near-kms view methods (MethodNotFound), so no on-chain allowlist was matched.
