// 连续发多句话，用来把某条记忆挤出「最近 N 轮」窗口，再验证能不能被召回。
const wsUrl = process.argv[2];
const port = process.argv[3];
const texts = process.argv.slice(4);

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
}, 600_000);

ws.addEventListener('open', async () => {
  try {
    await call('Runtime.enable');
    for (const text of texts) {
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
        return { status: r.status, ms: Date.now() - t0, body: body.slice(0, 300) };
      })()`;
      const out = await call('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log('Q:', text);
      console.log('A:', JSON.stringify(out?.result?.value ?? out));
    }
  } catch (e) {
    console.log('ERR', e.message);
  } finally {
    clearTimeout(timer);
    ws.close();
    setTimeout(() => process.exit(0), 300);
  }
});
