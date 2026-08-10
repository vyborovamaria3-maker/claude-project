from __future__ import annotations

import datetime as dt
import json
import math
import os
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_ENTRY_BYTES = 32 * 1024 * 1024
MAX_ENTRIES = 4096
MAX_CELLS = 2_000_000

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

CELL_REF_RE = re.compile(r"^([A-Z]+)([1-9][0-9]*)$")
DATE_TOKEN_RE = re.compile(r"[dmyhs]", re.I)

BUILTIN_DATE_FORMATS = {
    14, 15, 16, 17, 18, 19, 20, 21, 22,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def safe_xml(data: bytes, label: str) -> ET.Element:
    if len(data) > MAX_ENTRY_BYTES:
        fail(f"XLSX XML part is too large: {label}")
    prefix = data[:4096].upper()
    if b"<!DOCTYPE" in prefix or b"<!ENTITY" in prefix:
        fail(f"DTD/entity declarations are not allowed in XLSX XML: {label}")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        fail(f"Invalid XLSX XML in {label}: {exc}")


def read_part(archive: zipfile.ZipFile, name: str) -> bytes:
    normalized = posixpath.normpath(name).lstrip("/")
    if normalized.startswith("../") or normalized == "..":
        fail("Unsafe XLSX archive path")
    try:
        info = archive.getinfo(normalized)
    except KeyError:
        fail(f"Missing XLSX part: {normalized}")
    if info.file_size > MAX_ENTRY_BYTES:
        fail(f"XLSX part is too large: {normalized}")
    return archive.read(info)


def optional_part(archive: zipfile.ZipFile, name: str) -> bytes | None:
    normalized = posixpath.normpath(name).lstrip("/")
    try:
        info = archive.getinfo(normalized)
    except KeyError:
        return None
    if info.file_size > MAX_ENTRY_BYTES:
        fail(f"XLSX part is too large: {normalized}")
    return archive.read(info)


def col_to_index(value: str) -> int:
    result = 0
    for char in value:
        result = result * 26 + (ord(char) - 64)
    return result - 1


def index_to_col(index: int) -> str:
    result = ""
    value = index + 1
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def parse_cell_ref(value: str) -> tuple[int, int] | None:
    match = CELL_REF_RE.fullmatch(value)
    if not match:
        return None
    return int(match.group(2)) - 1, col_to_index(match.group(1))


def cell_ref(row: int, col: int) -> str:
    return f"{index_to_col(col)}{row + 1}"


def collect_text(node: ET.Element) -> str:
    return "".join(text.text or "" for text in node.iter(f"{{{NS_MAIN}}}t"))


def shared_strings(archive: zipfile.ZipFile) -> list[str]:
    raw = optional_part(archive, "xl/sharedStrings.xml")
    if raw is None:
        return []
    root = safe_xml(raw, "xl/sharedStrings.xml")
    return [collect_text(item) for item in root.findall(f"{{{NS_MAIN}}}si")]


def style_formats(archive: zipfile.ZipFile) -> list[tuple[int, str | None]]:
    raw = optional_part(archive, "xl/styles.xml")
    if raw is None:
        return []
    root = safe_xml(raw, "xl/styles.xml")
    custom: dict[int, str] = {}
    num_fmts = root.find(f"{{{NS_MAIN}}}numFmts")
    if num_fmts is not None:
        for item in num_fmts.findall(f"{{{NS_MAIN}}}numFmt"):
            try:
                custom[int(item.attrib.get("numFmtId", "0"))] = item.attrib.get("formatCode", "")
            except ValueError:
                continue
    result: list[tuple[int, str | None]] = []
    cell_xfs = root.find(f"{{{NS_MAIN}}}cellXfs")
    if cell_xfs is not None:
        for xf in cell_xfs.findall(f"{{{NS_MAIN}}}xf"):
            try:
                fmt_id = int(xf.attrib.get("numFmtId", "0"))
            except ValueError:
                fmt_id = 0
            result.append((fmt_id, custom.get(fmt_id)))
    return result


def is_date_format(fmt_id: int, code: str | None) -> bool:
    if fmt_id in BUILTIN_DATE_FORMATS:
        return True
    if not code:
        return False
    cleaned = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', "", code)
    return bool(DATE_TOKEN_RE.search(cleaned))


def excel_datetime(value: float, date1904: bool) -> dt.datetime:
    if date1904:
        epoch = dt.datetime(1904, 1, 1)
        return epoch + dt.timedelta(days=value)
    epoch = dt.datetime(1899, 12, 30)
    return epoch + dt.timedelta(days=value)


def format_date(value: float, code: str | None, date1904: bool) -> str:
    stamp = excel_datetime(value, date1904)
    code_lower = (code or "").lower()
    has_time = any(token in code_lower for token in ("h", "s")) or stamp.time() != dt.time(0, 0)
    if has_time:
        if stamp.microsecond:
            return stamp.isoformat(sep=" ", timespec="milliseconds")
        return stamp.isoformat(sep=" ", timespec="seconds")
    return stamp.date().isoformat()


def format_numeric(value: float, fmt_id: int, code: str | None, date1904: bool) -> str:
    if is_date_format(fmt_id, code):
        return format_date(value, code, date1904)
    if code and "%" in code:
        decimals = 0
        match = re.search(r"0\.([0]+)%", code)
        if match:
            decimals = len(match.group(1))
        return f"{value * 100:.{decimals}f}%"
    if math.isfinite(value) and value.is_integer():
        return str(int(value))
    return format(value, ".15g")


def workbook_sheet_targets(archive: zipfile.ZipFile) -> tuple[list[tuple[str, str]], bool]:
    workbook = safe_xml(read_part(archive, "xl/workbook.xml"), "xl/workbook.xml")
    rels = safe_xml(read_part(archive, "xl/_rels/workbook.xml.rels"), "xl/_rels/workbook.xml.rels")
    rel_map = {
        item.attrib.get("Id", ""): item.attrib.get("Target", "")
        for item in rels.findall(f"{{{NS_PKG_REL}}}Relationship")
    }
    workbook_pr = workbook.find(f"{{{NS_MAIN}}}workbookPr")
    date1904 = workbook_pr is not None and workbook_pr.attrib.get("date1904", "0").lower() in {"1", "true"}
    sheets_parent = workbook.find(f"{{{NS_MAIN}}}sheets")
    if sheets_parent is None:
        return [], date1904
    sheets: list[tuple[str, str]] = []
    for sheet in sheets_parent.findall(f"{{{NS_MAIN}}}sheet"):
        name = sheet.attrib.get("name", "").strip()
        rel_id = sheet.attrib.get(f"{{{NS_REL}}}id", "")
        target = rel_map.get(rel_id, "")
        if not name or not target:
            continue
        if target.startswith("/"):
            resolved = target.lstrip("/")
        else:
            resolved = posixpath.normpath(posixpath.join("xl", target))
        if not resolved.startswith("xl/"):
            fail("Worksheet relationship escaped xl/ directory")
        sheets.append((name, resolved))
    return sheets, date1904


def parse_sheet(
    archive: zipfile.ZipFile,
    part_name: str,
    strings: list[str],
    styles: list[tuple[int, str | None]],
    date1904: bool,
    cell_budget: list[int],
) -> dict[str, object]:
    root = safe_xml(read_part(archive, part_name), part_name)
    cells: dict[str, dict[str, object]] = {}
    min_row = min_col = None
    max_row = max_col = None

    for cell in root.iter(f"{{{NS_MAIN}}}c"):
        ref = cell.attrib.get("r", "")
        position = parse_cell_ref(ref)
        if position is None:
            continue
        row, col = position
        cell_budget[0] += 1
        if cell_budget[0] > MAX_CELLS:
            fail("XLSX contains too many cells")

        kind = cell.attrib.get("t", "")
        style_index = 0
        try:
            style_index = int(cell.attrib.get("s", "0"))
        except ValueError:
            pass
        fmt_id, fmt_code = styles[style_index] if 0 <= style_index < len(styles) else (0, None)
        value_node = cell.find(f"{{{NS_MAIN}}}v")
        raw = value_node.text if value_node is not None and value_node.text is not None else ""
        value: str | int | float | bool | None
        formatted: str | None = None

        if kind == "inlineStr":
            inline = cell.find(f"{{{NS_MAIN}}}is")
            value = collect_text(inline) if inline is not None else ""
            formatted = str(value)
        elif kind == "s":
            try:
                index = int(raw)
                value = strings[index] if 0 <= index < len(strings) else ""
            except ValueError:
                value = ""
            formatted = str(value)
        elif kind in {"str", "e"}:
            value = raw
            formatted = raw
        elif kind == "b":
            value = raw == "1"
            formatted = "TRUE" if value else "FALSE"
        else:
            if raw == "":
                formula = cell.find(f"{{{NS_MAIN}}}f")
                if formula is not None:
                    value = formula.text or ""
                    formatted = str(value)
                else:
                    continue
            else:
                try:
                    numeric = float(raw)
                    value = int(numeric) if numeric.is_integer() else numeric
                    formatted = format_numeric(numeric, fmt_id, fmt_code, date1904)
                except ValueError:
                    value = raw
                    formatted = raw

        cells[ref] = {"v": value, "w": formatted}
        min_row = row if min_row is None else min(min_row, row)
        max_row = row if max_row is None else max(max_row, row)
        min_col = col if min_col is None else min(min_col, col)
        max_col = col if max_col is None else max(max_col, col)

    ref_range = None
    if min_row is not None and min_col is not None and max_row is not None and max_col is not None:
        ref_range = f"{cell_ref(min_row, min_col)}:{cell_ref(max_row, max_col)}"
    return {"ref": ref_range, "cells": cells}


def read_workbook(file_name: str) -> dict[str, object]:
    path = Path(file_name).expanduser().resolve()
    if not path.is_file():
        fail("XLSX file does not exist")
    size = path.stat().st_size
    if size <= 0 or size > MAX_FILE_BYTES:
        fail("XLSX file size is outside the allowed range")

    with zipfile.ZipFile(path, "r", allowZip64=True) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            fail("XLSX archive has too many entries")
        total_size = sum(max(0, info.file_size) for info in infos)
        if total_size > MAX_ARCHIVE_BYTES:
            fail("XLSX archive expands beyond the allowed size")
        for info in infos:
            if info.file_size > MAX_ENTRY_BYTES:
                fail(f"XLSX entry is too large: {info.filename}")

        strings = shared_strings(archive)
        styles = style_formats(archive)
        targets, date1904 = workbook_sheet_targets(archive)
        sheets: dict[str, object] = {}
        names: list[str] = []
        cell_budget = [0]
        for name, target in targets:
            names.append(name)
            sheets[name] = parse_sheet(archive, target, strings, styles, date1904, cell_budget)
        return {"sheetNames": names, "sheets": sheets}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: read_xlsx.py <workbook.xlsx>", file=sys.stderr)
        return 2
    try:
        payload = read_workbook(sys.argv[1])
        json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        return 0
    except (RuntimeError, OSError, zipfile.BadZipFile) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
