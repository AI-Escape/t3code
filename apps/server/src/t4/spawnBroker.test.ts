import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import * as SpawnBroker from "./spawnBroker.ts";

// The server's layer reads this when it is built.
process.env.T4_SPAWN_BROKER = "1";

const brokered = Effect.gen(function* () {
  return SpawnBroker.wrap(yield* ChildProcessSpawner.ChildProcessSpawner, "any");
});

const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.mkString(Stream.decodeText(stream));

const reasonOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  return error?._tag === "Fail" && PlatformError.isPlatformError(error.error)
    ? error.error.reason._tag
    : undefined;
};

describe("spawnBroker", () => {
  it.live("runs a command in the helper: output, exit code, its own pid", () =>
    Effect.gen(function* () {
      const spawner = yield* brokered;
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("sh", ["-c", 'echo "pid $$"; echo err >&2; exit 3']),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [text(handle.stdout), text(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" },
          );
          return { stdout, stderr, code, pid: handle.pid };
        }),
      );
      assert.equal(result.stdout, `pid ${result.pid}\n`);
      assert.notEqual(result.pid, process.pid);
      assert.equal(result.stderr, "err\n");
      assert.equal(result.code, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("feeds stdin and passes env and cwd", () =>
    Effect.gen(function* () {
      const spawner = yield* brokered;
      const out = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("sh", ["-c", 'cat; echo " $T4_TEST_VALUE $(pwd)"'], {
              cwd: "/tmp",
              env: { T4_TEST_VALUE: "seen" },
              extendEnv: true,
            }),
          );
          const [stdout] = yield* Effect.all(
            [
              text(handle.stdout),
              Stream.run(Stream.encodeText(Stream.make("hello")), handle.stdin),
            ],
            { concurrency: "unbounded" },
          );
          return stdout;
        }),
      );
      assert.equal(out, "hello seen /tmp\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a missing command and a missing folder as NotFound", () =>
    Effect.gen(function* () {
      const spawner = yield* brokered;
      const missingCommand = yield* Effect.exit(
        Effect.scoped(spawner.spawn(ChildProcess.make("t4-no-such-command", []))),
      );
      assert.equal(reasonOf(missingCommand), "NotFound");
      const missingCwd = yield* Effect.exit(
        Effect.scoped(spawner.spawn(ChildProcess.make("true", [], { cwd: "/t4/no/such/folder" }))),
      );
      assert.equal(reasonOf(missingCwd), "NotFound");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("kill ends the process group", () =>
    Effect.gen(function* () {
      const spawner = yield* brokered;
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 30 & wait"]));
          yield* handle.kill({ forceKillAfter: "200 millis" });
          return yield* Effect.exit(handle.exitCode);
        }),
      );
      // Ended by a signal: no exit code.
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("processRunner runs through it, including its timeout", () =>
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.make().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, yield* brokered),
      );
      const ok = yield* runner.run({ command: "sh", args: ["-c", "printf abc"] });
      assert.equal(ok.stdout, "abc");
      assert.equal(ok.code, 0);
      const slow = yield* runner.run({
        command: "sleep",
        args: ["30"],
        timeout: "300 millis",
        timeoutBehavior: "timedOutResult",
      });
      assert.isTrue(slow.timedOut);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("the layer sends git to the helper and other commands to Node", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const parentOf = (pid: number) =>
        Effect.map(fs.readFileString(`/proc/${pid}/stat`), (stat) =>
          Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]),
        );
      const parents = yield* Effect.scoped(
        Effect.gen(function* () {
          const git = yield* spawner.spawn(
            ChildProcess.make("git", ["-c", "alias.wait=!sleep 1", "wait"]),
          );
          const sleep = yield* spawner.spawn(ChildProcess.make("sleep", ["1"]));
          const parents = [yield* parentOf(git.pid), yield* parentOf(sleep.pid)];
          yield* Effect.all([git.exitCode, sleep.exitCode]);
          return parents;
        }),
      );
      assert.notEqual(parents[0], process.pid);
      assert.equal(parents[1], process.pid);
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, SpawnBroker.layer.pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
  );
});
