"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * Renders model output as real markdown — GFM tables, bold, italic, lists, code.
 *
 * Raw HTML is allowed but sanitised, so `<u>underline</u>` works (underline has no
 * markdown syntax) without giving model output a script tag. The allowlist below
 * is the *only* HTML that survives.
 */
const schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "u",
    "mark",
    "sub",
    "sup",
    "kbd",
    "ins",
    "del",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
  },
};

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        // remarkBreaks: a single newline stays a line break, which is what
        // people expect in a chat box. Plain markdown would collapse it.
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
        components={{
          // Tables can be wider than the pane; give them their own scroller
          // rather than letting the whole message scroll sideways.
          table: ({ children }: { children?: React.ReactNode }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ children, ...props }: React.ComponentPropsWithoutRef<"a">) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
