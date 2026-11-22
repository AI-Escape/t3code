import { assert, describe, it } from "@effect/vitest";

import { frameHeaders, parseFrameAncestors } from "./frameAncestors.ts";

describe("frame ancestors", () => {
  it("keeps upstream's refusal when no origin is named", () => {
    assert.deepStrictEqual(frameHeaders(parseFrameAncestors(undefined)), {
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    });
    assert.deepStrictEqual(parseFrameAncestors("  "), []);
  });

  it("lets the named origins frame the app, and only them", () => {
    const origins = parseFrameAncestors(
      "https://t4.yakalo-climb.ts.net/, http://127.0.0.1:7040 *;evil 'unsafe-inline' javascript:x",
    );
    assert.deepStrictEqual(origins, ["https://t4.yakalo-climb.ts.net", "http://127.0.0.1:7040"]);
    assert.deepStrictEqual(frameHeaders(origins), {
      "Content-Security-Policy":
        "frame-ancestors 'self' https://t4.yakalo-climb.ts.net http://127.0.0.1:7040",
    });
  });
});
