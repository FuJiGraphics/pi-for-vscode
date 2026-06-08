// Turn file references in prose ("src/foo.ts", "src/foo.ts:42") into clickable anchors that
// the host opens in the editor. Pure (string in → string out) plus a markdown-it rule installer;
// it never imports the bridge, so linkifyFileRefs is unit-testable without a webview runtime.
// The CLICK is handled in main.ts (reads the data-* attrs and posts an "openFile" message).
//
// Conservative by design — false positives are the main risk. A token is linkified only when it
// has a path SEPARATOR ("/") OR an explicit ":line"; a bare word like `Node.js` or `e.g.` is left
// alone. The extension must start with a LETTER, so version strings (`4.2.1`) never match. URLs
// are excluded by the lookbehind and, in practice, are tokenized out of text by markdown-it's
// linkifier before this rule sees them. The host validates existence and silently no-ops on a
// miss, so being optimistic here is safe.
import type MarkdownIt from "markdown-it";
import { escapeHtml } from "./util";

// Match a path candidate plus an optional :line(:col). The leading lookbehind keeps us from
// starting mid-token or right after "://" (so URL path tails are not re-linkified). The filename
// uses [\w.-]+ (dots allowed) with a greedy backtrack to a letter-led final extension, so
// multi-dot names like app.config.js resolve to the whole name, not a truncated prefix.
const FILE_REF = /(?<![\w./:-])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]\w*)(?::(\d+)(?::(\d+))?)?/g;

/** Wrap file references found in an ALREADY-HTML-ESCAPED text fragment. */
export function linkifyFileRefs(escaped: string): string {
  return escaped.replace(FILE_REF, (match, path: string, line?: string, col?: string) => {
    // Require a separator or an explicit line — kills `Node.js`, `e.g`, prose words.
    if (!path.includes("/") && !line) return match;
    const attrs =
      ' data-path="' + path + '"' +
      (line ? ' data-line="' + line + '"' : "") +
      (col ? ' data-col="' + col + '"' : "");
    return '<a class="file-link" data-action="open-file"' + attrs + ' title="' + match + '">' + match + "</a>";
  });
}

// Install the file-link behavior on a markdown-it instance: file refs are linkified in TEXT tokens
// only, so code spans (code_inline) and fenced blocks (their own renderers) are never touched. A
// link-depth counter skips linkification inside an explicit [label](href) so we never nest <a>.
export function installFileLinkRule(md: MarkdownIt): void {
  const rules = md.renderer.rules;
  let linkDepth = 0;

  const baseLinkOpen = rules.link_open;
  rules.link_open = (tokens, idx, options, env, self) => {
    linkDepth++;
    return baseLinkOpen ? baseLinkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
  const baseLinkClose = rules.link_close;
  rules.link_close = (tokens, idx, options, env, self) => {
    if (linkDepth > 0) linkDepth--;
    return baseLinkClose ? baseLinkClose(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
  rules.text = (tokens, idx) => {
    const escaped = escapeHtml(tokens[idx].content);
    return linkDepth > 0 ? escaped : linkifyFileRefs(escaped);
  };
  // Models frequently wrap file paths in inline code (`Assets/Foo.cs`), so linkify those too — the
  // same conservative rule (separator OR :line) means bare identifiers like `HashSet` stay plain.
  // Fenced blocks use a separate `fence` rule, so multi-line code is unaffected.
  rules.code_inline = (tokens, idx, _options, _env, self) => {
    const escaped = escapeHtml(tokens[idx].content);
    const body = linkDepth > 0 ? escaped : linkifyFileRefs(escaped);
    return "<code" + self.renderAttrs(tokens[idx]) + ">" + body + "</code>";
  };
}
