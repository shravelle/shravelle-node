#!/usr/bin/env node
/*! Shravelle Node SDK v1.0.0 | (c) Shravelle | MIT | https://shravelle.com */
const n=require(".."),o=process.argv.slice(2),s=e=>{const r=o.indexOf("--"+e);return r>=0?o[r+1]:""};o[0]==="deploy"?n.recordDeployment({version:s("version"),commit:s("commit"),description:s("description"),user:process.env.USER||""}).then(()=>console.log("deployment recorded")).catch(e=>{console.error(e.message),process.exit(1)}):console.log("usage: shravelle-node deploy --version <v> [--commit <sha>] [--description <text>]");
