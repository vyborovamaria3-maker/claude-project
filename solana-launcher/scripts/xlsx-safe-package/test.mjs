import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const XLSX = require("./index.cjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "potapoff-xlsx-test-"));
const workbookPath = path.join(dir, "fixture.xlsx");

const createFixture = String.raw`
import sys, zipfile
from pathlib import Path

path = Path(sys.argv[1])
files = {
    '[Content_Types].xml': '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>''',
    '_rels/.rels': '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''',
    'xl/workbook.xml': '''<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>''',
    'xl/_rels/workbook.xml.rels': '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>''',
    'xl/sharedStrings.xml': '''<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>wallet</t></si><si><t>roi</t></si>
</sst>''',
    'xl/worksheets/sheet1.xml': '''<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Wallet111</t></is></c><c r="B2"><v>12.5</v></c></row>
  </sheetData>
</worksheet>''',
}
with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name, content in files.items():
        archive.writestr(name, content)
`;

const candidates = process.platform === "win32" ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]];
let created = false;
for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, "-c", createFixture, workbookPath], { encoding: "utf8", shell: false });
  if (result.error?.code === "ENOENT") continue;
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  created = true;
  break;
}
assert.equal(created, true, "Python 3 is required for the safe XLSX smoke test");

try {
  const workbook = XLSX.readFile(workbookPath, { raw: false });
  assert.deepEqual(workbook.SheetNames, ["Data"]);
  const sheet = workbook.Sheets.Data;
  assert.equal(sheet["!ref"], "A1:B2");
  assert.equal(sheet.A1.v, "wallet");
  assert.equal(sheet.B1.v, "roi");
  assert.equal(sheet.A2.v, "Wallet111");
  assert.equal(sheet.B2.v, 12.5);
  assert.deepEqual(XLSX.utils.decode_range("A1:B2"), { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } });
  assert.equal(XLSX.utils.encode_cell({ r: 1, c: 1 }), "B2");
  console.log("SAFE_XLSX_SMOKE_OK");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
