import { useGT } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

/** t4: a ```copy fence - a value the user is meant to paste somewhere (a code,
 * an id, a command), drawn as the text with a Copy button right beside it.
 * The button copies the block exactly, without its closing newline. */
export function MarkdownCopyBlock({ code }: { code: string }) {
  const gt = useGT();
  const value = code.replace(/\n$/, "");
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    onError: (cause) =>
      reportMarkdownActionFailure({ operation: "copy-code-block", language: "copy" }, cause),
  });
  return (
    <div
      dir="ltr"
      className="chat-markdown-codeblock chat-markdown-copyblock my-[0.65rem] flex items-center gap-2 overflow-hidden rounded-lg border border-border/70 bg-secondary py-1.5 pr-1.5 pl-3 text-start leading-snug dark:border-transparent dark:bg-input/32"
      data-language="copy"
      data-wrap="true"
    >
      <pre className="min-w-0 flex-1">
        <code>{value}</code>
      </pre>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 self-center select-none"
        data-thread-find-ignore=""
        aria-label={isCopied ? gt("Copied") : gt("Copy")}
        onClick={() => copyToClipboard(value)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
        {isCopied ? gt("Copied") : gt("Copy")}
      </Button>
    </div>
  );
}
