/**
 * t4 fork: an image a reply embeds from `/tmp` is copied somewhere that
 * survives a restart, and the reply points at the copy.
 *
 * The container's `/tmp` is emptied on every restart, and T3 serves an
 * embedded image from its path when the reply is viewed: 15 briefs in 10
 * threads embedded `/tmp` screenshots in a week, and a restart blanked
 * USA-1493's five approval screenshots (usa-rs, 2026-10-29). When a reply is
 * final, each `![alt](/tmp/....png)` whose file exists is copied to
 * `~/artifacts/images/` (T4_DURABLE_IMAGES_DIR) and the link rewritten.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- small synchronous copies, once per finished reply.
import * as Crypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- small synchronous copies, once per finished reply.
import * as FS from "node:fs";
import * as OS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- small synchronous copies, once per finished reply.
import * as Path from "node:path";

const TMP_IMAGE = /(!\[[^\]]*\]\(<?)(\/tmp\/[^)\s>]+?\.(?:png|jpe?g|gif|webp|svg))(>?\))/gi;

const imagesDir = (env: NodeJS.ProcessEnv) =>
  env.T4_DURABLE_IMAGES_DIR?.trim() ||
  (env.T4_SERVER_CONFIG ? Path.join(OS.homedir(), "artifacts", "images") : undefined);

/** The text with every existing `/tmp` image copied and relinked; unchanged when there are none. */
export function persistTmpImages(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text.includes("](/tmp/") && !text.includes("](</tmp/")) return text;
  const dir = imagesDir(env);
  if (dir === undefined) return text;
  return text.replace(TMP_IMAGE, (whole, open: string, source: string, close: string) => {
    try {
      const stat = FS.statSync(source);
      if (!stat.isFile()) return whole;
      const tag = Crypto.createHash("sha1")
        .update(`${source}:${stat.size}:${stat.mtimeMs}`)
        .digest("hex")
        .slice(0, 10);
      const target = Path.join(dir, `${tag}-${Path.basename(source)}`);
      if (!FS.existsSync(target)) {
        FS.mkdirSync(dir, { recursive: true });
        FS.copyFileSync(source, target);
      }
      return `${open}${target}${close}`;
    } catch {
      return whole;
    }
  });
}
