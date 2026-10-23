#!/usr/bin/env node
// shravelle-node deploy --version 1.2.3 [--commit sha] [--description "..."]
const shravelle = require("..");
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : ""; };
if (args[0] === "deploy") {
  shravelle.recordDeployment({ version: get("version"), commit: get("commit"), description: get("description"), user: process.env.USER || "" })
    .then(() => console.log("deployment recorded")).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  console.log("usage: shravelle-node deploy --version <v> [--commit <sha>] [--description <text>]");
}
