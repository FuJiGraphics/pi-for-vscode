// Bundles the webview TypeScript sources (src/webview) into a single browser
// script at media/chat/chat.js. The extension host code is compiled separately
// by tsc; this only handles the webview, which runs in the browser sandbox.
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  // ESM + code splitting so each Shiki grammar (dynamically imported via shiki/langs) becomes its
  // own chunk, fetched on demand — the entry stays small and all ~332 languages are available
  // without bundling them all. Entry → media/chat/main.js, grammars → media/chat/chunk-*.js. The
  // webview loads main.js as a module (CSP needs 'strict-dynamic'; see webviewHtml.ts).
  format: "esm",
  splitting: true,
  platform: "browser",
  target: ["es2020"],
  outdir: "media/chat",
  sourcemap: true,
  // Minify production builds (sourcemap kept, .map excluded from the VSIX). Skip under --watch so
  // dev rebuilds stay fast/readable.
  minify: !watch,
  logLevel: "info",
};

async function run() {
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log("[esbuild] watching webview sources…");
  } else {
    await esbuild.build(options);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
