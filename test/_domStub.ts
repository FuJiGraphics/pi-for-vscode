// Test helper (NOT a *.test.ts). Webview modules whose import chain reaches dom.ts resolve
// their elements at module load via document.getElementById/querySelector, and connectionBanner
// adds a listener at load — none of which exist under Node. This installs a minimal DOM so those
// imports succeed. Must be imported BEFORE the webview modules under test.
//
// State-based tests do NOT run render() (requestAnimationFrame is a no-op here), so the fakes
// only need to be non-null and swallow the no-op mutations made during import + event replay.
function fakeElement(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {} },
    dataset: {},
    children: [] as unknown[],
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    value: "",
    className: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    offsetHeight: 0,
    offsetWidth: 0,
    spellcheck: false,
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    append() {},
    appendChild() {},
    insertBefore() {},
    removeChild() {},
    remove() {},
    focus() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}

const doc = {
  getElementById: () => fakeElement(),
  querySelector: () => fakeElement(),
  createElement: () => fakeElement(),
  addEventListener() {},
  removeEventListener() {},
};

const g = globalThis as Record<string, unknown>;
if (!g.document) g.document = doc;
if (!g.window) g.window = g;
if (typeof g.requestAnimationFrame !== "function") g.requestAnimationFrame = () => 0;
if (typeof g.cancelAnimationFrame !== "function") g.cancelAnimationFrame = () => undefined;
if (typeof g.matchMedia !== "function") g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
