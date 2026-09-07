from __future__ import annotations

from app.services import advanced_intelligence_enrichment


def test_semantic_clustering_extracts_ngrams_once_per_message(monkeypatch) -> None:
    original = advanced_intelligence_enrichment._char_ngrams
    calls = 0

    def counted(text: str, size: int = 3):
        nonlocal calls
        calls += 1
        return original(text, size)

    monkeypatch.setattr(advanced_intelligence_enrichment, "_char_ngrams", counted)
    evidence = [
        {
            "id": f"message-{index}",
            "source": f"source-{index}",
            "text": (
                "This launch narrative contains enough normalized text for "
                f"semantic comparison number {index}"
            ),
        }
        for index in range(40)
    ]

    result = advanced_intelligence_enrichment.semantic_template_clusters(
        {"evidence": evidence}
    )

    assert result["method"] == "token-jaccard+character-trigram-cosine-v2"
    # Pairwise comparisons can be O(n^2), but expensive text feature extraction
    # must stay O(n): one trigram build per retained evidence message.
    assert calls == len(evidence)


def test_precomputed_similarity_preserves_existing_formula() -> None:
    left = "Alpha callers coordinate the same launch narrative across Telegram"
    right = "Telegram callers coordinate that same alpha launch narrative"

    legacy = advanced_intelligence_enrichment._semantic_similarity(left, right)
    prepared = advanced_intelligence_enrichment._prepared_semantic_similarity(
        advanced_intelligence_enrichment._tokens(left),
        advanced_intelligence_enrichment._char_ngrams(left),
        advanced_intelligence_enrichment._tokens(right),
        advanced_intelligence_enrichment._char_ngrams(right),
    )

    assert prepared == legacy
