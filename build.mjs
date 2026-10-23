// Build script for the Shravelle Node SDK.
// Bundles and minifies the first-party source into dist/ so the published
// package ships optimized, non-readable code. Third-party dependencies
// (OpenTelemetry, etc.) stay external and are installed normally at runtime,
// so dynamic auto-instrumentation keeps working.
//
//   npm run build
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
const banner = { js: `/*! Shravelle Node SDK v${pkg.version} | (c) Shravelle | MIT | https://shravelle.com */` };
const base = { minify: true, platform: "node", target: ["node18"], legalComments: "none", banner, logLevel: "info" };

// Main entry: bundle in ./profiler.js, keep OTel + other deps external.
await build({ ...base, entryPoints: ["index.js"], outfile: "dist/index.js", format: "cjs", bundle: true, packages: "external" });

// Preloader and CLI: minify only, keep their require() of the built main intact
// (no second copy of index.js inlined).
await build({ ...base, entryPoints: ["register.js"], outfile: "dist/register.js", format: "cjs", bundle: false });
await build({ ...base, entryPoints: ["bin/shravelle-node.js"], outfile: "dist/bin/shravelle-node.js", format: "cjs", bundle: false });
