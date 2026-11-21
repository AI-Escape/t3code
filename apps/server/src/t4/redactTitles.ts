/**
 * t4 fork: a Brave key typed as a whole message became a thread title (AI-125). Titles and title
 * seeds on every command lose key-shaped tokens before they are recorded.
 */
const KEY_PREFIXED =
  /\b(?:sk-[\w-]{16,}|gh[opsu]_\w{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|glpat-[\w-]{20,}|lin_api_\w{20,})/g;
// Random-looking: long, with at least two each of digits, capitals and small letters.
const KEY_RANDOM = /\b(?=(?:[\w-]*\d){2})(?=(?:[\w-]*[A-Z]){2})(?=(?:[\w-]*[a-z]){2})[\w-]{24,}\b/g;

export const redactKeys = (text: string): string =>
  text.replace(KEY_PREFIXED, "[key]").replace(KEY_RANDOM, "[key]");

const TITLE_FIELDS = ["title", "titleSeed"] as const;

export const redactKeyTitles = <C extends { readonly type: string }>(command: C): C => {
  let redacted: Record<string, unknown> | undefined;
  for (const field of TITLE_FIELDS) {
    const value: unknown = Reflect.get(command, field);
    if (typeof value !== "string") continue;
    const clean = redactKeys(value);
    if (clean === value) continue;
    redacted ??= { ...command };
    redacted[field] = clean;
  }
  return (redacted ?? command) as C;
};
