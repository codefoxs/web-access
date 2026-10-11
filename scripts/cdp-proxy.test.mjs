import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = `
import fs from 'node:fs';
import path from 'node:path';
export const root = process.env.TEST_RUNTIME_ROOT;
export function record(action, data = {}) {
  fs.appendFileSync(path.join(root, 'events-' + process.pid + '.jsonl'), JSON.stringify({ action, pid: process.pid, ...data }) + '\\n');
}
export function waitBarrier(name) {
  const file = path.join(root, name + '-release');
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise(resolve => {
    const watcher = fs.watch(root, () => {
      if (fs.existsSync(file)) { watcher.close(); resolve(); }
    });
    if (fs.existsSync(file)) { watcher.close(); resolve(); }
  });
}
`;
const DISCOVERY = `
import { record, waitBarrier } from './fake-runtime.mjs';
export async function selectBrowser() {
  record('discovery');
  if (process.env.TEST_HOLD_DISCOVERY === '1') await waitBarrier('discovery');
  return { kind: 'ok', browser: { id: 'chrome', label: 'Fake Chrome', port: 9222, wsPath: '/fake-browser' }, source: 'preference' };
}
export async function findFallbackPort() { throw new Error('Unexpected fallback discovery'); }
`;
const PRELOAD = `
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { root, record, waitBarrier } from './fake-runtime.mjs';
const originalCreateServer = http.createServer;
http.createServer = function (...args) {
  const index = args.findIndex(value => typeof value === 'function');
  if (index !== -1) {
    const listener = args[index];
    args[index] = function (req, res) { record('request', { url: req.url }); return listener.call(this, req, res); };
  }
  return originalCreateServer.apply(this, args);
};
if (process.env.TEST_HOLD_SHUTDOWN === '1') {
  const originalClose = http.Server.prototype.close;
  http.Server.prototype.close = function (callback) {
    record('server-close');
    waitBarrier('shutdown').then(() => originalClose.call(this, callback));
    return this;
  };
}
class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  constructor(url) {
    super();
    this.readyState = 0;
    record('socket', { url });
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      record('opened');
      if (process.env.TEST_BACKGROUND_PENDING === '1') {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId: 'fake-request', sessionId: 'fake-session' } }) }));
      }
    });
  }
  send(text) {
    const message = JSON.parse(text);
    record('command', { method: message.method, id: message.id });
    void this.respond(message);
  }
  async respond(message) {
    if (message.method === 'Target.getTargets' && process.env.TEST_HOLD_TARGETS === '1') await waitBarrier('targets');
    if (message.method === 'Fetch.failRequest' && process.env.TEST_BACKGROUND_PENDING === '1') await waitBarrier('pending');
    let result = {};
    if (message.method === 'Target.getTargets') result = { targetInfos: [{ targetId: 'user-page', type: 'page', title: 'Fake page', url: 'about:blank' }] };
    if (message.method === 'Target.createTarget') result = { targetId: 'managed-page' };
    if (message.method === 'Target.closeTarget') result = { success: true };
    if (message.method === 'Target.attachToTarget') result = { sessionId: 'fake-session' };
    if (message.method === 'Runtime.evaluate') {
      if (message.params.expression.includes('JSON.stringify({ ready:')) {
        const ready = fs.existsSync(path.join(root, 'page-release')) ? 'complete' : 'loading';
        result = { result: { value: JSON.stringify({ ready, url: 'https://fake.example/page' }) } };
      } else result = { result: { value: 'fake value' } };
    }
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result }) }));
    record('response', { method: message.method, complete: message.method === 'Runtime.evaluate' && fs.existsSync(path.join(root, 'page-release')) });
  }
  close() {
    this.readyState = 3;
    record('socket-close');
    this.dispatchEvent(new Event('close'));
  }
}
globalThis.WebSocket = FakeWebSocket;
`;

function beginRequest(port, endpoint, { method = 'GET', body, headers = {}, deferBody = false } = {}) {
  const encoded = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  let request;
  const done = new Promise((resolve, reject) => {
    request = http.request({
      hostname: '127.0.0.1', port, path: endpoint, method, agent: false,
      headers: { ...(encoded === undefined ? {} : { 'Content-Length': Buffer.byteLength(encoded), 'Content-Type': 'application/json' }), ...headers },
    }, res => {
      let content = '';
      res.setEncoding('utf8');
      res.on('data', data => { content += data; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(content) }); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('Test HTTP request timed out')));
    if (deferBody) request.flushHeaders();
    else request.end(encoded);
  });
  return { request, done, finish: () => request.end(encoded) };
}

const requestJson = (port, endpoint, options) => beginRequest(port, endpoint, options).done;

async function fixture(t, flags = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-access-proxy-'));
  const scripts = path.join(root, 'scripts');
  await fsp.mkdir(scripts);
  for (const name of ['cdp-proxy.mjs', 'cdp-connection.mjs']) {
    await fsp.copyFile(path.join(SCRIPTS, name), path.join(scripts, name));
  }
  await fsp.writeFile(path.join(scripts, 'fake-runtime.mjs'), RUNTIME);
  await fsp.writeFile(path.join(scripts, 'browser-discovery.mjs'), DISCOVERY);
  await fsp.writeFile(path.join(scripts, 'preload.mjs'), PRELOAD);
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const children = [];
  const events = async () => {
    const files = (await fsp.readdir(root)).filter(name => name.endsWith('.jsonl'));
    const lines = await Promise.all(files.map(name => fsp.readFile(path.join(root, name), 'utf8')));
    return lines.flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
  };
  const waitEvent = predicate => new Promise((resolve, reject) => {
    let finished = false;
    const watcher = fs.watch(root, () => { void inspect(); });
    const timeout = setTimeout(() => finish(new Error('Expected test event did not arrive')), 8000);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      watcher.close();
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    }
    async function inspect() {
      try {
        const value = predicate(await events());
        if (value) finish(null, value);
      } catch (error) { finish(error); }
    }
    void inspect();
  });
  t.after(async () => {
    // 只强制清理本测试创建的子进程；不按名称或端口终止真实服务。
    for (const entry of children) if (entry.child.exitCode === null) entry.child.kill('SIGKILL');
    await Promise.all(children.map(entry => entry.exited));
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    port, root, scripts, events, waitEvent,
    release: name => fsp.writeFile(path.join(root, name + '-release'), ''),
    spawn() {
      const child = spawn(process.execPath, ['--import', path.join(scripts, 'preload.mjs'), path.join(scripts, 'cdp-proxy.mjs')], {
        env: { ...process.env, CDP_PROXY_PORT: String(port), TEST_RUNTIME_ROOT: root, ...flags },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, pid: child.pid }));
      });
      const entry = { child, exited, get output() { return output; } };
      children.push(entry);
      return entry;
    },
    async ready(entry) {
      await waitEvent(list => list.find(event => event.action === 'opened' && event.pid === entry.child.pid));
      return (await requestJson(port, '/health')).body;
    },
  };
}

async function shutdown(f, health) {
  return requestJson(f.port, '/shutdown', { method: 'POST', body: { instanceId: health.instanceId } });
}

test('真实 HTTP 并行请求在首次发现阶段共享一次发现和一次握手', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_HOLD_DISCOVERY: '1' });
  const entry = f.spawn();
  await f.waitEvent(events => events.find(event => event.action === 'discovery'));
  const initial = (await requestJson(f.port, '/health')).body;
  assert.equal(initial.connectionState, 'discovering');
  assert.equal(initial.connectionAttempts, 1);
  assert.equal(initial.connected, false);
  assert.equal(initial.activeRequests, 0);
  assert.equal(initial.pendingCommands, 0);
  assert.equal((await shutdown(f, initial)).status, 409, '只有发现过程进行中也不能维护');
  const requests = Promise.all([requestJson(f.port, '/targets'), requestJson(f.port, '/targets')]);
  await f.waitEvent(events => events.filter(event => event.action === 'request' && event.url === '/targets').length === 2);
  assert.equal((await requestJson(f.port, '/health')).body.activeRequests, 2);
  await f.release('discovery');
  for (const response of await requests) {
    assert.equal(response.status, 200);
    assert.equal(response.body[0].targetId, 'user-page');
  }
  const events = await f.events();
  assert.equal(events.filter(event => event.action === 'discovery').length, 1);
  assert.equal(events.filter(event => event.action === 'socket').length, 1);
  assert.equal(events.filter(event => event.action === 'command' && event.method === 'Target.getTargets').length, 2);
  const health = await f.ready(entry);
  assert.equal(health.connectionAttempts, 1);
  assert.equal(health.activeRequests, 0);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('两个子进程原子争抢同一端口，只有赢家发现和连接浏览器', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const first = f.spawn();
  const second = f.spawn();
  const loser = await Promise.race([first.exited, second.exited]);
  assert.equal(loser.code, 0);
  const winner = loser.pid === first.child.pid ? second : first;
  const health = await f.ready(winner);
  assert.equal(health.pid, winner.child.pid);
  const events = await f.events();
  assert.equal(events.filter(event => event.action === 'discovery').length, 1);
  assert.equal(events.filter(event => event.action === 'socket').length, 1);
  assert.equal(events.filter(event => event.pid === loser.pid && ['discovery', 'socket'].includes(event.action)).length, 0);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await winner.exited).code, 0);
});

test('/health 提供稳定实例、运行版本与连接和占用状态', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  const revision = createHash('sha256')
    .update(await fsp.readFile(path.join(f.scripts, 'cdp-proxy.mjs')))
    .update(await fsp.readFile(path.join(f.scripts, 'cdp-connection.mjs')))
    .digest('hex').slice(0, 12);
  assert.match(health.instanceId, /^[0-9a-f-]{36}$/);
  assert.equal(health.runningRevision, revision);
  assert.ok(Number.isFinite(Date.parse(health.startedAt)));
  assert.equal(health.pid, entry.child.pid);
  assert.equal(health.connectionState, 'connected');
  assert.equal(health.connectionAttempts, 1);
  assert.equal(health.pendingCommands, 0);
  assert.equal(health.activeRequests, 0);
  assert.equal(health.maintenance, false);
  assert.equal((await requestJson(f.port, '/health')).body.instanceId, health.instanceId);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 拒绝 GET、Origin、非法 JSON 与不匹配实例，空闲后接受并退出', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  assert.equal((await requestJson(f.port, '/shutdown')).status, 403);
  assert.equal((await requestJson(f.port, '/shutdown', { method: 'POST', headers: { Origin: 'https://example.com' }, body: { instanceId: health.instanceId } })).status, 403);
  assert.equal((await requestJson(f.port, '/shutdown', { method: 'POST', body: '{broken' })).status, 400);
  for (const body of [null, { instanceId: 'wrong-instance' }]) {
    const response = await requestJson(f.port, '/shutdown', { method: 'POST', body });
    assert.equal(response.status, 409);
    assert.equal(response.body.instanceId, health.instanceId);
  }
  assert.equal((await requestJson(f.port, '/health')).body.maintenance, false);
  const response = await shutdown(f, health);
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'stopping');
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 在 HTTP 请求和 CDP 命令都等待时拒绝关闭', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_HOLD_TARGETS: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  const targets = requestJson(f.port, '/targets');
  await f.waitEvent(events => events.find(event => event.action === 'command' && event.method === 'Target.getTargets'));
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.activeRequests, 1);
  assert.equal(busy.body.pendingCommands, 1);
  await f.release('targets');
  assert.equal((await targets).status, 200);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 单独存在 HTTP handler 时也拒绝关闭', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  const active = beginRequest(f.port, '/eval?target=user-page', { method: 'POST', body: 'document.title', deferBody: true });
  await f.waitEvent(events => events.find(event => event.action === 'response' && event.method === 'Fetch.enable'));
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.activeRequests, 1);
  assert.equal(busy.body.pendingCommands, 0);
  active.finish();
  assert.equal((await active.done).status, 200);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 单独存在后台 CDP 命令时也拒绝关闭', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_BACKGROUND_PENDING: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  await f.waitEvent(events => events.find(event => event.action === 'command' && event.method === 'Fetch.failRequest'));
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.activeRequests, 0);
  assert.equal(busy.body.pendingCommands, 1);
  await f.release('pending');
  await f.waitEvent(events => events.find(event => event.action === 'response' && event.method === 'Fetch.failRequest'));
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 单独存在受管标签页时拒绝关闭，关闭标签页后才可维护', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  const created = await requestJson(f.port, '/new', { method: 'POST', body: 'about:blank' });
  assert.equal(created.status, 200);
  assert.equal(created.body.targetId, 'managed-page');
  const occupied = (await requestJson(f.port, '/health')).body;
  assert.equal(occupied.managedTabs, 1);
  assert.equal(occupied.activeRequests, 0);
  assert.equal(occupied.pendingCommands, 0);
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.managedTabs, 1);
  assert.equal(busy.body.activeRequests, 0);
  assert.equal(busy.body.pendingCommands, 0);
  assert.equal((await requestJson(f.port, '/close?target=managed-page')).status, 200);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('客户端断开后仍在运行的导航 handler 持续占用，完成后才可维护', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  const navigation = beginRequest(f.port, '/navigate?target=user-page', { method: 'POST', body: 'https://fake.example/page' });
  const aborted = navigation.done.catch(error => error);
  await f.waitEvent(events => events.find(event => event.action === 'response' && event.method === 'Page.enable'));
  navigation.request.destroy();
  assert.ok(await aborted instanceof Error);
  const occupied = (await requestJson(f.port, '/health')).body;
  assert.equal(occupied.managedTabs, 0);
  assert.equal(occupied.pendingCommands, 0);
  assert.equal(occupied.activeRequests, 1);
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.activeRequests, 1);
  await f.release('page');
  await f.waitEvent(events => events.find(event => event.action === 'response' && event.method === 'Runtime.evaluate' && event.complete));
  assert.equal((await requestJson(f.port, '/health')).body.activeRequests, 0);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('维护过程中普通 API 返回 503，释放退出屏障后正常退出', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_HOLD_SHUTDOWN: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  assert.equal((await shutdown(f, health)).status, 202);
  await f.waitEvent(events => events.find(event => event.action === 'server-close'));
  assert.equal((await requestJson(f.port, '/health')).body.maintenance, true);
  const response = await requestJson(f.port, '/targets');
  assert.equal(response.status, 503);
  assert.match(response.body.error, /维护/);
  assert.equal((await f.events()).filter(event => event.action === 'command').length, 0);
  await f.release('shutdown');
  assert.equal((await entry.exited).code, 0);
});
