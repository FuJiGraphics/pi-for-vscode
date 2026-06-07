// Bundles the webview TypeScript sources (src/webview) into a single browser
// script at media/chat/chat.js. The extension host code is compiled separately
// by tsc; this only handles the webview, which runs in the browser sandbox.
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  outfile: "media/chat/chat.js",
  sourcemap: true,
  // Shiki + grammars push the raw bundle near 1 MB; minify production builds (sourcemap kept,
  // and .map is excluded from the VSIX). Skip under --watch so dev rebuilds stay fast/readable.
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
