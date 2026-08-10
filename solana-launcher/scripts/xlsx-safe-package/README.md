# POTAPoff safe XLSX compatibility package

This local package replaces the legacy SheetJS runtime used only by the migration importer.

Security boundary:
- Python standard-library ZIP/XML parsing only;
- no archive extraction to disk;
- bounded source size, expanded archive size, entry size, entry count and cell count;
- DTD/entity declarations rejected;
- worksheet relationship targets must remain below `xl/`;
- subprocess invocation uses an argument array with `shell: false`;
- importer compatibility is intentionally limited to `readFile`, `utils.encode_cell` and `utils.decode_range`.

It is not a general-purpose spreadsheet library. Extend the compatibility surface only with tests and explicit bounds.
