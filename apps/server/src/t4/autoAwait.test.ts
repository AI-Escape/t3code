import { assert, describe, it } from "@effect/vitest";

import { awaitsOnItsOwn } from "./autoAwait.ts";

describe("awaitsOnItsOwn", () => {
  const command = (text: string) => ({ taskId: "b1", kind: "command" as const, command: text });

  it("waits on checks, tests, builds and Monitors, not on what is left running", () => {
    for (const text of [
      "./scripts/check.sh --changed > ~/artifacts/x/check.log 2>&1",
      "cd backend && uv run pytest tests/",
      "./.t4-test.sh src/t4/T4Delivery.test.ts",
      "pnpm vitest run src/a.test.ts",
      "pnpm run typecheck",
      "vp test run apps/web/src/x.test.ts",
      "npx playwright test e2e/",
      "docker compose build web",
      "cargo test -p core",
    ]) {
      assert.isTrue(awaitsOnItsOwn(command(text)), text);
    }
    assert.isTrue(awaitsOnItsOwn({ taskId: "m1", kind: "monitor" }));
    for (const text of [
      "pnpm dev",
      "vp run dev --share",
      "docker compose up api",
      "tail -f server.log",
      "pnpm vitest --watch",
      "python3 -m http.server 10901",
      "cat <<'EOF' > notes.md\nrun the pytest suite later\nEOF",
      'git commit -m "make vitest quieter" && git push',
    ]) {
      assert.isFalse(awaitsOnItsOwn(command(text)), text);
    }
    assert.isFalse(awaitsOnItsOwn({ taskId: "s1", kind: "subagent" }));
  });
});
