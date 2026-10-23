"use strict";
/**
 * Shravelle APM for Node.js.
 *
 *   // first line of your app (or: node -r @shravelle/node/register app.js)
 *   require("@shravelle/node").init({ serviceName: "checkout", apiKey: process.env.SHRAVELLE_API_KEY });
 *
 * Built on OpenTelemetry: every popular framework and client library is
 * instrumented automatically, data is exported as OTLP/protobuf to the
 * Shravelle ingest gateway, and the Shravelle helpers below add custom events,
 * user context, error reporting and deployment markers.
 */
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-proto");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-proto");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { TraceIdRatioBasedSampler, ParentBasedSampler } = require("@opentelemetry/sdk-trace-base");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const api = require("@opentelemetry/api");
const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
const os = require("os");

let sdk = null;
let cfg = null;
let logger = null;
let profiler = null;

function env(name, def) { return process.env[name] !== undefined && process.env[name] !== "" ? process.env[name] : def; }

/**
 * @param {import("./index").ShravelleOptions} opts
 */
function init(opts = {}) {
  if (sdk) return api;
  cfg = {
    endpoint: (opts.endpoint || env("SHRAVELLE_ENDPOINT", "http://localhost:4318")).replace(/\/$/, ""),
    apiKey: opts.apiKey || env("SHRAVELLE_API_KEY", env("SHRAVELLE_LICENSE_KEY", "")),
    serviceName: opts.serviceName || env("SHRAVELLE_APP_NAME", env("SHRAVELLE_SERVICE_NAME", env("OTEL_SERVICE_NAME", process.env.npm_package_name || "node-app"))),
    serviceVersion: opts.serviceVersion || env("SHRAVELLE_APP_VERSION", env("SHRAVELLE_SERVICE_VERSION", process.env.npm_package_version || "")),
    environment: opts.environment || env("SHRAVELLE_APP_ENV", env("SHRAVELLE_ENV", env("NODE_ENV", "production"))),
    organisation: opts.organisation || env("SHRAVELLE_ORGANISATION", env("SHRAVELLE_ORGANIZATION", "")),
    sampleRate: Number(opts.sampleRate ?? env("SHRAVELLE_SAMPLE_RATE", 1)),
    captureLogs: opts.captureLogs ?? env("SHRAVELLE_CAPTURE_CONSOLE", "true") !== "false",
    metricIntervalMs: Number(opts.metricIntervalMs ?? 30000),
    instrumentations: opts.instrumentations || {},
    debug: opts.debug || env("SHRAVELLE_DEBUG", "") === "true",
  };
  if (!cfg.apiKey) { console.warn("[shravelle] SHRAVELLE_API_KEY is not set; telemetry will be rejected"); }
  if (cfg.debug) api.diag.setLogger(new api.DiagConsoleLogger(), api.DiagLogLevel.INFO);
  const headers = { "x-api-key": cfg.apiKey };
  const resource = resourceFromAttributes({
    "service.name": cfg.serviceName,
    "service.version": cfg.serviceVersion,
    "deployment.environment.name": cfg.environment,
    "host.name": env("SHRAVELLE_HOSTNAME", os.hostname()),
    "process.runtime.name": "nodejs",
    "process.runtime.version": process.versions.node,
    "telemetry.distro.name": "shravelle-node",
    ...(cfg.organisation ? { "shravelle.organization": cfg.organisation } : {}),
    ...(opts.resourceAttributes || {}),
  });
  sdk = new NodeSDK({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(cfg.sampleRate) }),
    traceExporter: new OTLPTraceExporter({ url: cfg.endpoint + "/v1/traces", headers }),
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: cfg.endpoint + "/v1/metrics", headers }), exportIntervalMillis: cfg.metricIntervalMs }),
    logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: cfg.endpoint + "/v1/logs", headers }))],
    instrumentations: [getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false }, // very noisy, rarely useful
      ...cfg.instrumentations,
    })],
  });
  sdk.start();
  logger = logs.getLogger("shravelle");
  try {
    const { Profiler, registerRuntimeMetrics } = require("./profiler");
    if (opts.runtimeMetrics !== false) registerRuntimeMetrics(api.metrics.getMeter("shravelle.runtime"));
    if ((opts.profiling ?? env("SHRAVELLE_PROFILING", "true") !== "false")) {
      profiler = new Profiler({ endpoint: cfg.endpoint, apiKey: cfg.apiKey, serviceName: cfg.serviceName, serviceVersion: cfg.serviceVersion,
        environment: cfg.environment, host: env("SHRAVELLE_HOSTNAME", os.hostname()), intervalMs: opts.profileIntervalMs || 60000,
        cpuMs: opts.profileCpuMs || 10000, heap: opts.profilingHeap ?? env("SHRAVELLE_PROFILING_HEAP", "true") !== "false", debug: cfg.debug });
      profiler.start();
    }
  } catch (e) { if (cfg.debug) console.warn("[shravelle] profiling/runtime metrics disabled:", e.message); }
  if (cfg.captureLogs) patchConsole();
  process.on("uncaughtExceptionMonitor", (err) => noticeError(err, { "exception.escaped": "true", fatal: "true" }));
  process.on("unhandledRejection", (reason) => noticeError(reason instanceof Error ? reason : new Error(String(reason)), { "exception.escaped": "true" }));
  const stop = () => shutdown().finally(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return api;
}

const LEVELS = { log: ["INFO", SeverityNumber.INFO], info: ["INFO", SeverityNumber.INFO], warn: ["WARN", SeverityNumber.WARN], error: ["ERROR", SeverityNumber.ERROR], debug: ["DEBUG", SeverityNumber.DEBUG] };
function patchConsole() {
  for (const m of Object.keys(LEVELS)) {
    const orig = console[m].bind(console);
    console[m] = (...args) => {
      orig(...args);
      try {
        const [text, num] = LEVELS[m];
        const err = args.find((a) => a instanceof Error);
        const attrs = err ? { "exception.type": err.name, "exception.message": err.message, "exception.stacktrace": err.stack || "" } : {};
        logger.emit({ severityText: text, severityNumber: num, body: args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : safeJSON(a))).join(" "), attributes: attrs });
      } catch (_) { /* never break the app */ }
    };
  }
}
function safeJSON(v) { try { return JSON.stringify(v); } catch (_) { return String(v); } }

/** Record an error on the active span (or a standalone error log). */
function noticeError(err, attributes = {}) {
  if (!err) return;
  const span = api.trace.getActiveSpan();
  if (span) {
    span.recordException(err);
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: err.message });
    span.setAttributes(attributes);
  }
  if (logger) logger.emit({ severityText: "ERROR", severityNumber: SeverityNumber.ERROR, body: err.message,
    attributes: { "exception.type": err.name || "Error", "exception.message": err.message || String(err), "exception.stacktrace": err.stack || "", ...attributes } });
}

/** Add attributes to the current transaction (span). */
function addAttributes(attrs) { const s = api.trace.getActiveSpan(); if (s) s.setAttributes(attrs); }

/** Associate the current request with a user (shows "users affected"). */
function setUser(id, attrs = {}) { addAttributes({ "enduser.id": String(id), ...attrs }); }

/** Record a business event (queryable as a log with event.name). */
function recordEvent(name, attributes = {}) {
  if (logger) logger.emit({ severityText: "INFO", severityNumber: SeverityNumber.INFO, body: name, attributes: { "event.name": name, ...attributes } });
}

/** Run fn inside a custom span ("segment"), e.g. startSegment("pricing.calculate", () => calc()). */
function startSegment(name, fn, attributes = {}) {
  return api.trace.getTracer("shravelle").startActiveSpan(name, { attributes }, async (span) => {
    try { return await fn(span); } catch (e) { span.recordException(e); span.setStatus({ code: api.SpanStatusCode.ERROR }); throw e; } finally { span.end(); }
  });
}

/** Custom metrics: counter("orders.placed").add(1, { country: "IN" }) */
function counter(name, opts) { return api.metrics.getMeter("shravelle").createCounter(name, opts); }
function histogram(name, opts) { return api.metrics.getMeter("shravelle").createHistogram(name, opts); }
function gauge(name, opts) { return api.metrics.getMeter("shravelle").createGauge ? api.metrics.getMeter("shravelle").createGauge(name, opts) : api.metrics.getMeter("shravelle").createUpDownCounter(name, opts); }

/** Record a deployment marker (call from your release script). */
async function recordDeployment({ version, commit = "", description = "", user = "" } = {}) {
  const c = cfg || { endpoint: env("SHRAVELLE_ENDPOINT", "http://localhost:4318"), apiKey: env("SHRAVELLE_API_KEY", ""), serviceName: env("SHRAVELLE_SERVICE_NAME", "node-app") };
  const res = await fetch(c.endpoint.replace(/\/$/, "") + "/v1/deployments", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": c.apiKey },
    body: JSON.stringify({ service: c.serviceName, version: version || c.serviceVersion, commit, description, user }) });
  if (!res.ok) throw new Error("deployment marker failed: HTTP " + res.status);
}

/** Flush and stop exporting (called automatically on SIGTERM/SIGINT). */
async function shutdown() { if (profiler) { profiler.stop(); profiler = null; } if (sdk) { const s = sdk; sdk = null; await s.shutdown().catch(() => {}); } }

/** Express error middleware: app.use(shravelle.expressErrorHandler()) after your routes. */
function expressErrorHandler() { return (err, req, res, next) => { noticeError(err); next(err); }; }

module.exports = { init, shutdown, noticeError, addAttributes, setUser, recordEvent, startSegment, counter, histogram, gauge, recordDeployment, expressErrorHandler, api };
