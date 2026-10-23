# Node.js

Published as a built, minified package: the first-party source is bundled into `dist/`
(dependencies stay external and install normally). Regenerate with `npm install && npm run build`
(also runs automatically on `npm publish`).

```bash
npm install ./sdks/shravelle-sdk-node      # or publish it to your registry as @shravelle/node
```
```js
// first line of the app, before other requires
require("@shravelle/node").init({ serviceName: "checkout" }); // SHRAVELLE_API_KEY / SHRAVELLE_ENDPOINT from env
```
Zero code: `node -r @shravelle/node/register app.js`, or `npx shravelle-node app.js`.

Auto-instrumented via `@opentelemetry/auto-instrumentations-node`: http/https, Express, Fastify, Koa, Hapi,
NestJS, GraphQL, gRPC, pg, mysql/mysql2, mongodb, mongoose, redis/ioredis, kafkajs, amqplib, AWS SDK, and more.
`console.*` is forwarded as logs (`captureLogs: false` to disable), with trace ids.

## Options
`endpoint`, `apiKey`, `serviceName`, `serviceVersion`, `environment`, `sampleRate`, `captureLogs`,
`metricIntervalMs`, `instrumentations` (per-instrumentation config, e.g. `{"@opentelemetry/instrumentation-fs": {enabled: false}}`),
`resourceAttributes`, `debug`.

## API
```js
const shravelle = require("@shravelle/node");
shravelle.noticeError(err, { order_id: "123" });         // error on the current span → Errors Inbox
shravelle.setUser(user.id, { plan: "pro" });
shravelle.addAttributes({ cart_value: 1450 });
shravelle.recordEvent("coupon_applied", { code: "DIWALI" });
await shravelle.startSegment("pricing.calculate", async (span) => calc());
shravelle.counter("orders_total").add(1, { method: "upi" });
shravelle.histogram("cart_value").record(1450);
await shravelle.recordDeployment({ version: "1.4.2", commit: process.env.GIT_SHA });
app.use(shravelle.expressErrorHandler());               // after routes
await shravelle.shutdown();                              // flush on exit (also done on SIGTERM)
```


---
Part of [Shravelle](https://shravelle.com). Setup guide for every platform: [shravelle.com/docs](https://shravelle.com/docs.html) · Get your keys: [shravelle.com/get-started](https://shravelle.com/get-started.html)
