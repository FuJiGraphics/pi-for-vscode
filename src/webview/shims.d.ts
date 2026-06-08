// Ambient type for markdown-it-task-lists (ships no .d.ts and has no @types package).
// It's a standard markdown-it plugin: md.use(taskLists, { enabled, label, labelAfter }).
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }) => void;
  export default plugin;
}
