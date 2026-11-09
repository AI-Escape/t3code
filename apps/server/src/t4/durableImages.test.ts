// @effect-diagnostics nodeBuiltinImport:off - the test writes images in temp folders.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { persistTmpImages } from "./durableImages.ts";

describe("t4 persistTmpImages", () => {
  it("copies an existing /tmp image and relinks it, leaving others alone", () => {
    const shots = NodeFS.mkdtempSync("/tmp/t4-shots-");
    const keep = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4-images-"));
    const shot = NodePath.join(shots, "desktop-1.png");
    NodeFS.writeFileSync(shot, "png");
    const env = { T4_DURABLE_IMAGES_DIR: keep } as NodeJS.ProcessEnv;
    const text = `Before ![Open](${shot}) and ![Gone](/tmp/nope/x.png) and ![Kept](/home/max/a.png)`;
    const out = persistTmpImages(text, env);
    const copied = /!\[Open\]\(([^)]+)\)/.exec(out)![1]!;
    expect(copied.startsWith(`${keep}/`)).toBe(true);
    expect(copied.endsWith("-desktop-1.png")).toBe(true);
    expect(NodeFS.readFileSync(copied, "utf8")).toBe("png");
    expect(out).toContain("![Gone](/tmp/nope/x.png)");
    expect(out).toContain("![Kept](/home/max/a.png)");
    expect(persistTmpImages(text, env)).toBe(out);
    expect(persistTmpImages(text, {})).toBe(text);
    NodeFS.rmSync(shots, { recursive: true, force: true });
    NodeFS.rmSync(keep, { recursive: true, force: true });
  });
});
