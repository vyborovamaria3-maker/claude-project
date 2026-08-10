from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

from read_xlsx import MAX_ARCHIVE_BYTES, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_FILE_BYTES, read_workbook


def reject_unsafe_xml(path: Path) -> None:
    size = path.stat().st_size
    if size <= 0 or size > MAX_FILE_BYTES:
        raise RuntimeError("XLSX file size is outside the allowed range")

    with zipfile.ZipFile(path, "r", allowZip64=True) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise RuntimeError("XLSX archive has too many entries")
        if sum(max(0, item.file_size) for item in infos) > MAX_ARCHIVE_BYTES:
            raise RuntimeError("XLSX archive expands beyond the allowed size")

        for info in infos:
            if info.file_size > MAX_ENTRY_BYTES:
                raise RuntimeError(f"XLSX entry is too large: {info.filename}")
            if not info.filename.lower().endswith((".xml", ".rels")):
                continue
            data = archive.read(info)
            upper = data.upper()
            if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
                raise RuntimeError(
                    f"DTD/entity declarations are not allowed in XLSX XML: {info.filename}"
                )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: read_xlsx_guard.py <workbook.xlsx>", file=sys.stderr)
        return 2

    try:
        path = Path(sys.argv[1]).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError("XLSX file does not exist")
        reject_unsafe_xml(path)
        json.dump(read_workbook(str(path)), sys.stdout, ensure_ascii=False, separators=(",", ":"))
        return 0
    except (RuntimeError, OSError, zipfile.BadZipFile) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
