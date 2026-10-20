"""No-network checks for Hugging Face model size estimates and explicit downloads."""
from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

from intelligence.nlp.prefetch import run


class FakeApi:
    def model_info(self, repository, *, files_metadata):
        assert files_metadata
        amounts = {"ElKulako/cryptobert": 498620100,
                   "StephanAkkerman/FinTwitBERT-sentiment": 439000000,
                   "seara/rubert-tiny2-russian-sentiment": 117000000}
        return SimpleNamespace(
            sha="a"*40,
            siblings=[
                SimpleNamespace(rfilename="model.safetensors",size=amounts[repository]),
                SimpleNamespace(rfilename="pytorch_model.bin",size=amounts[repository]),
                SimpleNamespace(rfilename="tokenizer.json",size=2000),
            ],
        )


class PrefetchTests(unittest.TestCase):
    def test_exact_safetensors_sizes_ignore_pickle_and_do_not_download(self):
        downloads = []
        hub = SimpleNamespace(
            HfApi=FakeApi,
            snapshot_download=lambda **k: downloads.append(k),
        )
        with patch.dict(sys.modules, {"huggingface_hub": hub}):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                status=run(["--models", "cryptobert", "fintwitbert", "rubert", "--sizes"])
        self.assertEqual(status, 0, err.getvalue())
        self.assertEqual(downloads, [])
        output=out.getvalue()
        self.assertIn("cryptobert: 498620100 bytes", output)
        self.assertIn("TOTAL_WEIGHTS_BYTES=1054620100", output)
        self.assertIn("SENTIMENT_RUBERT_REVISION="+"a"*40, output)

    def test_download_is_only_explicit_and_limited_to_safe_files(self):
        downloads = []
        hub=SimpleNamespace(HfApi=FakeApi,
            snapshot_download=lambda **kwargs: downloads.append(kwargs))
        with patch.dict(sys.modules, {"huggingface_hub": hub}):
            with redirect_stdout(io.StringIO()):
                self.assertEqual(run(["--models","rubert","--download"]),0)
        self.assertEqual(len(downloads),1)
        self.assertEqual(downloads[0]["revision"],"a"*40)
        self.assertIn("*.safetensors", downloads[0]["allow_patterns"])
        self.assertFalse(any(x.endswith(".bin") for x in downloads[0]["allow_patterns"]))

    def test_unsupported_missing_safetensors_fail_closed(self):
        class BadApi:
            def model_info(self, repo, *, files_metadata):
                return SimpleNamespace(sha="a"*40,
                                       siblings=[SimpleNamespace(rfilename="pytorch_model.bin",
                                                                size=500000000)])
        hub=SimpleNamespace(HfApi=BadApi,snapshot_download=lambda **kw:
                            self.fail("unsafe download attempted"))
        with patch.dict(sys.modules, {"huggingface_hub": hub}):
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(run(["--models","cryptobert","--download"]),1)


if __name__=="__main__":
    unittest.main()
