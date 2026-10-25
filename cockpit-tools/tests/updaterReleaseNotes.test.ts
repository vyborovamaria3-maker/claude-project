import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prependUpdaterReleaseHighlights } from "../src/utils/updaterReleaseNotes.ts";

describe("updater release highlights", () => {
  it("adds highlights for the supported version while preserving original notes", () => {
    const original = "Existing change notes";
    const result = prependUpdaterReleaseHighlights("v1.3.1", original, "en-US");
    assert.notEqual(result, original, "Supported release must add highlights");
    assert.ok(result.includes(original), "Existing notes must remain available");
    assert.equal(prependUpdaterReleaseHighlights("v1.3.1", result, "en-US"), result,
      "Applying highlights twice must not duplicate them");
  });

  it("does not prepend a duplicate highlights section", () => {
    const original = "### 重要更新\n\n- 已存在的重要更新";

    assert.equal(
      prependUpdaterReleaseHighlights("1.3.1", original, "zh-CN"),
      original,
    );
  });

  it("leaves other versions unchanged", () => {
    const original = "### Changed\n\n- Other version";

    assert.equal(
      prependUpdaterReleaseHighlights("1.3.2", original, "en"),
      original,
    );
  });
});
