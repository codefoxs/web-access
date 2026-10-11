import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const oldHealth = {
  status: 'ok', connected: true, instanceId: 'old-instance', pid: 1234,
  startedAt: '2026-10-11T00:00:00.000Z', activeRequests: 0, managedTabs: 0,
  pendingCommands: 0, connectionState: 'connected', maintenance: false,
  browser: { id: 'edge', label: 'Microsoft Edge' },
};

// CLI、启动器与 HTTP 服务全部使用临时副本和随机端口，不访问真实浏览器。
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-access-maintenance-'));
  const scripts = path.join(root, 'scripts');
  const eventsPath = path.join(root, 'events.jsonl');
  await fs.mkdir(scripts);
  await fs.copyFile(path.join(SCRIPTS, 'proxy-maintenance.mjs'), path.join(scripts, 'proxy-maintenance.mjs'));
  await fs.writeFile(path.join(scripts, 'fake-proxy.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
const record = event => fs.appendFileSync(process.env.TEST_EVENTS_PATH, JSON.stringify(event) + '\\n');
const health = {
  status: 'ok', connected: process.env.TEST_START_MODE !== 'disconnected',
  instanceId: 'new-instance', pid: process.pid, activeRequests: 0, managedTabs: 0,
  pendingCommands: 0, maintenance: false,
  browser: { id: process.env.TEST_BOOT_BROWSER },
};
if (process.env.TEST_START_MODE === 'different-browser') health.browser.id = 'chrome';
if (process.env.TEST_START_MODE === 'unknown-browser') health.browser.id = 'unknown';
if (process.env.TEST_START_MODE === 'legacy') delete health.instanceId;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(health));
});
server.on('error', error => {
  record({ action: 'listenError', code: error.code });
  process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
});
server.listen(Number(process.env.CDP_PROXY_PORT), '127.0.0.1', () => record({ action: 'listening', pid: process.pid }));
`);
  await fs.writeFile(path.join(scripts, 'check-deps.mjs'), `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const record = event => fs.appendFileSync(process.env.TEST_EVENTS_PATH, JSON.stringify(event) + '\\n');
record({ action: 'startup', args: process.argv.slice(2) });
if (process.env.TEST_START_MODE === 'absent') process.exit(1);
const browserFlag = process.argv.indexOf('--browser');
const browserId = browserFlag === -1 ? 'edge' : process.argv[browserFlag + 1];
const child = spawn(process.execPath, [fileURLToPath(new URL('./fake-proxy.mjs', import.meta.url))], {
  detached: true, stdio: 'ignore', windowsHide: true,
  env: { ...process.env, TEST_BOOT_BROWSER: browserId },
});
record({ action: 'spawn', pid: child.pid });
child.unref();
for (let i = 0; i < 100; i++) {
  try {
    const res = await fetch('http://127.0.0.1:' + process.env.CDP_PROXY_PORT + '/health');
    const health = await res.json();
    if (health.status === 'ok') {
      console.log(health.connected ? 'proxy: ready' : 'proxy: waiting authorization');
      process.exit(health.connected && process.env.TEST_START_MODE !== 'check-failed' ? 0 : 1);
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 10));
}
process.exit(1);
`);
  const preload = path.join(root, 'fast-timers.mjs');
  await fs.writeFile(preload, `
const original = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => original(callback, Math.min(delay, 40), ...args);
`);
  const events = async () => {
    try { return (await fs.readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  t.after(async () => {
    // 仅终止本测试生成并记录的假进程，不扫描或清理真实 Proxy。
    for (const event of await events()) {
      if (event.action !== 'spawn') continue;
      try { process.kill(event.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    events,
    async run(port, args = [], startMode = 'connected') {
      const child = spawn(process.execPath, ['--import', preload, path.join(scripts, 'proxy-maintenance.mjs'), ...args], {
        env: { ...process.env, CDP_PROXY_PORT: String(port), TEST_EVENTS_PATH: eventsPath, TEST_START_MODE: startMode },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        const output = (stdout + stderr).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).at(-1);
        return { code, stdout, stderr, output };
      } finally { clearTimeout(watchdog); }
    },
  };
}

async function fakeProxy(t, { health = oldHealth, shutdown, healthResponse, statusCode = 200 } = {}) {
  const requests = [];
  let current = { ...health };
  const server = http.createServer((req, res) => {
    (async () => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : null;
      requests.push({ method: req.method, path: req.url, body, origin: req.headers.origin });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') {
        res.statusCode = statusCode;
        res.end(healthResponse === undefined ? JSON.stringify(current) : healthResponse);
      } else if (shutdown) {
        await shutdown({ req, res, body, server, setHealth: next => { current = next; } });
      } else {
        res.statusCode = 202;
        res.end(JSON.stringify({ status: 'stopping', instanceId: current.instanceId }));
        setTimeout(() => server.close(), 5);
      }
    })().catch(error => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { port, requests };
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('status 默认只读，完整输出服务端状态', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t);
  const result = await f.run(proxy.port);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.output, { status: 'running', health: oldHealth });
  assert.deepEqual(proxy.requests.map(r => r.path), ['/health']);
  assert.deepEqual(await f.events(), []);
});

test('没有服务时 status 和 stop 明确报告 stopped，不启动服务', async t => {
  const f = await fixture(t);
  const port = await unusedPort();
  for (const action of ['status', 'stop']) {
    const result = await f.run(port, [action]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.output.status, 'stopped');
  }
  assert.deepEqual(await f.events(), []);
});

for (const counter of ['activeRequests', 'managedTabs', 'pendingCommands']) {
  test(`${counter} 忙碌时 stop/restart 均不发送 shutdown`, async t => {
    const f = await fixture(t);
    const proxy = await fakeProxy(t, { health: { ...oldHealth, [counter]: 1 } });
    for (const action of ['stop', 'restart']) {
      const result = await f.run(proxy.port, [action]);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.output.status, 'busy');
    }
    assert.ok(proxy.requests.every(req => req.path === '/health'));
    assert.deepEqual(await f.events(), []);
  });
}

for (const connectionState of ['discovering', 'connecting']) {
  test(`${connectionState} 连接进行中时 stop/restart 均不发送 shutdown`, async t => {
    const f = await fixture(t);
    const proxy = await fakeProxy(t, { health: { ...oldHealth, connected: false, connectionState } });
    for (const action of ['stop', 'restart']) {
      const result = await f.run(proxy.port, [action]);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.output.status, 'busy');
    }
    assert.ok(proxy.requests.every(req => req.path === '/health'));
    assert.deepEqual(await f.events(), []);
  });
}

test('旧服务无 instanceId 时 status 可读，但拒绝 stop/restart 强停', async t => {
  const f = await fixture(t);
  const legacy = { ...oldHealth };
  delete legacy.instanceId;
  const proxy = await fakeProxy(t, { health: legacy });
  assert.equal((await f.run(proxy.port, ['status'])).code, 0);
  for (const action of ['stop', 'restart']) {
    const result = await f.run(proxy.port, [action]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.output.message, /禁止自动强停/);
  }
  assert.ok(proxy.requests.every(req => req.path === '/health'));
  assert.deepEqual(await f.events(), []);
});

test('stop 携带旧实例身份且没有 Origin，确认退出后不启动服务', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t);
  const result = await f.run(proxy.port, ['stop']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.status, 'stopped');
  assert.equal(result.output.stoppedInstanceId, oldHealth.instanceId);
  const shutdowns = proxy.requests.filter(req => req.path === '/shutdown');
  assert.equal(shutdowns.length, 1);
  assert.equal(shutdowns[0].method, 'POST');
  assert.deepEqual(shutdowns[0].body, { instanceId: oldHealth.instanceId });
  assert.equal(shutdowns[0].origin, undefined);
  assert.deepEqual(await f.events(), []);
});

test('read/stop 之间变忙时服务端拒绝有效，不启动或强停', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, {
    shutdown({ res, setHealth }) {
      setHealth({ ...oldHealth, activeRequests: 1 });
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'busy' }));
    },
  });
  const result = await f.run(proxy.port, ['restart']);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.output.status, 'busy');
  assert.equal(proxy.requests.filter(r => r.path === '/shutdown').length, 1);
  assert.deepEqual(await f.events(), []);
});

for (const responseCode of [202, 409]) {
  for (const action of ['stop', 'restart']) {
    test(`${action} 遇到实例替换（${responseCode}）时保留新实例`, async t => {
      const f = await fixture(t);
      const replacement = { ...oldHealth, instanceId: 'replacement-instance' };
      const proxy = await fakeProxy(t, {
        shutdown({ res, setHealth }) {
          setHealth(replacement);
          res.statusCode = responseCode;
          res.end(JSON.stringify({ status: 'stopping', instanceId: oldHealth.instanceId }));
        },
      });
      const result = await f.run(proxy.port, [action]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.output.status, action === 'stop' ? 'replaced' : 'ready');
      assert.equal(result.output.health.instanceId, replacement.instanceId);
      if (action === 'restart') assert.equal(result.output.reused, true);
      assert.equal(proxy.requests.filter(req => req.path === '/shutdown').length, 1);
      assert.deepEqual(await f.events(), []);
    });
  }
}

for (const responseCode of [202, 409]) {
  for (const browser of [{ id: 'chrome' }, { id: 'unknown' }, undefined]) {
    test(`restart 遇到 ${browser?.id || '缺少身份'} 浏览器替换（${responseCode}）时 conflict 并保留新实例`, async t => {
      const f = await fixture(t);
      const replacement = { ...oldHealth, instanceId: 'replacement-instance', browser };
      const proxy = await fakeProxy(t, {
        shutdown({ res, setHealth }) {
          setHealth(replacement);
          res.statusCode = responseCode;
          res.end(JSON.stringify({ status: 'stopping', instanceId: oldHealth.instanceId }));
        },
      });
      const result = await f.run(proxy.port, ['restart']);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.output.status, 'conflict');
      assert.equal(result.output.expectedBrowserId, 'edge');
      assert.equal(result.output.health.instanceId, replacement.instanceId);
      assert.equal(proxy.requests.filter(req => req.path === '/shutdown').length, 1);
      assert.deepEqual(await f.events(), []);
      const health = await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json();
      assert.equal(health.instanceId, replacement.instanceId);
    });
  }
}

test('原浏览器身份未知时可复用其他健康浏览器，不虚构原选择', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, {
    health: { ...oldHealth, browser: { id: 'unknown' } },
    shutdown({ res, setHealth }) {
      setHealth({ ...oldHealth, instanceId: 'replacement-instance', browser: { id: 'chrome' } });
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'instance mismatch' }));
    },
  });
  const result = await f.run(proxy.port, ['restart']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.status, 'ready');
  assert.equal(result.output.health.browser.id, 'chrome');
  assert.deepEqual(await f.events(), []);
});

test('restart 只调用一次启动器，保留原浏览器并读回不同的新实例', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t);
  const result = await f.run(proxy.port, ['restart']);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.output.status, 'ready');
  assert.equal(result.output.health.instanceId, 'new-instance');
  const starts = (await f.events()).filter(event => event.action === 'startup');
  assert.deepEqual(starts, [{ action: 'startup', args: ['--browser', 'edge'] }]);
});

test('未运行服务时 restart 启动一次，不传浏览器覆盖', async t => {
  const f = await fixture(t);
  const result = await f.run(await unusedPort(), ['restart']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.status, 'ready');
  assert.deepEqual((await f.events()).filter(event => event.action === 'startup'), [{ action: 'startup', args: [] }]);
});

test('两个并发 restart 最终复用同一监听实例，每个入口最多启动一次', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t);
  const results = await Promise.all([f.run(proxy.port, ['restart']), f.run(proxy.port, ['restart'])]);
  for (const result of results) {
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.output.status, 'ready');
    assert.equal(result.output.health.instanceId, 'new-instance');
  }
  const events = await f.events();
  assert.equal(events.filter(event => event.action === 'listening').length, 1);
  const starts = events.filter(event => event.action === 'startup');
  assert.ok(starts.length >= 1 && starts.length <= 2);
  assert.ok(events.filter(event => event.action === 'listenError').every(event => event.code === 'EADDRINUSE'));
});

test('restart 服务启动但未连接时如实 waitingAuthorization，退出 3', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t);
  const result = await f.run(proxy.port, ['restart'], 'disconnected');
  assert.equal(result.code, 3, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.output.status, 'waitingAuthorization');
  assert.equal(result.output.health.connected, false);
  assert.equal((await f.events()).filter(event => event.action === 'startup').length, 1);
});

for (const mode of ['different-browser', 'unknown-browser']) {
  test(`普通 restart 启动后 ${mode} 浏览器冲突时也保留新实例并退出 2`, async t => {
    const f = await fixture(t);
    const proxy = await fakeProxy(t);
    const result = await f.run(proxy.port, ['restart'], mode);
    assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.output.status, 'conflict');
    assert.equal(result.output.expectedBrowserId, 'edge');
    assert.equal(result.output.health.instanceId, 'new-instance');
    assert.equal((await f.events()).filter(event => event.action === 'startup').length, 1);
    const health = await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json();
    assert.equal(health.instanceId, 'new-instance');
  });
}

test('其他维护者留下未授权新实例时不重复启动', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, {
    shutdown({ res, setHealth }) {
      setHealth({ ...oldHealth, instanceId: 'replacement-instance', connected: false });
      res.statusCode = 409;
      res.end(JSON.stringify({ error: 'instance mismatch' }));
    },
  });
  const result = await f.run(proxy.port, ['restart']);
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.output.status, 'waitingAuthorization');
  assert.equal(result.output.reused, true);
  assert.deepEqual(await f.events(), []);
});

test('收到停止确认但服务不退出时有界失败，不执行启动器', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, {
    shutdown({ res }) {
      res.statusCode = 202;
      res.end(JSON.stringify({ status: 'stopping', instanceId: oldHealth.instanceId }));
    },
  });
  const result = await f.run(proxy.port, ['restart']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.output.message, /15 秒内未退出/);
  assert.deepEqual(await f.events(), []);
});

test('启动器失败且没有服务时保留失败事实，不报 ready', async t => {
  const f = await fixture(t);
  const result = await f.run(await unusedPort(), ['restart'], 'absent');
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.output.message, /未读到健康服务/);
  assert.equal((await f.events()).filter(event => event.action === 'startup').length, 1);
});

test('启动检查失败时健康连接不能掩盖检查失败', async t => {
  const f = await fixture(t);
  const result = await f.run(await unusedPort(), ['restart'], 'check-failed');
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.output.message, /启动检查未通过/);
  assert.equal(result.output.health.connected, true);
});

test('启动后仍是没有身份的旧代码时不宣称升级成功', async t => {
  const f = await fixture(t);
  const result = await f.run(await unusedPort(), ['restart'], 'legacy');
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.output.message, /没有 instanceId/);
});

test('服务端停止确认身份不一致时不继续启动', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, {
    shutdown({ res }) {
      res.statusCode = 202;
      res.end(JSON.stringify({ status: 'stopping', instanceId: 'other-instance' }));
    },
  });
  const result = await f.run(proxy.port, ['restart']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.output.message, /未确认停止目标实例/);
  assert.deepEqual(await f.events(), []);
});

for (const scenario of [
  { name: '无效 JSON', options: { healthResponse: 'oops' } },
  { name: '非 Proxy 服务', options: { healthResponse: '{"status":"other"}' } },
  { name: 'HTTP 503', options: { statusCode: 503 } },
]) {
  test(`${scenario.name} 时不停止或启动端口上的服务`, async t => {
    const f = await fixture(t);
    const proxy = await fakeProxy(t, scenario.options);
    const result = await f.run(proxy.port, ['restart']);
    assert.equal(result.code, 1, result.stderr);
    assert.ok(proxy.requests.every(req => req.path === '/health'));
    assert.deepEqual(await f.events(), []);
  });
}

test('参数与端口校验发生在任何 HTTP 或启动动作之前', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t);
  for (const args of [['kill'], ['restart', '--browser', 'chrome']]) {
    assert.equal((await f.run(proxy.port, args)).code, 2);
  }
  assert.equal((await f.run('bad-port', ['restart'])).code, 2);
  assert.deepEqual(proxy.requests, []);
  assert.deepEqual(await f.events(), []);
});
