import * as api from "@opentelemetry/api";
export interface ShravelleOptions {
  endpoint?: string;          // SHRAVELLE_ENDPOINT, default http://localhost:4318
  apiKey?: string;            // SHRAVELLE_API_KEY (shv_ing_...)
  serviceName?: string;       // SHRAVELLE_SERVICE_NAME
  serviceVersion?: string;    // SHRAVELLE_SERVICE_VERSION
  environment?: string;       // SHRAVELLE_ENV
  sampleRate?: number;        // 0..1 head sampling (errors are still kept by the gateway)
  captureLogs?: boolean;      // forward console.* as logs (default true)
  metricIntervalMs?: number;
  instrumentations?: Record<string, unknown>; // per-instrumentation config for auto-instrumentations-node
  resourceAttributes?: Record<string, string>;
  debug?: boolean;
  profiling?: boolean;         // continuous CPU/heap profiling (default true, SHRAVELLE_PROFILING=false to disable)
  profilingHeap?: boolean;     // live-heap profile via V8 sampling (default true)
  profileIntervalMs?: number;  // default 60000
  profileCpuMs?: number;       // CPU profile length per interval, default 10000
  runtimeMetrics?: boolean;    // CPU, memory, heap, event-loop delay (default true)
}
export function init(opts?: ShravelleOptions): typeof api;
export function shutdown(): Promise<void>;
export function noticeError(err: unknown, attributes?: Record<string, string>): void;
export function addAttributes(attrs: Record<string, string | number | boolean>): void;
export function setUser(id: string | number, attrs?: Record<string, string>): void;
export function recordEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
export function startSegment<T>(name: string, fn: (span: api.Span) => T | Promise<T>, attributes?: Record<string, string>): Promise<T>;
export function counter(name: string, opts?: api.MetricOptions): api.Counter;
export function histogram(name: string, opts?: api.MetricOptions): api.Histogram;
export function gauge(name: string, opts?: api.MetricOptions): api.Gauge | api.UpDownCounter;
export function recordDeployment(d: { version?: string; commit?: string; description?: string; user?: string }): Promise<void>;
export function expressErrorHandler(): (err: unknown, req: unknown, res: unknown, next: (e?: unknown) => void) => void;
export { api };
