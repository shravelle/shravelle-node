"use strict";
/**
 * Continuous profiling and runtime metrics for Node.js, using only built-in
 * modules (inspector, perf_hooks, v8).
 *
 * Every `intervalMs` (60 s) the profiler uploads to POST /v1/profiles:
 *   cpu          a `cpuMs` (10 s) V8 CPU profile, sampled every 10 ms
 *   inuse_space  live memory per allocation stack (V8 sampling heap profiler,
 *                one sample per 32 KiB allocated on average; very low overhead)
 *
 * Runtime metrics: process.cpu.utilization, process.memory.usage,
 * v8js.memory.heap.used, v8js.memory.heap.limit, nodejs.eventloop.delay.p99 (s).
 */
const inspector = require("inspector");
const http = require("http");
const https = require("https");
const os = require("os");
const v8 = require("v8");
const zlib = require("zlib");
const { monitorEventLoopDelay } = require("perf_hooks");

function post(session, method, params) {
  return new Promise((resolve, reject) => session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res))));
}

function frameName(cf) {
  const fn = cf.functionName || "(anonymous)";
  if (!cf.url) return fn;
  const file = cf.url.replace(/^file:\/\//, "").split("/").slice(-2).join("/");
  return `${fn} (${file}:${(cf.lineNumber || 0) + 1})`.replace(/;/g, ":");
}

/** V8 CPU profile -> folded stacks with nanoseconds per stack. */
function foldCpu(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const stackOf = new Map();
  const stack = (id) => {
    if (stackOf.has(id)) return stackOf.get(id);
    const frames = [];
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const n = byId.get(cur);
      if (n.callFrame.functionName === "(root)") break;
      frames.push(frameName(n.callFrame));
    }
    const s = frames.reverse().join(";");
    stackOf.set(id, s);
    return s;
  };
  const out = new Map();
  const samples = profile.samples || [], deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]);
    const name = n && n.callFrame.functionName;
    if (!n || name === "(idle)" || name === "(program)") continue; // not JavaScript CPU
    const us = deltas[i + 1] !== undefined ? deltas[i + 1] : deltas[i] || 0;
    const s = stack(samples[i]);
    if (s) out.set(s, (out.get(s) || 0) + Math.max(0, us) * 1000);
  }
  return out;
}

/** V8 sampling heap profile -> folded stacks with live bytes per stack. */
function foldHeap(head) {
  const out = new Map();
  const walk = (node, path) => {
    const name = node.callFrame.functionName === "(root)" ? null : frameName(node.callFrame);
    const p = name ? path.concat(name) : path;
    if (node.selfSize > 0 && p.length) {
      const k = p.join(";");
      out.set(k, (out.get(k) || 0) + node.selfSize);
    }
    for (const c of node.children || []) walk(c, p);
  };
  walk(head, []);
  return out;
}

class Profiler {
  constructor(cfg) {
    this.cfg = Object.assign({ intervalMs: 60000, cpuMs: 10000, heap: true }, cfg);
    this.session = null;
    this.timer = null;
    this.stopped = false;
  }

  async start() {
    try {
      this.session = new inspector.Session();
      this.session.connect();
      await post(this.session, "Profiler.enable");
      await post(this.session, "Profiler.setSamplingInterval", { interval: 10000 }); // microseconds
      if (this.cfg.heap) await post(this.session, "HeapProfiler.startSampling", { samplingInterval: 32768 });
    } catch (e) {
      if (this.cfg.debug) console.warn("[shravelle] profiler unavailable:", e.message);
      return;
    }
    this.timer = setTimeout(() => this.tick(), 5000);
    this.timer.unref();
  }

  async tick() {
    if (this.stopped) return;
    const started = Date.now();
    try {
      await post(this.session, "Profiler.start");
      await new Promise((r) => { const t = setTimeout(r, this.cfg.cpuMs); t.unref(); });
      const { profile } = await post(this.session, "Profiler.stop");
      this.upload({ type: "cpu", unit: "nanoseconds", duration: String(Math.round(this.cfg.cpuMs / 1000)) }, foldCpu(profile));
      if (this.cfg.heap) {
        const { profile: hp } = await post(this.session, "HeapProfiler.getSamplingProfile");
        this.upload({ type: "inuse_space", unit: "bytes" }, foldHeap(hp.head));
      }
    } catch (e) {
      if (this.cfg.debug) console.warn("[shravelle] profile failed:", e.message);
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => this.tick(), Math.max(1000, this.cfg.intervalMs - (Date.now() - started)));
      this.timer.unref();
    }
  }

  upload(params, folded) {
    if (!folded.size) return;
    let text = "";
    for (const [k, v] of folded) if (v > 0) text += `${k} ${Math.round(v)}\n`;
    const body = zlib.gzipSync(text);
    const q = new URLSearchParams(Object.assign(params, {
      service: this.cfg.serviceName, version: this.cfg.serviceVersion || "", env: this.cfg.environment || "",
      host: this.cfg.host || os.hostname(), language: "node",
    }));
    const u = new URL(this.cfg.endpoint.replace(/\/$/, "") + "/v1/profiles?" + q.toString());
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "POST", headers: { "Content-Type": "text/plain", "Content-Encoding": "gzip", "X-API-Key": this.cfg.apiKey, "Content-Length": body.length } },
      (res) => res.resume());
    req.on("error", () => {}); // best effort; the next interval sends fresh data
    req.setTimeout(20000, () => req.destroy());
    req.end(body);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.session && this.session.disconnect(); } catch (_) { /* ignore */ }
  }
}

/** Observable gauges for the APM Runtime tab. */
function registerRuntimeMetrics(meter) {
  const ncpu = os.cpus().length || 1;
  let last = process.cpuUsage(), lastAt = process.hrtime.bigint();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  meter.createObservableGauge("process.cpu.utilization", { unit: "1", description: "CPU used by the process, fraction of all CPUs" })
    .addCallback((r) => {
      const now = process.hrtime.bigint(), cur = process.cpuUsage();
      const wallUs = Number(now - lastAt) / 1000;
      if (wallUs > 0) r.observe(Math.max(0, (cur.user - last.user + cur.system - last.system) / wallUs / ncpu));
      last = cur; lastAt = now;
    });
  meter.createObservableGauge("process.memory.usage", { unit: "By" }).addCallback((r) => r.observe(process.memoryUsage().rss));
  meter.createObservableGauge("v8js.memory.heap.used", { unit: "By" }).addCallback((r) => r.observe(process.memoryUsage().heapUsed));
  meter.createObservableGauge("v8js.memory.heap.limit", { unit: "By" }).addCallback((r) => r.observe(v8.getHeapStatistics().heap_size_limit));
  meter.createObservableGauge("nodejs.eventloop.delay.p99", { unit: "s" }).addCallback((r) => {
    if (loop.count > 0) r.observe(loop.percentile(99) / 1e9);
    loop.reset();
  });
}

module.exports = { Profiler, registerRuntimeMetrics, foldCpu, foldHeap };
