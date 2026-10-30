import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { resolveThreadRef, shortId } from "./T4Threads.ts";
import { resolveThreadIdParam } from "./threadRefs.ts";

const thread = (id: string, title: string) =>
  ({ id: ThreadId.make(id), title, archivedAt: null, deletedAt: null }) as never;

const threads = [
  thread("t4-1c558f0a-1111-4222-8333-444455556666", "USA-1520 Backorder status"),
  thread("mcp:9b2e7d41-aaaa-4bbb-8ccc-dddd00001111", "USA-1519 No invoice request"),
  thread("t4-1c55aaaa-1111-4222-8333-444455556666", "Release manager — usa-rs"),
];

const services = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: (id: ThreadId) =>
    Effect.succeed(
      (threads.find((t: { id: string }) => t.id === id) ?? null) as never,
    ),
  getShellSnapshot: () => Effect.succeed({ threads, archivedThreads: [] } as never),
});

const resolve = (threadId: string) =>
  Effect.runPromise(resolveThreadIdParam({ threadId, message: "hi" }).pipe(Effect.provide(services)));

describe("t4 thread refs", () => {
  it("short ids leave out t4-", () => {
    expect(shortId("t4-1c558f0a-1111-4222-8333-444455556666")).toBe("1c558f0a");
    expect(shortId("mcp:9b2e7d41-aaaa-4bbb-8ccc-dddd00001111")).toBe("9b2e7d41");
  });

  it("resolves short ids with or without t4-, bare uuids and titles", async () => {
    expect((await resolve("1c558f0a")).threadId).toBe("t4-1c558f0a-1111-4222-8333-444455556666");
    expect((await resolve("t4-1c558f0a")).threadId).toBe("t4-1c558f0a-1111-4222-8333-444455556666");
    expect((await resolve("9b2e7d41-aaaa-4bbb-8ccc-dddd00001111")).threadId).toBe(
      "mcp:9b2e7d41-aaaa-4bbb-8ccc-dddd00001111",
    );
    expect((await resolve("USA-1519")).threadId).toBe("mcp:9b2e7d41-aaaa-4bbb-8ccc-dddd00001111");
    expect((await resolve("USA-1519")).message).toBe("hi");
  });

  it("leaves exact, ambiguous and unknown refs alone", async () => {
    expect((await resolve("t4-1c558f0a-1111-4222-8333-444455556666")).threadId).toBe(
      "t4-1c558f0a-1111-4222-8333-444455556666",
    );
    // "t4-1c55" names two threads; too short a bare prefix matches nothing.
    expect((await resolve("t4-1c55")).threadId).toBe("t4-1c55");
    expect((await resolve("nope")).threadId).toBe("nope");
    expect(resolveThreadRef("1c5", threads).type).toBe("none");
  });

  it("passes params without a threadId through", async () => {
    expect(
      await Effect.runPromise(resolveThreadIdParam({ projectId: "p" }).pipe(Effect.provide(services))),
    ).toEqual({ projectId: "p" });
  });
});
