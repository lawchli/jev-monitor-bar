import http from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {EventStore} from './store';
import {removeSessionFileIfOwned, writeSessionFile} from './session';
export async function startServer(store: EventStore, sessionFile: string, port = 0) {
  const token = randomBytes(32).toString('hex');
  // Node enforces requestTimeout only on this periodic check (default 30 s), so a stalled body got 408 about 10 s late.
  const server = http.createServer({connectionsCheckingInterval: 500}, async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const respond = (status: number, body: object) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      respond(403, {error: 'Origin rejected'});
      return;
    }
    // The `Bearer ` prefix is required; a bare token is rejected like a wrong one.
    const header = req.headers.authorization ?? '';
    const provided = Buffer.from(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '');
    const expected = Buffer.from(token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      respond(401, {error: 'Local session credential required'});
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      respond(200, {ok: true, cursor: store.cursor});
      return;
    }
    if (req.method !== 'POST' || req.url !== '/events') {
      respond(404, {error: 'Not found'});
      return;
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      respond(415, {error: 'JSON required'});
      return;
    }
    const tooLarge = () => {
      res.setHeader('Connection', 'close');
      respond(413, {error: '64 KiB event limit'});
    };
    if (Number(req.headers['content-length']) > 65536) {
      tooLarge();
      req.resume();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      // Breaking out of the body iterator destroys the socket before the 413 is flushed, so drain instead.
      for await (const chunk of req) {
        size += chunk.length;
        if (size <= 65536) chunks.push(chunk);
      }
      if (size > 65536) {
        tooLarge();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        respond(400, {error: 'Invalid JSON'});
        return;
      }
      try {
        const result = store.ingest(value);
        respond('conflict' in result ? 409 : 200, result);
      } catch (e) {
        respond((e as NodeJS.ErrnoException).code ? 503 : 400, {
          error: (e as NodeJS.ErrnoException).code ? 'Storage unavailable' : 'Invalid protocol event',
        });
      }
    } catch {
      if (!res.headersSent) respond(400, {error: 'Incomplete request'});
    }
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 3000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address() as {port: number};
  const session = {url: `http://127.0.0.1:${address.port}`, token};
  try {
    writeSessionFile(sessionFile, session);
  } catch (error) {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    throw error;
  }
  return {
    server,
    session,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => {
          try {
            removeSessionFileIfOwned(sessionFile, token);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        server.closeAllConnections();
      }),
  };
}
