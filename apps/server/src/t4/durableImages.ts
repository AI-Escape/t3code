/**
 * t4 fork: the container's `/tmp` is emptied on restart and T3 serves embedded images from their
 * path, so when a reply is final each existing `![alt](/tmp/....png)` is copied to
 * `~/artifacts/images/` (T4_DURABLE_IMAGES_DIR) and the link rewritten.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- small synchronous copies, once per finished reply.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- small synchronous copies, once per finished reply.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- small synchronous copies, once per finished reply.
import * as NodePath from "node:path";

const TMP_IMAGE = /(!\[[^\]]*\]\(<?)(\/tmp\/[^)\s>]+?\.(?:png|jpe?g|gif|webp|svg))(>?\))/gi;

const imagesDir = (env: NodeJS.ProcessEnv) =>
  env.T4_DURABLE_IMAGES_DIR?.trim() ||
  (env.T4_SERVER_CONFIG ? NodePath.join(NodeOS.homedir(), "artifacts", "images") : undefined);

/** The text with every existing `/tmp` image copied and relinked; unchanged when there are none. */
export function persistTmpImages(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text.includes("](/tmp/") && !text.includes("](</tmp/")) return text;
  const dir = imagesDir(env);
  if (dir === undefined) return text;
  return text.replace(TMP_IMAGE, (whole, open: string, source: string, close: string) => {
    try {
      const stat = NodeFS.statSync(source);
      if (!stat.isFile()) return whole;
      const tag = NodeCrypto.createHash("sha1")
        .update(`${source}:${stat.size}:${stat.mtimeMs}`)
        .digest("hex")
        .slice(0, 10);
      const target = NodePath.join(dir, `${tag}-${NodePath.basename(source)}`);
      if (!NodeFS.existsSync(target)) {
        NodeFS.mkdirSync(dir, { recursive: true });
        NodeFS.copyFileSync(source, target);
      }
      return `${open}${target}${close}`;
    } catch {
      return whole;
    }
  });
}
