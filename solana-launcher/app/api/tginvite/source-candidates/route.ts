import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";

const CANDIDATES_PATH = path.join(process.cwd(), "backend", "data", "tgdataset", "tginvite_source_candidates.json");

export async function GET() {
  try {
    const raw = await fs.readFile(CANDIDATES_PATH, "utf-8");
    const candidates = JSON.parse(raw);
    return NextResponse.json({
      generatedFrom: "backend/data/tgdataset/tginvite_source_candidates.json",
      count: Array.isArray(candidates) ? candidates.length : 0,
      candidates: Array.isArray(candidates) ? candidates : [],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: "TGDataset candidates are not built yet. Run the TGDataset filter first.",
        details: message,
      },
      { status: 404 }
    );
  }
}
