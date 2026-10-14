import { describe, expect, it } from "vitest";
import { buildHistoryCsv, buildHistoryJson } from "./tginvite-history-export";

describe("authorized history export", () => {
  const rows = [{
    message_id: 123,
    published_at: "2026-10-14T04:00:00Z",
    text: "Привет, \"Telegram\"\n=1+1",
    views: 17,
    forwards: 2,
  }];

  it("produces readable CSV with escaped quotes and multiline content", () => {
    const csv = buildHistoryCsv(rows);
    expect(csv.startsWith("\uFEFFmessage_id,published_at,text,views,forwards")).toBe(true);
    expect(csv).toContain('Привет, ""Telegram""');
    expect(csv).toContain("=1+1");
    expect(csv).toContain("\r\n");
  });

  it("neutralizes formula cells instead of executing them", () => {
    const csv = buildHistoryCsv([{ ...rows[0], text: "  =HYPERLINK(\"https://example.invalid\")" }]);
    expect(csv).toContain('"\'  =HYPERLINK');
  });

  it("includes explicit incomplete-history metadata in JSON", () => {
    const json = JSON.parse(buildHistoryJson("public_chat", rows));
    expect(json.source).toBe("public_chat");
    expect(json.complete_history).toBe(false);
    expect(json.coverage).toBe("recent_accessible_messages");
    expect(json.count).toBe(1);
    expect(json.messages[0].text).toBe(rows[0].text);
  });

  it("can export an empty preview without inventing records", () => {
    expect(buildHistoryCsv([])).toContain("message_id,published_at,text,views,forwards");
    expect(JSON.parse(buildHistoryJson("public_chat", [])).count).toBe(0);
  });
});
