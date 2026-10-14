// 页面中的 iframe：列举、在其中执行、把视口坐标点击路由到所在的 frame - 单一职责模块
// 被 cdp-proxy.mjs 使用。不持有连接和 session 表，只经注入的 send / ensureSession 访问浏览器（唯一连接所有者仍是 cdp-connection）。
//
// 依据的 CDP 事实（Chrome 155 实测）：
//   - DOM.describeNode 对 iframe 元素给出 frameId；跨进程 iframe 的 frameId 同时是它的 iframe target id
//   - 父页面的 Page.getFrameTree 不包含跨进程 iframe，它的网址取自 Target.getTargets
//   - 后台标签页里，经父页面 session 发出的鼠标事件命中不了跨进程 iframe；需换算坐标后发给该 iframe 的子 session
//   - Page.createIsolatedWorld 用同一个名字重复调用返回同一个执行上下文，不会累积
//   - 隔离环境有自己的一套 DOM 原型：页面改写 Document.prototype.querySelectorAll / elementFromPoint 不影响它
// 列举与命中测试都在隔离环境里执行，不受页面脚本改写 DOM API 的影响。
// 范围：只覆盖页面主文档里直接的 <iframe> / <frame>，不递归嵌套的 iframe。

import { randomUUID } from 'node:crypto';

// 调用方参数问题（frameId 格式不对、该页面没有这个 iframe），由调用方映射为 400
export class FrameError extends Error {}

const FRAME_ID = /^[A-Za-z0-9._-]{1,128}$/;
const WORLD_NAME = 'web-access';

export function createPageFrames({ send, ensureSession }) {
  // CDP 错误一律抛出，带上方法名
  async function call(method, params, sessionId) {
    const resp = await send(method, params, sessionId);
    if (resp.error) throw new Error(`${method}: ${resp.error.message}`);
    return resp.result;
  }

  // 用对象组承载临时远程对象，结束后整组释放。组名每次调用唯一：
  // 同一标签页上重叠的请求共用 session，固定组名会让先结束的请求释放另一个请求还在用的对象。
  async function withObjectGroup(sessionId, prefix, fn) {
    const group = `${prefix}-${randomUUID()}`;
    try { return await fn(group); }
    finally { await send('Runtime.releaseObjectGroup', { objectGroup: group }, sessionId).catch(() => {}); }
  }

  // frame 的隔离环境（同名复用同一个上下文）
  async function isolatedWorld(sessionId, frameId) {
    const world = await call('Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME }, sessionId);
    if (!world.executionContextId) throw new Error('iframe 执行环境不可用');
    return world.executionContextId;
  }

  // session 根 frame 的 id 与 frame 树
  async function frameTree(sessionId) {
    return (await call('Page.getFrameTree', {}, sessionId)).frameTree;
  }

  async function iframeTargets() {
    const { targetInfos } = await call('Target.getTargets');
    return new Map(targetInfos.filter(info => info.type === 'iframe').map(info => [info.targetId, info]));
  }

  // 列出页面主文档中的 iframe：[{ index, frameId, crossProcess, url, id?, name?, src? }]
  // frameId 为 null 表示该 iframe 尚未加载出文档
  async function listFrames(targetId) {
    const sessionId = await ensureSession(targetId);
    const tree = await frameTree(sessionId);
    const contextId = await isolatedWorld(sessionId, tree.frame.id);
    return withObjectGroup(sessionId, 'web-access-frames', async group => {
      const list = await call('Runtime.evaluate', {
        expression: "document.querySelectorAll('iframe, frame')", objectGroup: group, contextId,
      }, sessionId);
      if (list.exceptionDetails || !list.result?.objectId) throw new Error('无法读取页面中的 iframe');
      const { result: props } = await call('Runtime.getProperties', {
        objectId: list.result.objectId, ownProperties: true,
      }, sessionId);
      const elements = props.filter(prop => /^\d+$/.test(prop.name))
        .sort((a, b) => Number(a.name) - Number(b.name))
        .map(prop => prop.value.objectId);
      if (!elements.length) return [];

      const oopifs = await iframeTargets();
      const local = new Map();
      const walk = node => { for (const child of node?.childFrames || []) { local.set(child.frame.id, child.frame); walk(child); } };
      walk(tree);

      const frames = [];
      for (const [index, objectId] of elements.entries()) {
        const { node } = await call('DOM.describeNode', { objectId }, sessionId);
        const attrs = {};
        for (let i = 0; i + 1 < (node.attributes || []).length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
        const frameId = node.frameId || null;
        const oopif = frameId ? oopifs.get(frameId) : undefined;
        frames.push({
          index,
          frameId,
          crossProcess: Boolean(oopif),
          url: oopif?.url ?? local.get(frameId)?.url ?? attrs.src ?? null,
          ...(attrs.id ? { id: attrs.id } : {}),
          ...(attrs.name ? { name: attrs.name } : {}),
          ...(attrs.src ? { src: attrs.src } : {}),
        });
      }
      return frames;
    });
  }

  // 为 /eval 准备 iframe 的执行环境：{ sessionId, contextId, frame }
  // 在 iframe 的隔离环境中执行：DOM 与页面共享，看不到页面自己的 JS 全局变量
  async function frameContext(targetId, frameId) {
    if (!FRAME_ID.test(frameId || '')) throw new FrameError('frame 参数应为 /frames 返回的 frameId');
    const frame = (await listFrames(targetId)).find(item => item.frameId === frameId);
    if (!frame) throw new FrameError(`该页面没有 frameId 为 ${frameId} 的 iframe，请先用 /frames 查看`);
    // 跨进程 iframe 只能在它自己的子 session 里执行；同进程 iframe 用页面 session 加 frameId
    const sessionId = frame.crossProcess ? await ensureSession(frameId) : await ensureSession(targetId);
    const world = await call('Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME }, sessionId);
    if (!world.executionContextId) throw new Error('iframe 执行环境不可用');
    return { sessionId, contextId: world.executionContextId, frame };
  }

  // 视口坐标 → 实际接收鼠标事件的 session 与坐标：{ sessionId, x, y, frameId?, crossProcess? }
  // 只沿实际命中的那一层 iframe 路由；命中空白或普通元素时照常发给页面。
  async function routePoint(targetId, x, y) {
    const sessionId = await ensureSession(targetId);
    const contextId = await isolatedWorld(sessionId, (await frameTree(sessionId)).frame.id);
    return withObjectGroup(sessionId, 'web-access-click', async group => {
      const hit = await call('Runtime.evaluate', {
        expression: `document.elementFromPoint(${x}, ${y})`, objectGroup: group, contextId,
      }, sessionId);
      const objectId = hit.result?.objectId;
      if (!objectId) return { sessionId, x, y };
      const { node } = await call('DOM.describeNode', { objectId }, sessionId);
      if (!node.frameId) return { sessionId, x, y };
      if (!(await iframeTargets()).has(node.frameId)) {
        // 后台标签页中同进程 iframe 可能还没有可用的命中测试数据：截一张最低质量的图触发绘制，不激活页面
        await call('Page.captureScreenshot', { format: 'jpeg', quality: 1, captureBeyondViewport: false }, sessionId);
        return { sessionId, x, y, frameId: node.frameId, crossProcess: false };
      }
      // 换算到 iframe 内容区的坐标（扣除 iframe 在视口中的位置与边框）
      const offset = await call('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { const r = this.getBoundingClientRect(); return { x: r.x + this.clientLeft, y: r.y + this.clientTop }; }',
        returnByValue: true,
      }, sessionId);
      const origin = offset.result?.value;
      if (!origin) throw new Error('iframe 坐标不可用');
      return {
        sessionId: await ensureSession(node.frameId),
        x: x - origin.x, y: y - origin.y, frameId: node.frameId, crossProcess: true,
      };
    });
  }

  return { listFrames, frameContext, routePoint };
}
