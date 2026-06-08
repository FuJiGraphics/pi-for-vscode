// Markdown source → safe HTML for chat bubbles. Owns the single markdown-it instance and its
// config. Distinct responsibility from highlight.ts (code → tokenized HTML, which this consumes)
// and util.ts (misc helpers). Both user and assistant bubbles render through renderMarkdown, so
// they get identical treatment.
//
// Safety: html:false escapes any raw HTML in model output (the primary XSS neutralizer — e.g. a
// <script> in a response becomes text), and markdown-it's built-in validateLink blocks dangerous
// link schemes. Combined with the webview CSP (default-src 'none', script-src nonce-only) this is
// sufficient without DOMPurify, keeping the bundle and surface small.
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { escapeHtml } from "./util";
import { highlightToLines, normalizeLang } from "./highlight";
import { installFileLinkRule } from "./fileLinks";

// Render a fenced code block as a Claude-style card: a header bar (language label + Copy/Insert/
// Apply buttons) above the highlighted <pre>. We override markdown-it's `fence` rule rather than
// using its `highlight` option, because that option's return value must START with "<pre>" to be
// emitted verbatim — but we need a wrapping <div> with a header above the <pre>. The buttons carry
// no code payload; the click handler reads the sibling <code>'s textContent (correct for both the
// Shiki-highlighted spans and the escaped-plaintext fallback). Grammars load lazily: an unready /
// not-yet-loaded language renders as plaintext and repaints when its chunk arrives.
function renderFence(content: string, info: string): string {
  const code = content.replace(/\n$/, ""); // markdown-it appends a trailing \n; drop it
  const token = (info || "").trim().split(/\s+/)[0] || ""; // first word of the info string
  const lang = normalizeLang(token); // canonical Shiki id, or "" if unknown
  const lines = lang ? highlightToLines(code, lang) : null;
  const inner = lines ? lines.join("\n") : escapeHtml(code);
  const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : "";
  const label = lang || token || "text";
  return (
    '<div class="md-code-block">' +
    '<div class="md-code-head"><span class="md-code-lang">' +
    escapeHtml(label) +
    '</span><span class="md-code-actions">' +
    '<button class="md-code-btn" data-action="copy-code" type="button">Copy</button>' +
    '<button class="md-code-btn" data-action="insert-code" type="button">Insert</button>' +
    '<button class="md-code-btn" data-action="apply-code" type="button">Apply</button>' +
    "</span></div>" +
    '<pre class="md-code"><code' +
    cls +
    ">" +
    inner +
    "</code></pre></div>"
  );
}

// Tables + strikethrough are on in markdown-it's default preset. linkify:true auto-links bare URLs;
// breaks:false keeps CommonMark paragraph semantics.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
// Only autolink URLs that carry an explicit scheme (https://…), matching the prior renderer. Fuzzy
// linking would otherwise turn bare tokens whose extension is a real TLD (deploy.sh, config.io)
// into bogus external links — common in coding prose. Scheme'd URLs still linkify.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
// GFM task lists: render `- [ ]` / `- [x]` as read-only checkboxes (enabled:false = not clickable).
md.use(taskLists, { enabled: false });
md.renderer.rules.fence = (tokens, idx) => renderFence(tokens[idx].content, tokens[idx].info);
installFileLinkRule(md);

export function renderMarkdown(text: string): string {
  return md.render(text ?? "");
}
