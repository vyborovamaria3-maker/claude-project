import csv
import io
import json

import pytest
from app.services.telegram_collector.exports import encode_messages
from app.services.telegram_intelligence import incremental_min_id


def test_incremental_cursor_keeps_bounded_recheck_window():
    assert incremental_min_id(None) == 0
    assert incremental_min_id(100) == 0
    assert incremental_min_id(1000) == 750
    assert incremental_min_id(1000, lookback_ids=20) == 980


def test_json_export_preserves_unicode():
    body, media_type, extension = encode_messages(
        [{"message_id": 4, "text": "Привет 🟢"}], "json"
    )
    assert (media_type, extension) == ("application/json", "json")
    assert json.loads(body)[0]["text"] == "Привет 🟢"


def test_csv_export_escapes_formulas_and_text():
    body, _, extension = encode_messages(
        [{"message_id": 5, "text": "=HYPERLINK(\"https://bad.example\")"}], "csv"
    )
    assert extension == "csv"
    rows = list(csv.DictReader(io.StringIO(body.decode("utf-8-sig"))))
    assert rows[0]["text"].startswith("'=HYPERLINK")


def test_invalid_export_format_rejected():
    with pytest.raises(ValueError):
        encode_messages([], "invalid")
