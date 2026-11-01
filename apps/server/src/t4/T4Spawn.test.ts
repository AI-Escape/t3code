// @effect-diagnostics nodeBuiltinImport:off - the test makes real folders in a temp dir.
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { worktreeRefusal } from "./T4Spawn.ts";

const run = <A, E>(effect: Effect.Effect<A, E, ProcessRunner.ProcessRunner>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ) as Effect.Effect<A, E, never>,
  );

describe("t4 worktreeRefusal", () => {
  it("refuses a project folder that is not a git checkout", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t4-norepo-"));
    const refused = await run(worktreeRefusal({ title: "opencode", workspaceRoot: root }));
    expect(refused).toContain("is not a git repository");
    expect(refused).toContain("nothing was created");
  });

  it("accepts a git checkout", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t4-repo-"));
    ChildProcess.execFileSync("git", ["init", "-q", root]);
    expect(await run(worktreeRefusal({ title: "usa-rs", workspaceRoot: root }))).toBeUndefined();
  });

  it("refuses a folder that does not exist", async () => {
    const refused = await run(
      worktreeRefusal({ title: "gone", workspaceRoot: "/nonexistent/t4-spawn-test" }),
    );
    expect(refused).toContain("is not a git repository");
  });
});
