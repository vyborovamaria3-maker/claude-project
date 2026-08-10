const path = require("node:path");
const { spawnSync } = require("node:child_process");

const READER = path.join(__dirname, "read_xlsx.py");
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function pythonCandidates() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  if (process.platform === "win32") {
    candidates.push(["py", ["-3"]], ["python", []], ["python3", []]);
  } else {
    candidates.push(["python3", []], ["python", []]);
  }
  return candidates;
}

function runReader(filePath) {
  let lastError = null;
  for (const [command, prefixArgs] of pythonCandidates()) {
    const result = spawnSync(command, [...prefixArgs, READER, path.resolve(String(filePath))], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 120_000,
      shell: false,
    });

    if (result.error && result.error.code === "ENOENT") {
      lastError = result.error;
      continue;
    }
    if (result.error) {
      throw new Error(`Safe XLSX reader failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const message = String(result.stderr || "Safe XLSX reader failed").trim();
      throw new Error(message.slice(0, 2000));
    }
    try {
      return JSON.parse(result.stdout || "{}");
    } catch (error) {
      throw new Error(`Safe XLSX reader returned invalid JSON: ${error.message}`);
    }
  }
  throw new Error(
    `Python 3 is required for safe XLSX import${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function encodeColumn(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid XLSX column index");
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function decodeColumn(value) {
  let result = 0;
  for (const char of value) result = result * 26 + (char.charCodeAt(0) - 64);
  return result - 1;
}

function encode_cell({ r, c }) {
  if (!Number.isInteger(r) || r < 0) throw new Error("Invalid XLSX row index");
  return `${encodeColumn(c)}${r + 1}`;
}

function decodeCell(value) {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error(`Invalid XLSX cell reference: ${value}`);
  return { r: Number(match[2]) - 1, c: decodeColumn(match[1]) };
}

function decode_range(value) {
  const parts = String(value).split(":");
  const start = decodeCell(parts[0]);
  const end = decodeCell(parts[1] || parts[0]);
  return { s: start, e: end };
}

function readFile(filePath) {
  const payload = runReader(filePath);
  const names = Array.isArray(payload.sheetNames) ? payload.sheetNames.map(String) : [];
  const sourceSheets = payload.sheets && typeof payload.sheets === "object" ? payload.sheets : {};
  const sheets = {};

  for (const name of names) {
    const source = sourceSheets[name] || {};
    const sheet = {};
    if (typeof source.ref === "string" && source.ref) sheet["!ref"] = source.ref;
    if (source.cells && typeof source.cells === "object") {
      for (const [ref, cell] of Object.entries(source.cells)) {
        if (!/^[A-Z]+[1-9][0-9]*$/.test(ref) || !cell || typeof cell !== "object") continue;
        sheet[ref] = cell;
      }
    }
    sheets[name] = sheet;
  }

  return { SheetNames: names, Sheets: sheets };
}

module.exports = {
  readFile,
  utils: { encode_cell, decode_range },
};
