import fs from "node:fs";
import path from "node:path";

export function resolveExistingPath(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function workspacePath(...segments: string[]): string {
  return path.resolve(process.cwd(), "..", ...segments);
}

export function parseCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function asText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}
