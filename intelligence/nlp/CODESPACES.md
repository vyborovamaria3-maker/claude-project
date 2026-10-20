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
- **`ensurepip` or `No module named pip`:** Ubuntu may lack
  `python3.12-venv`, leaving a half-created `.venv-sentiment`. Run
  `sudo apt-get update && sudo apt-get install -y python3.12-venv`,
  then `python3.12 -m venv --clear .venv-sentiment` and rerun
  `bash intelligence/nlp/scripts/codespaces_setup.sh`. Updated setup
  scripts automatically rebuild a venv without pip after you install
  the missing system package.
- **Dependency/model failure:** save only the nonsecret traceback summary
  or failing package/model name when asking for help. Do **not** paste
  the generated `api-token`, GitHub tokens or private source records.
- **Long-term use:** Codespaces are intended for development, not
  unattended 24/7 inference. A proper cloud CPU server/managed endpoint
  will be a **separate deployment**, with independent credentials,
  monitoring, rate limits and access controls.

## Step 3 — verify the remote *client* inside Codespaces

Keep the private API server running in the first terminal. In another
Codespaces terminal, **after checking out the updated PR branch**:

```bash
git pull --ff-only
bash intelligence/nlp/scripts/codespaces_client_smoke.sh
```

This sends only the three synthetic Step 1 messages through the **new
remote client**, verifies the exact pinned source/model mappings and saves
derived probabilities to a separate SQLite file. The client does not import
PyTorch; the Codespace API process hosts the weights. Do not paste the
random `.local/sentiment/api-token` into a chat or shell history.

For an **explicitly authorized** subsequent connection from the laptop,
use a privately authenticated SSH / GitHub CLI port-forward to the Codespace
(not a Public Codespaces port), then set these locally on the client:

```bash
export SENTIMENT_REMOTE_ENABLED=true
export SENTIMENT_REMOTE_ENDPOINT=http://127.0.0.1:8765/v1/sentiment/predict
export SENTIMENT_REMOTE_TOKEN="<private value from the Codespace>"
export SENTIMENT_CRYPTOBERT_REVISION=9e37c910fe87727cb842a9ac55c6388256fe0f15
export SENTIMENT_FINTWITBERT_REVISION=da059da3b3bbcb43f9ed1aeb5ae61644010c7e1e
export SENTIMENT_RUBERT_REVISION=ad9be38671d4444945734cce7cdaadacc5002cc4
```

The endpoint is used **only if `SENTIMENT_REMOTE_ENABLED=true`**. Raw
message text is sent off-device at that point, so choose explicit sources
and obtain permission before sending real/private X/TG records. Existing
collectors and PG are not accessed by the client smoke. The client verifies
message IDs, timestamps, content hashes, model names, every pinned model
SHA, exact label sets and probability normalization. It refuses insecure
HTTP except local loopback, ignores redirect targets (no token forwarding),
uses short timeouts, and never echoes source text/API tokens in failures.

**Do not assume the forwarded private Codespaces HTTPS URL can be called
with only the inference API token.** Private forwarded ports separately
require GitHub authentication. Prefer a user-initiated, authenticated
GitHub Codespaces SSH tunnel; no tunnel is created by this PR. Sending
the unmodified API bearer in a browser-exposed public link is forbidden.
This integration does **not** automatically send real collector data,
activate an Intelligence worker, or connect an external LLM.

## Step 4 — Acer/Windows private-client smoke (no local PyTorch)

You have already verified the Codespaces API, token authentication and
`gh codespace ports forward 8765:8765` from Windows. In Windows PowerShell,
**not in Codespaces**, with the **private tunnel still open** in its separate
PowerShell window, switch the local repository clone to PR #142:

```powershell
Set-Location 'C:\\Users\\<YOUR-WINDOWS-USER>\\claude-project'
git status --short
gh pr checkout 142
git pull --ff-only
powershell -NoProfile -ExecutionPolicy Bypass -File .\\intelligence\\nlp\\scripts\\windows_remote_smoke.ps1
```

Review `git status --short` first; do **not** switch branches if you have
uncommitted work that could be overwritten. If the actual clone path differs
from the example, use the actual path. Windows paths may contain Cyrillic.

This single-purpose PowerShell script:

- requires local Python 3.11/3.12 and the GitHub CLI already authorized with
  `codespace` permission;
- checks the loopback `/healthz` endpoint on the existing *private* tunnel;
- uses `gh codespace ssh -c <CodespaceName> -- ...` to fetch the current
  bearer token into the process environment only; never prints or saves it;
- creates an isolated, **stdlib-only** `.venv-sentiment-client` Python
  environment. **No pip downloads, Torch, Transformers, local model weights,
  CUDA, GPU or dedicated ML RAM load on the Acer**;
- pins the exact SHAs that passed Codespaces actual forward inference;
- uses the real `python -m intelligence.nlp.cli` process logic in opt-in
  `SENTIMENT_REMOTE_ENABLED=true` mode on exactly three hardcoded synthetic
  X/TG messages, which exercises both HTTP calls and SQLite per-batch commits;
- saves derived results only to the ignored
  `.local/sentiment/windows-remote-smoke.sqlite`. It never reads or writes
  X/TG collector databases, starts a service or sends private Telegram texts;
- restores the original PowerShell process environment on completion.

Expected output:

```
WINDOWS REMOTE SENTIMENT SMOKE PASSED
CryptoBERT + FinTwitBERT + RuBERT: same-SHA remote classification OK.
```

Use this as a manual connectivity test only, **not** as a scheduled worker.
When the Codespace is stopped or your Codespaces allowance is exhausted,
requests time out and collectors must operate independently. Keep both the
Codespaces API port and forwarded tunnel private. Real X/TG source text
sending still requires explicit source-by-source permission and dedicated
ingestion integration; external LLM calls remain unimplemented.
