// services/fc/src/lib/apns.ts
// HTTP/2 APNs client. Transport is injectable for testability — production
// transport is built from node:http2 once per process.
import http2 from 'node:http2';

export function createHttp2Transport(host) {
  let session = null;
  function ensure() {
    if (!session || session.closed || session.destroyed) {
      session = http2.connect(`https://${host}:443`);
    }
    return session;
  }
  return async function transport({ method, path, headers, body }) {
    const s = ensure();
    return new Promise((resolve, reject) => {
      const req = s.request({ ':method': method, ':path': path, ...headers });
      let chunks = [];
      let status = 0;
      req.on('response', h => { status = h[':status']; });
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}

export function createApnsClient({ jwt, topic, transport }) {
  return {
    async send(deviceToken, payload) {
      const body = JSON.stringify(payload);
      const token = await jwt.get();
      const res = await transport({
        method: 'POST',
        path: `/3/device/${deviceToken}`,
        headers: {
          authorization: `bearer ${token}`,
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      });
      let reason = null;
      if (res.status >= 400 && res.body) {
        try { reason = JSON.parse(res.body).reason ?? null; } catch {}
      }
      return { status: res.status, reason };
    },
  };
}
