import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// 所有检查在脚本副本、临时配置和本地假服务上运行，不接触真实浏览器。
async function fixture(t, { configured = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-access-check-deps-'));
  const scripts = path.join(root, 'scripts');
  const temporary = path.join(root, 'tmp');
  const eventsPath = path.join(root, 'events.jsonl');
  await fs.mkdir(scripts);
  await fs.mkdir(temporary);
  await fs.mkdir(path.join(root, 'templates'));
  await fs.copyFile(path.join(SCRIPTS, 'check-deps.mjs'), path.join(scripts, 'check-deps.mjs'));
  await fs.copyFile(path.join(SCRIPTS, 'browser-discovery.mjs'), path.join(scripts, 'browser-discovery-real.mjs'));
  await fs.writeFile(path.join(root, 'config.env'), configured ? `WEB_ACCESS_BROWSER=${configured}\n` : '');

  // 只保留真实的偏好读取；发现浏览器与启动 Proxy 均记录副作用。
  await fs.writeFile(path.join(scripts, 'browser-discovery.mjs'), `
import fs from 'node:fs';
import { getConfiguredBrowserId } from './browser-discovery-real.mjs';
export { getConfiguredBrowserId };
const record = event => fs.appendFileSync(process.env.TEST_EVENTS_PATH, JSON.stringify(event) + '\\n');
export function knownBrowsers() {
  return [{ id: 'chrome', label: 'Chrome' }, { id: 'edge', label: 'Microsoft Edge' }];
}
export async function selectBrowser(override) {
  record({ action: 'selectBrowser', override });
  const id = override || getConfiguredBrowserId() || 'chrome';
  return { kind: 'ok', browser: { id, label: id, port: 9222 }, source: override ? 'override' : 'preference' };
}
export async function findFallbackPort() {
  record({ action: 'findFallbackPort' });
  return null;
}
`);
  await fs.writeFile(path.join(scripts, 'cdp-proxy.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync(process.env.TEST_EVENTS_PATH, JSON.stringify({ action: 'spawn', pid: process.pid, args: process.argv.slice(2) }) + '\\n');
const i = process.argv.indexOf('--browser');
const id = i === -1 ? 'chrome' : process.argv[i + 1];
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/health' ? { status: 'ok', connected: true, browser: { id, label: id } } : []));
}).listen(Number(process.env.CDP_PROXY_PORT), '127.0.0.1');
`);
  // 缩短脚本的轮询间隔，保留实际 HTTP 交互与成功/超时分支。
  const preload = path.join(root, 'fast-timers.mjs');
  await fs.writeFile(preload, `
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(delay, 25), ...args);
`);

  const events = async () => {
    try {
      return (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  t.after(async () => {
    // 只清理本测试记录的假 Proxy，不终止任何真实服务。
    for (const event of await events()) {
      if (event.action === 'spawn') {
        try { process.kill(event.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    events,
    async run(port, args = []) {
      const child = spawn(process.execPath, ['--import', preload, path.join(scripts, 'check-deps.mjs'), ...args], {
        env: {
          ...process.env,
          CDP_PROXY_PORT: String(port),
          TEST_EVENTS_PATH: eventsPath,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        return { code, stdout, stderr };
      } finally {
        clearTimeout(watchdog);
      }
    },
  };
}

async function fakeProxy(t, { browser = 'chrome', connected = true, recover = false, recoverBrowser = null, targetsWhileDisconnected = false, maintenance = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok', connected, maintenance, browser: { id: browser, label: browser } }));
    } else if (req.url === '/targets') {
      if (recover) connected = true;
      if (recoverBrowser) browser = recoverBrowser;
      res.end(JSON.stringify(connected || targetsWhileDisconnected ? [] : { error: 'not connected' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, requests };
}

function success(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /proxy: ready/);
}

test('已连接的服务直接复用，无偏好也不扫描或重新启动', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t);
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.length > 0);
  assert.ok(proxy.requests.every(request => request === '/health'));
});

test('复用时读取 config.env，匹配的偏好无需浏览器发现', async t => {
  const f = await fixture(t, { configured: 'edge' });
  const proxy = await fakeProxy(t, { browser: 'edge' });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
});

for (const connected of [true, false]) {
  test(`维护中的实例不会被当作就绪或另行启动（connected=${connected}）`, async t => {
    const f = await fixture(t);
    const proxy = await fakeProxy(t, { connected, maintenance: true });
    const result = await f.run(proxy.port);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /正在维护/);
    assert.deepEqual(await f.events(), []);
    assert.ok(proxy.requests.every(request => request === '/health'));
  });
}

test('--browser 覆盖 config.env，并且不会改写持久偏好', async t => {
  const f = await fixture(t, { configured: 'edge' });
  const proxy = await fakeProxy(t);
  success(await f.run(proxy.port, ['--browser', 'chrome']));
  assert.deepEqual(await f.events(), []);
  assert.equal(await fs.readFile(path.join(f.root, 'config.env'), 'utf8'), 'WEB_ACCESS_BROWSER=edge\n');
});

for (const { name, configured, args } of [
  { name: 'CLI 指定', configured: 'chrome', args: ['--browser=edge'] },
  { name: 'config.env 偏好', configured: 'edge', args: [] },
]) {
  test(`已有服务与${name}不一致时明确失败，保留原服务`, async t => {
    const f = await fixture(t, { configured });
    const proxy = await fakeProxy(t);
    const result = await f.run(proxy.port, args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /浏览器不一致/);
    assert.deepEqual(await f.events(), []);
    assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).connected, true);
    assert.ok(proxy.requests.every(request => request === '/health'));
  });
}

for (const { name, configured, args } of [
  { name: 'CLI 指定 Chrome', configured: null, args: ['--browser', 'chrome'] },
  { name: 'CLI 浏览器名拼写错误', configured: null, args: ['--browser', 'chrmoe'] },
  { name: 'config.env 偏好', configured: 'chrome', args: [] },
]) {
  test(`已连接实例身份未知时不能满足 ${name}，失败并保留服务`, async t => {
    const f = await fixture(t, { configured });
    const proxy = await fakeProxy(t, { browser: 'unknown' });
    const result = await f.run(proxy.port, args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /无法确认当前连接的浏览器/);
    assert.deepEqual(await f.events(), []);
    assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).connected, true);
    assert.ok(proxy.requests.every(request => request === '/health'));
  });
}

test('没有浏览器期望时可复用身份未知的手动调试实例', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, { browser: 'unknown' });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.every(request => request === '/health'));
});

test('已有服务断开时由原服务 /targets 恢复连接，不启动新进程', async t => {
  const f = await fixture(t, { configured: 'chrome' });
  const proxy = await fakeProxy(t, { connected: false, recover: true });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.includes('/targets'));
  assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).connected, true);
});

test('断开且身份未知的原实例恢复为配置的 Chrome 后可以继续', async t => {
  const f = await fixture(t, { configured: 'chrome' });
  const proxy = await fakeProxy(t, { browser: 'unknown', connected: false, recover: true, recoverBrowser: 'chrome' });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.includes('/targets'));
  const health = await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json();
  assert.equal(health.connected, true);
  assert.equal(health.browser.id, 'chrome');
});

test('恢复后仍检查浏览器身份，不把其他浏览器当作成功', async t => {
  const f = await fixture(t, { configured: 'edge' });
  const proxy = await fakeProxy(t, { browser: 'unknown', connected: false, recover: true, recoverBrowser: 'chrome' });
  // 初次身份未知不能提前判断；恢复时服务报告真实的浏览器身份。
  const result = await f.run(proxy.port);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /浏览器不一致/);
  assert.deepEqual(await f.events(), []);
});

test('等待恢复超时只报告失败，不停止或替换仍运行的服务', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, { connected: false });
  const result = await f.run(proxy.port);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /连接超时/);
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.includes('/targets'));
  assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).status, 'ok');
});

test('/targets 返回空列表也必须等待 health 确认已连接', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, { connected: false, targetsWhileDisconnected: true });
  const result = await f.run(proxy.port);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /连接超时/);
  assert.deepEqual(await f.events(), []);
  assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).connected, false);
});

test('没有服务时才发现浏览器并启动可在检查结束后继续运行的 Proxy', async t => {
  const f = await fixture(t, { configured: 'chrome' });
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  success(await f.run(port, ['--browser', 'edge']));
  const events = await f.events();
  assert.equal(events.filter(event => event.action === 'selectBrowser').length, 1);
  assert.equal(events.filter(event => event.action === 'spawn').length, 1);
  assert.deepEqual(events.find(event => event.action === 'spawn').args, ['--browser', 'edge']);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.connected, true);
  assert.equal(health.browser.id, 'edge');
});
