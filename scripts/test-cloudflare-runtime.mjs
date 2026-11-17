import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Exercise the production scheduling gateway and alarm methods in workerd,
// including persistence after eviction. The container HTTP call is a stand-in.
const bundled = await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: "cloudflare-alarm-test.mjs",
    contents: `
      import {DurableObject} from 'cloudflare:workers';
      import {SignuDocApp, WebhookSchedulerGateway} from './cloudflare/worker.mjs';
      export {WebhookSchedulerGateway};
      export class AlarmTestApp extends DurableObject {
        scheduleWebhookRetry(at) { return SignuDocApp.prototype.scheduleWebhookRetry.call(this, at); }
        alarm() { return SignuDocApp.prototype.alarm.call(this); }
        async runInternalJob(path) {
          await this.ctx.storage.put('path', path);
          await this.ctx.storage.put('calls', (await this.ctx.storage.get('calls') || 0) + 1);
          return new Response(null, {status: 204});
        }
        async state() { return {calls: await this.ctx.storage.get('calls') || 0, path: await this.ctx.storage.get('path'), alarm: await this.ctx.storage.getAlarm()}; }
        async rolloutCheck() {
          let starts = 0, stops = 0;
          const container = {
            running: false, images: {app: 'old-image'},
            async destroy() {stops++; this.running = false;},
            start() {starts++; this.running = true;},
            async interceptOutboundHttp() {},
            async setInactivityTimeout() {},
            getTcpPort() {return {fetch: async () => new Response('ok')};},
          };
          const app = {
            ctx: {container, storage: this.ctx.storage, exports: {StorageGateway: () => ({}), EmailGateway: () => ({}), WebhookSchedulerGateway: () => ({})}},
            containerEnv: async () => ({APP_URL: 'https://sign.example.com'}),
            gatewayToken: async () => 'test-token', observeExit() {},
          };
          await SignuDocApp.prototype.startAndWaitForPort.call(app);
          container.images.app = 'new-image';
          await SignuDocApp.prototype.startAndWaitForPort.call(app);
          await SignuDocApp.prototype.startAndWaitForPort.call(app);
          return {starts, stops};
        }
      }
      export default {async fetch(request, env, ctx) { const path = new URL(request.url).pathname; if (path === '/state') return Response.json(await env.APP.getByName('app').state()); if (path === '/rollout-check') return Response.json(await env.APP.getByName('app').rolloutCheck()); return ctx.exports.WebhookSchedulerGateway({props: {token: 'runtime-test-token'}}).fetch(request);}};
    `,
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  write: false,
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: "alarm-test",
    script: bundled.outputFiles[0].text,
    modules: true,
    compatibilityDate: "2026-11-01",
    durableObjects: { APP: { className: "AlarmTestApp", useSQLite: true } },
  }),
);
try {
  assert.deepEqual(
    await (await mf.dispatchFetch("http://test/rollout-check")).json(),
    { starts: 2, stops: 1 },
  );
  const getState = async () =>
    (await mf.dispatchFetch("http://test/state")).json();
  const schedule = (at, token = "runtime-test-token") =>
    mf.dispatchFetch("http://test/schedule", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ at }),
    });
  assert.equal((await schedule(Date.now(), "wrong")).status, 403);
  assert.equal((await getState()).alarm, null);
  const at = Date.now() + 1300;
  assert.equal((await schedule(at)).status, 204);
  await schedule(at + 60_000);
  assert.equal((await getState()).alarm, at);
  await mf.unsafeEvictDurableObject("alarm-test", "AlarmTestApp", {
    name: "app",
  });
  assert.equal((await getState()).alarm, at);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  const state = await getState();
  assert.equal(state.calls, 1);
  assert.equal(state.path, "/api/internal/webhooks");
  assert.equal(state.alarm, null);
  console.log(
    "Cloudflare runtime: image update restart, authenticated scheduling, earliest retry, persisted alarm, one-shot drain passed.",
  );
} finally {
  await mf.dispose();
}
