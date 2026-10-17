import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as T4Store from "./T4Store.ts";

const layer = T4Store.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);

describe("T4Store", () => {
  it.effect("keeps one open handoff per (from, to) and settles it", () =>
    Effect.gen(function* () {
      const store = yield* T4Store.T4Store;
      const first = yield* store.recordHandoff({
        kind: "handoff",
        fromThreadId: "owner",
        fromTitle: "USA-1 thing",
        toThreadId: "rm",
        projectId: "p",
        summary: "PR #1 ready",
      });
      const again = yield* store.recordHandoff({
        kind: "handoff",
        fromThreadId: "owner",
        fromTitle: "USA-1 thing",
        toThreadId: "rm",
        projectId: "p",
        summary: "staging verified",
      });
      assert.isFalse(first.updated);
      assert.isTrue(again.updated);
      assert.equal(again.id, first.id);
      const open = yield* store.openHandoffs();
      assert.equal(open.length, 1);
      assert.equal(open[0]?.summary, "staging verified");
      assert.equal(yield* store.settleHandoffs({ fromThreadId: "owner", toThreadId: "rm" }), 1);
      assert.equal((yield* store.openHandoffs()).length, 0);
      assert.equal(yield* store.settleHandoffs({ fromThreadId: "owner", toThreadId: "rm" }), 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("remembers notices, release managers, issue links, settle requests and wakes", () =>
    Effect.gen(function* () {
      const store = yield* T4Store.T4Store;
      yield* store.addNotice("m1");
      assert.deepEqual([...(yield* store.noticeIds(["m1", "m2"]))], ["m1"]);

      yield* store.setReleaseManager("p", "rm-1");
      yield* store.setReleaseManager("p", "rm-2");
      assert.equal((yield* store.releaseManagers()).get("p"), "rm-2");

      const link = {
        threadId: "t1",
        provider: "linear",
        identifier: "USA-9",
        url: null,
        title: null,
        linkedAt: "2026-10-17T00:00:00.000Z",
      };
      assert.isTrue(yield* store.linkIssue(link));
      assert.isFalse(yield* store.linkIssue(link));
      assert.equal((yield* store.issueLinksFor("linear", "USA-9")).length, 1);
      assert.isTrue(
        yield* store.unlinkIssue({ threadId: "t1", provider: "linear", identifier: "USA-9" }),
      );
      assert.equal((yield* store.issueLinks("t1")).length, 0);

      yield* store.setSettleRequest("t1", "2026-10-17T00:00:00.000Z");
      assert.equal((yield* store.settleRequests()).get("t1"), "2026-10-17T00:00:00.000Z");
      yield* store.clearSettleRequest("t1");
      assert.equal((yield* store.settleRequests()).size, 0);

      const id = yield* store.insertWake({
        threadId: "t1",
        threadTitle: "T1",
        byThreadId: "t1",
        note: "check CI",
        schedule: { kind: "in", spec: "2h" },
        due: "2026-10-17T02:00:00.000Z",
        createdAt: "2026-10-17T00:00:00.000Z",
        fired: 0,
      });
      const wake = yield* store.wake(id);
      assert.deepEqual(wake?.schedule, { kind: "in", spec: "2h" });
      yield* store.deleteWake(id);
      assert.isUndefined(yield* store.wake(id));
    }).pipe(Effect.provide(layer)),
  );
});
