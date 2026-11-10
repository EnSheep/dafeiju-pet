// 用 CDP 在宠物渲染端触发一次真实对话，验证「模型回复 → 落记忆 → 语音」整条链路。
const wsUrl = process.argv[2];
const port = process.argv[3];
const text = process.argv[4] ?? '你好呀，我叫阿泽。';

const ws = new WebSocket(wsUrl);
const pending = new Map();
let seq = 0;

function call(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  });
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

const timer = setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(1);
}, 180_000);

ws.addEventListener('open', async () => {
  try {
    await call('Runtime.enable');
    const url = `http://127.0.0.1:${port}/dsh-pet-7340/chat?pet=main&surface=desktop`;
    const expr = `(async () => {
      const t0 = Date.now();
      const r = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: ${JSON.stringify(text)} }),
        credentials: 'include',
      });
      const body = await r.text();
      return { status: r.status, ms: Date.now() - t0, body: body.slice(0, 800) };
    })()`;
    const out = await call('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.log('ERR', e.message);
  } finally {
    clearTimeout(timer);
    ws.close();
    setTimeout(() => process.exit(0), 300);
  }
});
