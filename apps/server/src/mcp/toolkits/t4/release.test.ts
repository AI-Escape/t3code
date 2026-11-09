import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { describe } from "vite-plus/test";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as T4Config from "../../../t4/T4Config.ts";
import * as T4Delivery from "../../../t4/T4Delivery.ts";
import * as T4Ledger from "../../../t4/T4Ledger.ts";
import * as T4RunWatch from "../../../t4/T4RunWatch.ts";
import * as T4Sql from "../../../t4/T4Sql.ts";
import * as T4Store from "../../../t4/T4Store.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { prOfHandoff, releaseNotice } from "./handlers.ts";

describe("t4 release queue helpers", () => {
  it("finds the PR an owner's handoff names", () => {
    expect(prOfHandoff("PR #2340 is green, merge word given (USA-1653)")).toBe(2340);
    expect(
      prOfHandoff("Fixes the #12 regression: https://github.com/o/r/pull/2401 - merge when green"),
    ).toBe(2401);
    expect(prOfHandoff("#57 ready")).toBe(57);
    expect(prOfHandoff("ready to release, see the branch")).toBeUndefined();
    expect(prOfHandoff("color &#35; entity")).toBeUndefined();
  });

  it("writes one notice per owner and state", () => {
    expect(releaseNotice("staging", [12], null)).toBe(
      "staging: PR #12 is on staging. Verify there.",
    );
    expect(releaseNotice("shipped", [12, 14], null)).toBe(
      "shipped: PRs #12, #14 live in production. Verify, close your Linear.",
    );
    expect(releaseNotice("failed", [9], "Backend tests: test_quotes fails on main")).toBe(
      "release failed on your PR #9: Backend tests: test_quotes fails on main",
    );
  });
});

const OWNER = ThreadId.make("t4-owner-0001");
const RM = ThreadId.make("t4-rm-0001");
const shells = new Map([
  [OWNER, { ...McpToolAccessTestkit.liveThreadShell(OWNER), title: "USA-9 Fix" }],
  [
    RM,
    {
      ...McpToolAccessTestkit.liveThreadShell(RM),
      title: "Release manager — app",
    },
  ],
]);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "t4-release", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t4-release", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scopeOf = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("t4-release-env"),
  requestNamespace: `t4-release-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

const delivered: Array<{ to: string; text: string; notice: boolean }> = [];

const ledgerLayer = Layer.effect(
  T4Ledger.T4Ledger,
  Effect.gen(function* () {
    const store = yield* T4Store.T4Store;
    const world = () =>
      store.openHandoffs().pipe(
        Effect.orDie,
        Effect.map((open) => ({
          threads: [...shells.values()],
          byId: new Map([...shells.entries()].map(([id, shell]) => [id as string, shell])),
          releaseManagers: new Set<string>([RM]),
          open,
          live: open,
        })),
      );
    return T4Ledger.T4Ledger.of({
      world,
      isReleaseManager: (_world: unknown, thread: { readonly id: string }) => thread.id === RM,
      findReleaseManager: () => Effect.succeed(shells.get(RM)),
    } as never);
  }),
);

const layer = McpHttpServer.layerT4Toolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(ledgerLayer),
  Layer.provideMerge(T4Store.layer),
  Layer.provideMerge(T4Sql.layerMemory),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shells.get(id as ThreadId) ?? null),
        getProjectThreadRecords: () => Effect.fail("no records" as never),
      }),
      Layer.mock(T4Delivery.T4Delivery)({
        deliver: (input) =>
          Effect.sync(() => {
            delivered.push({
              to: input.target.id,
              text: input.text,
              notice: input.notice === true,
            });
            return { delivery: "started", how: "started a turn" } as never;
          }),
      }),
      Layer.mock(Project.ProjectService)({
        getById: (id) =>
          Effect.succeedSome({ id, title: "app", workspaceRoot: "/srv/Code/app" } as never),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(T4RunWatch.T4RunWatch)({}),
      Layer.succeed(T4Config.T4ServerConfig, T4Config.defaultT4ServerConfig),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const call = (as: ThreadId, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(as)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const text = result.content[0];
    const body = text?.type === "text" ? JSON.parse(text.text) : undefined;
    return { isError: result.isError === true, body: result.structuredContent ?? body } as {
      isError: boolean;
      body: any;
    };
  });

it.effect(
  "an owner's handoff queues its PR; the release manager moves it and owners hear once",
  () =>
    Effect.gen(function* () {
      const store = yield* T4Store.T4Store;
      const handoff = yield* call(OWNER, "t3_handoff", {
        message: "PR #2340 is green - merge word given (USA-9)",
      });
      expect(handoff.isError).toBe(false);
      expect(handoff.body.notes).toContain("PR #2340 is in the release manager's queue");

      const queued = yield* call(RM, "release_queue", {});
      expect(queued.body.entries).toMatchObject([
        { pr: 2340, state: "queued", issue: "USA-9", owner: { title: "USA-9 Fix" } },
      ]);

      // Owners can read the queue but not move it.
      const refused = yield* call(OWNER, "release_queue", {
        prs: [{ pr: 2340, state: "shipped" }],
      });
      expect(refused.isError).toBe(true);

      delivered.length = 0;
      yield* call(RM, "release_queue", {
        prs: [{ pr: 2340, state: "merged", commit: "abc1234" }],
      });
      expect(delivered).toEqual([]);

      // A hand-merged PR of the same owner rides the same train: one message for both.
      const staged = yield* call(RM, "release_queue", {
        prs: [
          { pr: 2340, state: "staging" },
          { pr: 2341, state: "staging", owner: "USA-9 Fix" },
        ],
      });
      expect(staged.body.notified).toEqual(['staging: "USA-9 Fix" (#2340, #2341)']);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ to: OWNER, notice: true });
      expect(delivered[0]!.text).toContain(
        "staging: PRs #2340, #2341 are on staging. Verify there.",
      );
      // staging is fyi: the owner's handoff stays open.
      expect((yield* store.openHandoffs()).map((h) => h.fromThreadId)).toEqual([OWNER]);

      // The same state again sends nothing.
      yield* call(RM, "release_queue", { prs: [{ pr: 2340, state: "staging" }] });
      expect(delivered).toHaveLength(1);

      const failedWithoutNote = yield* call(RM, "release_queue", {
        prs: [{ pr: 2341, state: "failed" }],
      });
      expect(failedWithoutNote.isError).toBe(true);

      const shipped = yield* call(RM, "release_queue", {
        prs: [
          { pr: 2340, state: "shipped" },
          { pr: 2341, state: "shipped" },
        ],
      });
      expect(shipped.body.notified).toEqual(['shipped: "USA-9 Fix" (#2340, #2341)']);
      expect(delivered[1]!.text).toContain("answers your handoff");
      expect(delivered[1]!.text).toContain("shipped: PRs #2340, #2341 live in production");
      expect(yield* store.openHandoffs()).toEqual([]);
      expect(shipped.body.entries).toEqual([]);
      const recent = yield* call(RM, "release_queue", { all: true });
      expect(recent.body.entries.map((e: { pr: number }) => e.pr)).toEqual([2340, 2341]);
      expect(recent.body.entries[0]).toMatchObject({ commit: "abc1234", state: "shipped" });
    }).pipe(Effect.provide(layer)),
);
