// One subject of the scan-static worker, in its own thread (corpus/scan-static.mjs scanInWorker). The parent
// terminates the thread when the subject runs past its time limit, which also stops synchronous work its own timer
// cannot. The thread has no network: its requests go to the parent, which makes them and passes the answers back.
import { parentPort, workerData } from 'node:worker_threads';
import { RAW_FILE_CAP, rawFiles, scanSubject } from './scan-static.mjs';

const pending = new Map();
let next = 0;

parentPort.on('message', (m) => {
  if (!m || m.type !== 'response') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) {
    p.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
    return;
  }
  const body = m.body ? Buffer.from(m.body.buffer, m.body.byteOffset, m.body.byteLength) : null;
  p.resolve(new Response(body, { status: m.status, headers: m.headers }));
});

function proxyFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const id = next++;
    const signal = init.signal;
    if (signal && signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    pending.set(id, { resolve, reject });
    signal?.addEventListener('abort', () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      parentPort.postMessage({ type: 'abort', id });
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
    const headers = init.headers && typeof init.headers === 'object' ? Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k, String(v)])) : {};
    parentPort.postMessage({ type: 'fetch', id, url: String(url), headers, redirect: init.redirect });
  });
}

// No token here: the parent adds it to api.github.com requests (it holds the token; R-SS-10).
const { subject, timeoutMs, codeEffects } = workerData;
const out = await scanSubject(subject, { fetch: proxyFetch, token: null, timeoutMs, codeEffects: codeEffects === true });
// The raw/ texts are built (and capped) here, so the uncapped value never crosses to the parent: a list that
// expands to gigabytes would be cloned whole otherwise (R-SS-08).
const { raw, ...rest } = out;
parentPort.postMessage({ type: 'done', out: { ...rest, raw: {}, rawFiles: rawFiles(raw || {}, RAW_FILE_CAP) } });
