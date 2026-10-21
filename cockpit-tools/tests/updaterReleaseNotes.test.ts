import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  prependUpdaterReleaseHighlights,
} from "../src/utils/updaterReleaseNotes.ts";

describe("updater release highlights", () => {
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
