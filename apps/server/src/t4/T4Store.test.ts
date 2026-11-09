import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as T4Sql from "./T4Sql.ts";
import * as T4Store from "./T4Store.ts";

const layer = T4Store.layer.pipe(
  Layer.provideMerge(T4Sql.layerMemory),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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

  it.effect("keeps thread roles and who launched whom", () =>
    Effect.gen(function* () {
      const store = yield* T4Store.T4Store;
      yield* store.setThreadRole("pm-1", "pm");
      yield* store.setThreadRole("t2", "pm");
      yield* store.setThreadRole("t2", "owner");
      assert.deepEqual([...(yield* store.threadRoles()).entries()].sort(), [
        ["pm-1", "pm"],
        ["t2", "owner"],
      ]);
      yield* store.recordHandoff({
        kind: "spawn",
        fromThreadId: "pm-1",
        fromTitle: "AI-1 PM",
        toThreadId: "child",
        projectId: "p",
        summary: "build it",
      });
      const parents = yield* store.spawnParents();
      assert.equal(parents.get("child"), "pm-1");
      assert.isUndefined(parents.get("pm-1"));
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
