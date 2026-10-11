import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// 操作系统分支在子进程内模拟；真实文件/TCP 均位于临时树与随机端口。
async function fixture(t, { platform = 'darwin', config = '', envPreference = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Web Access discovery with spaces '));
  const scripts = path.join(root, 'scripts');
  const home = path.join(root, 'User Name', 'Home Directory');
  const localAppData = path.join(root, 'User Name', 'AppData', 'Local Data');
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(localAppData, { recursive: true });
  const configPath = path.join(root, 'config.env');
  if (config !== null) await fs.writeFile(configPath, config);
  await fs.copyFile(path.join(SCRIPTS, 'browser-discovery.mjs'), path.join(scripts, 'browser-discovery.mjs'));
  const probe = path.join(root, 'probe.mjs');
  await fs.writeFile(probe, `
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const opts = JSON.parse(process.argv[2]);
os.platform = () => opts.platform;
os.homedir = () => opts.home;
let connections = 0;
const originalConnect = net.createConnection;
net.createConnection = (...args) => {
  connections++;
  if (opts.rejectTcp) throw new Error('TCP forbidden for this operation');
  return originalConnect(...args);
};
const reads = [];
const originalRead = fs.readFileSync;
fs.readFileSync = (filename, ...args) => {
  const pathname = String(filename);
  if (path.basename(pathname) === 'DevToolsActivePort') {
    reads.push(pathname);
    const code = opts.deniedPaths?.[pathname];
    if (code) throw Object.assign(new Error('模拟端口文件权限拒绝'), { code });
  }
  return originalRead(filename, ...args);
};
const discovery = await import(pathToFileURL(opts.modulePath));
let result;
if (opts.action === 'windowsPaths') {
  // 模块级 Skill 根路径使用宿主路径；仅路径映射调用使用 Windows 原生分隔规则。
  path.join = path.win32.join;
  result = discovery.knownBrowsers();
} else if (opts.action === 'known') {
  result = discovery.knownBrowsers();
} else if (opts.action === 'configured') {
  result = discovery.getConfiguredBrowserId();
} else if (opts.action === 'checkPort') {
  result = await discovery.checkPort(opts.port, '127.0.0.1', 100);
} else {
  result = await discovery.selectBrowser(opts.override ?? null);
}
console.log(JSON.stringify({ result, connections, ...(opts.recordReads ? { reads } : {}) }));
`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = async (action = 'select', extra = {}) => {
    const options = { action, platform, home, modulePath: path.join(scripts, 'browser-discovery.mjs'), ...extra };
    const child = spawn(process.execPath, [probe, JSON.stringify(options)], {
      env: { ...process.env, LOCALAPPDATA: extra.localAppData ?? localAppData, WEB_ACCESS_BROWSER: envPreference },
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
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      return JSON.parse(stdout.trim());
    } finally { clearTimeout(watchdog); }
  };
  return {
    root, home, localAppData, configPath, run,
    async devTools(id, content) {
      const { result: browsers } = await run('known');
      const browser = browsers.find(item => item.id === id);
      assert.ok(browser, `测试平台 ${platform} 不支持 ${id}`);
      await fs.mkdir(path.dirname(browser.devToolsPath), { recursive: true });
      await fs.writeFile(browser.devToolsPath, content);
      return browser;
    },
  };
}

async function fakeHttp(t) {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, requests: () => requests };
}

const platformPaths = {
  darwin: {
    chrome: 'Library/Application Support/Google/Chrome/DevToolsActivePort',
    'chrome-canary': 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort',
    chromium: 'Library/Application Support/Chromium/DevToolsActivePort',
    edge: 'Library/Application Support/Microsoft Edge/DevToolsActivePort',
  },
  linux: {
    chrome: '.config/google-chrome/DevToolsActivePort',
    chromium: '.config/chromium/DevToolsActivePort',
    edge: '.config/microsoft-edge/DevToolsActivePort',
  },
  win32: {
    chrome: 'Google/Chrome/User Data/DevToolsActivePort',
    chromium: 'Chromium/User Data/DevToolsActivePort',
    edge: 'Microsoft/Edge/User Data/DevToolsActivePort',
  },
};

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} 浏览器目录映射来自平台根目录，支持路径空格`, async t => {
    const f = await fixture(t, { platform });
    const { result: browsers, connections } = await f.run('known', { rejectTcp: true });
    assert.deepEqual(browsers.map(browser => browser.id), Object.keys(platformPaths[platform]));
    const base = platform === 'win32' ? f.localAppData : f.home;
    for (const browser of browsers) {
      assert.equal(browser.devToolsPath, path.join(base, platformPaths[platform][browser.id]));
      assert.ok(browser.label);
    }
    assert.equal(connections, 0);
  });
}

test('Windows LOCALAPPDATA 含空格时原生反斜杠路径映射正确', async t => {
  const f = await fixture(t, { platform: 'win32' });
  const localAppData = 'C:\\Users\\User Name\\AppData\\Local Data';
  const { result: browsers, connections } = await f.run('windowsPaths', { localAppData, rejectTcp: true });
  for (const browser of browsers) {
    assert.equal(browser.devToolsPath, path.win32.join(localAppData, platformPaths.win32[browser.id]));
    assert.ok(browser.devToolsPath.startsWith('C:\\Users\\User Name\\'));
    assert.ok(!browser.devToolsPath.includes('/'));
  }
  assert.equal(connections, 0);
});

test('不支持的平台返回空浏览器列表，不探测系统端口', async t => {
  const f = await fixture(t, { platform: 'unsupported-os' });
  assert.deepEqual(await f.run('known', { rejectTcp: true }), { result: [], connections: 0 });
  assert.deepEqual(await f.run('select', { rejectTcp: true }), {
    result: { kind: 'empty', detected: [], configured: null, inaccessible: [] }, connections: 0,
  });
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} 临时 DevToolsActivePort 的 CRLF 正确解析，发现仅发送 TCP`, async t => {
    const f = await fixture(t, { platform, config: 'WEB_ACCESS_BROWSER=chrome\r\n' });
    const server = await fakeHttp(t);
    const wsPath = '/devtools/browser/fake-browser-id';
    const browser = await f.devTools('chrome', `${server.port}\r\n${wsPath}\r\n`);
    const { result, connections } = await f.run();
    assert.equal(result.kind, 'ok');
    assert.equal(result.source, 'preference');
    assert.deepEqual(result.browser, { ...browser, port: server.port, wsPath });
    assert.equal(connections, 1);
    assert.equal(server.requests(), 0);
  });
}

test('override 高于 config.env，配置与环境偏好不被修改', async t => {
  const config = '# 默认浏览器\r\nWEB_ACCESS_BROWSER = chrome\r\n';
  const f = await fixture(t, { config, envPreference: 'chromium' });
  const server = await fakeHttp(t);
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  await f.devTools('edge', `${server.port}\n/edge\n`);
  const { result, connections } = await f.run('select', { override: 'edge' });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'override');
  assert.equal(result.browser.id, 'edge');
  assert.equal(result.configured, 'chrome');
  assert.equal(result.override, 'edge');
  assert.equal(connections, 2);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), config);
  assert.equal(server.requests(), 0);
});

test('配置偏好不在线时严格 mismatch，不降级到已检测的另一浏览器', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=edge\n' });
  const server = await fakeHttp(t);
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  const { result } = await f.run();
  assert.equal(result.kind, 'mismatch');
  assert.equal(result.source, 'preference');
  assert.equal(result.configured, 'edge');
  assert.deepEqual(result.detected.map(browser => browser.id), ['chrome']);
  assert.equal(result.browser, undefined);
});

for (const override of ['edge', 'chrmoe']) {
  test(`override ${override} 不在线时严格 mismatch，不回退到配置 chrome`, async t => {
    const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=chrome\n' });
    const server = await fakeHttp(t);
    await f.devTools('chrome', `${server.port}\n/chrome\n`);
    const { result } = await f.run('select', { override });
    assert.equal(result.kind, 'mismatch');
    assert.equal(result.source, 'override');
    assert.equal(result.configured, 'chrome');
    assert.equal(result.override, override);
    assert.equal(result.browser, undefined);
  });
}

for (const ids of [['chrome'], ['chrome', 'edge']]) {
  test(`没有偏好、检测到 ${ids.length} 个浏览器时保持 ambiguous`, async t => {
    const f = await fixture(t);
    const server = await fakeHttp(t);
    for (const id of ids) await f.devTools(id, `${server.port}\n/${id}\n`);
    const { result, connections } = await f.run();
    assert.equal(result.kind, 'ambiguous');
    assert.equal(result.configured, null);
    assert.deepEqual(result.detected.map(browser => browser.id), ids);
    assert.equal(result.browser, undefined);
    assert.equal(connections, ids.length);
  });
}

test('没有端口文件和偏好时 empty，环境变量不冒充持久偏好', async t => {
  const f = await fixture(t, { envPreference: 'edge' });
  assert.deepEqual(await f.run('select', { rejectTcp: true }), {
    result: { kind: 'empty', detected: [], configured: null, inaccessible: [] }, connections: 0,
  });
});

for (const config of [null, '# 注释\r\nWEB_ACCESS_BROWSER=\r\n', '# 注释\r\n WEB_ACCESS_BROWSER = edge \r\nignored-line\r\n']) {
  test(`getConfiguredBrowserId ${config?.includes('edge') ? '读取 CRLF/空格偏好' : '缺失或空偏好'} 无需 TCP`, async t => {
    const f = await fixture(t, { config, envPreference: 'chrome' });
    const server = await fakeHttp(t);
    await f.devTools('chrome', `${server.port}\n/chrome\n`);
    const { result, connections } = await f.run('configured', { rejectTcp: true });
    assert.equal(result, config?.includes('edge') ? 'edge' : null);
    assert.equal(connections, 0);
    assert.equal(server.requests(), 0);
  });
}

test('非法和越界端口文件被忽略，不发 TCP', async t => {
  const f = await fixture(t);
  await f.devTools('chrome', '0\r\n/fake\r\n');
  await f.devTools('edge', '65536\r\n/fake\r\n');
  await f.devTools('chromium', 'not-a-port\r\n/fake\r\n');
  assert.deepEqual(await f.run('select', { rejectTcp: true }), {
    result: { kind: 'empty', detected: [], configured: null, inaccessible: [] }, connections: 0,
  });
});

test('端口文件陈旧且 TCP 未监听时不可选中浏览器', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=chrome\n' });
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await f.devTools('chrome', `${port}\n/fake\n`);
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'mismatch');
  assert.deepEqual(result.detected, []);
  assert.equal(connections, 1);
});

test('checkPort 检测随机 HTTP 端口，仅建立 TCP，不发送 HTTP/CDP', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  assert.deepEqual(await f.run('checkPort', { port: server.port }), { result: true, connections: 1 });
  assert.equal(server.requests(), 0);
});

test('显式端口与配置浏览器绑定，跳过其不可读文件且仅建立 TCP', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\r\nWEB_ACCESS_CDP_PORT=${server.port}\r\n` });
  const { result: browsers } = await f.run('known');
  const chrome = browsers.find(browser => browser.id === 'chrome');
  const { result, connections, reads } = await f.run('select', {
    deniedPaths: { [chrome.devToolsPath]: 'EPERM' }, recordReads: true,
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'preference');
  assert.deepEqual(result.browser, { ...chrome, port: server.port, wsPath: null, endpointSource: 'config-port' });
  assert.deepEqual(result.inaccessible, []);
  assert.ok(!reads.includes(chrome.devToolsPath));
  assert.equal(connections, 1);
  assert.equal(server.requests(), 0);
});

test('override 其它浏览器只使用自己的端口文件，不借用 Chrome 显式端口', async t => {
  const chromeServer = await fakeHttp(t);
  const edgeServer = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${chromeServer.port}\n` });
  await f.devTools('edge', `${edgeServer.port}\r\n/edge-own-endpoint\r\n`);
  const { result } = await f.run('select', { override: 'edge' });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'override');
  assert.equal(result.browser.id, 'edge');
  assert.equal(result.browser.port, edgeServer.port);
  assert.equal(result.browser.wsPath, '/edge-own-endpoint');
  assert.equal(result.browser.endpointSource, undefined);
  assert.equal(result.detected.find(browser => browser.id === 'chrome').endpointSource, 'config-port');
  assert.equal(chromeServer.requests(), 0);
  assert.equal(edgeServer.requests(), 0);
});

test('override Edge 不可发现时保持 mismatch，已配置 Chrome 显式端口不成为兜底', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${server.port}\n` });
  const { result } = await f.run('select', { override: 'edge' });
  assert.equal(result.kind, 'mismatch');
  assert.equal(result.source, 'override');
  assert.equal(result.override, 'edge');
  assert.equal(result.configured, 'chrome');
  assert.equal(result.browser, undefined);
  assert.deepEqual(result.detected.map(browser => browser.id), ['chrome']);
});

test('显式端口离线时不回退到同浏览器的可用文件端口', async t => {
  const fileServer = await fakeHttp(t);
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const offlinePort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${offlinePort}\n` });
  const chrome = await f.devTools('chrome', `${fileServer.port}\n/file-endpoint\n`);
  const { result, connections, reads } = await f.run('select', { recordReads: true });
  assert.equal(result.kind, 'mismatch');
  assert.deepEqual(result.detected, []);
  assert.ok(!reads.includes(chrome.devToolsPath));
  assert.equal(connections, 1);
  assert.equal(fileServer.requests(), 0);
});

test('显式端口缺 WEB_ACCESS_BROWSER 时返回配置错误，override 也不能补绑定', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_CDP_PORT=9222\n' });
  const { result, connections } = await f.run('select', { override: 'chrome', rejectTcp: true });
  assert.equal(result.kind, 'config-error');
  assert.match(result.message, /一起配置/);
  assert.equal(result.configured, null);
  assert.deepEqual(result.detected, []);
  assert.equal(connections, 0);
});

for (const { platform, configured } of [
  { platform: 'darwin', configured: 'unknown-browser' },
  { platform: 'win32', configured: 'chrome-canary' },
]) {
  test(`显式端口绑定 ${platform} 不支持的 ${configured} 时返回配置错误`, async t => {
    const f = await fixture(t, { platform, config: `WEB_ACCESS_BROWSER=${configured}\nWEB_ACCESS_CDP_PORT=9222\n` });
    const { result, connections } = await f.run('select', { rejectTcp: true });
    assert.equal(result.kind, 'config-error');
    assert.match(result.message, /支持列表/);
    assert.equal(connections, 0);
  });
}

for (const port of ['0', '65536', '12junk', '-1', '1.5', '0x2406', '1e3', '+9222']) {
  test(`显式端口 ${JSON.stringify(port)} 不满足十进制范围时返回配置错误`, async t => {
    const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${port}\n` });
    const { result, connections } = await f.run('select', { rejectTcp: true });
    assert.equal(result.kind, 'config-error');
    assert.match(result.message, /1 到 65535 的十进制整数/);
    assert.equal(connections, 0);
  });
}

for (const configured of [false, true]) {
  test(`真实配置模板的空端口使用自动发现（设置浏览器=${configured}）`, async t => {
    let config = await fs.readFile(path.join(SCRIPTS, '..', 'templates', 'config.env.template'), 'utf8');
    if (configured) config = config.replace('WEB_ACCESS_BROWSER=', 'WEB_ACCESS_BROWSER=chrome');
    const f = await fixture(t, { config });
    const server = await fakeHttp(t);
    await f.devTools('chrome', `${server.port}\r\n/devtools/browser/fake\r\n`);
    const { result } = await f.run('select');
    assert.equal(result.kind, configured ? 'ok' : 'ambiguous');
    if (configured) assert.equal(result.browser.port, server.port);
  });
}

for (const code of ['EPERM', 'EACCES']) {
  for (const configured of [null, 'chrome']) {
    test(`${code} 端口文件不可读时保持 ${configured ? 'mismatch' : 'empty'} 且保留不可读事实`, async t => {
      const f = await fixture(t, { config: configured ? `WEB_ACCESS_BROWSER=${configured}\n` : '' });
      const { result: browsers } = await f.run('known');
      const chrome = browsers.find(browser => browser.id === 'chrome');
      const { result, connections } = await f.run('select', { deniedPaths: { [chrome.devToolsPath]: code }, rejectTcp: true });
      assert.equal(result.kind, configured ? 'mismatch' : 'empty');
      assert.deepEqual(result.inaccessible, [{ ...chrome, code }]);
      assert.deepEqual(result.detected, []);
      assert.equal(connections, 0);
    });
  }
}

test('显式 Chrome 端口成功时仍保留另一个浏览器不可读的事实', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${server.port}\n` });
  const { result: browsers } = await f.run('known');
  const edge = browsers.find(browser => browser.id === 'edge');
  const { result } = await f.run('select', { deniedPaths: { [edge.devToolsPath]: 'EACCES' } });
  assert.equal(result.kind, 'ok');
  assert.equal(result.browser.id, 'chrome');
  assert.deepEqual(result.inaccessible, [{ ...edge, code: 'EACCES' }]);
});
