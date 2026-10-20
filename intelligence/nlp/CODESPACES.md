# GitHub Codespaces: three real BERT classifiers on cloud CPU

**Scope:** one GitHub Codespace used for a bounded proof-of-concept of the
exact pretrained `ElKulako/cryptobert`,
`StephanAkkerman/FinTwitBERT-sentiment` and
`seara/rubert-tiny2-russian-sentiment` weights. This is **not** a free,
permanent production host. No Google/Groq/OpenRouter keys are required.
No X/TG logins, collector DSNs or private message bodies are copied.

## Step 1 — open the terminal inside your existing Codespace

From the repository root, run the following **once**:

```bash
gh pr checkout 142
bash intelligence/nlp/scripts/codespaces_setup.sh
```

This checks free disk, creates an isolated `.venv-sentiment`, installs
**CPU-only** PyTorch (no CUDA packages), installs the optional classifier
dependencies, downloads **only Safetensors/tokenizers/configs** for all three
models, records their exact immutable Hugging Face commit SHAs, enables
offline inference, and runs a true end-to-end 3-message forward-pass
smoke (EN X → CryptoBERT + FinTwitBERT; RU TG → RuBERT; EN TG → CryptoBERT).

Expect ~1.1 GB of model weights **plus** Python wheel/runtime/cache overhead.
The setup refuses to run outside a GitHub Codespace and checks for at
least 4 GiB of free disk before installing. It can take several minutes.
A reconnect or stop can interrupt downloads; rerunning the same script
reuses installed packages and cached weights. After all three weights are
downloaded, it keeps existing SHA pins rather than silently upgrading them.

**Successful output:** `ALL THREE exact-revision models passed real forward
inference on CPU.` Until you see this, neither model compatibility nor
Codespace RAM adequacy is confirmed.

Locally generated files (ignored by Git):

- `.venv-sentiment/` — isolated ML environment (no changes to collectors).
- `.local/sentiment/model-revisions.env` — exact 40-hex model revisions.
- `.local/sentiment/smoke-input.jsonl` — three synthetic example messages.
- `.local/sentiment/smoke-results.sqlite` — derived probabilities with no
  raw source text.
- `.local/sentiment/smoke-predictions.jsonl` — test predictions/provenance.

The Codespace environment is not your laptop SSD. Weight caches can disappear
if you delete/recreate the Codespace. GitHub Codespaces quotas and auto-stop
apply. The setup **does not start a background worker**.

## Step 2 — optional private API (second Codespace terminal)

After successful setup:

```bash
bash intelligence/nlp/scripts/codespaces_api.sh
```

The script generates a strong random API token in the ignored
`.local/sentiment/api-token` (mode 0600), requires the token on POST
requests, and opens a **single-worker, loopback-only** inference server at
`127.0.0.1:8765`. It uses the same three pinned local Safetensors weights.
It is not a hosted LLM and it does not run on the notebook CPU/GPU.

**Do not mark the Codespaces forwarded port Public.** It must remain
Private (GitHub-authorized access), in addition to the bearer token.
To verify from the **Codespaces terminal**, not from a public URL:

```bash
TOKEN="$(cat .local/sentiment/api-token)"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @.local/sentiment/api-request.json \
  http://127.0.0.1:8765/v1/sentiment/predict | python -m json.tool
```

Return values are model-specific probability maps with evidence identity
and content hashes, **never original text**. Wrong tokens receive HTTP
401, malformed sources HTTP 400, oversized requests HTTP 413. At most
eight messages and 64 KiB JSON can be sent per call. Only explicitly
supplied messages are processed; no provider API scraping. Model errors
are redacted rather than returning private text or cache paths.

This prototype is deliberately **single-request-at-a-time** to bound
memory and is not a public, hardened API for permanent collectors.
Stop it with Ctrl+C; close the Codespace to stop metered compute time.
To connect a collector from the laptop, first design a reviewed,
authenticated private tunnel (rather than exposing the port publicly).

## Problems and limits

- **Out of disk:** delete only disposable caches or resize/switch Codespace;
  never remove collector databases. No weight download should be attempted
  without at least 4 GiB available. Codespaces included storage can be
  smaller than the raw filesystem shown by `df`.
- **Out of RAM:** the existing controller enforces soft 3 GiB AI process
  / 3 GiB free-memory budgets, one model at a time, CPU `batch_size=1`.
  Two-vCPU Codespaces CPU inference can be slow. The limiter is not a
  guarantee against all memory allocation spikes.
- **Dependency/model failure:** save only the nonsecret traceback summary
  or failing package/model name when asking for help. Do **not** paste
  the generated `api-token`, GitHub tokens or private source records.
- **Long-term use:** Codespaces are intended for development, not
  unattended 24/7 inference. A proper cloud CPU server/managed endpoint
  will be a **separate deployment**, with independent credentials,
  monitoring, rate limits and access controls.
