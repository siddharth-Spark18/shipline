// Server-sent events: one stream per browser tab. Node 20+, no dependencies.

const HEARTBEAT_MS = 15_000;

// deviceState(deviceId) -> null while a paired device may stay connected, else the reason to cut it off
// ('revoked' | 'remote-off'). It is asked on every heartbeat, so a revoke made by another `shipline ui` process
// takes effect within one heartbeat.
export function createHub({ deviceState = () => null } = {}) {
  const clients = new Set();
  const connectFns = [];

  const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  return {
    // deviceId tags a stream opened by a paired phone (undefined for the laptop).
    connect(req, res, { deviceId } = {}) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const client = { res, timer: null, deviceId };
      const cleanup = () => {
        clearInterval(client.timer);
        clients.delete(client);
      };
      client.timer = setInterval(() => {
        const reason = client.deviceId === undefined ? null : deviceState(client.deviceId);
        if (reason) return void end(client, reason);
        res.write(': ping\n\n');
      }, HEARTBEAT_MS);
      client.timer.unref();
      clients.add(client);
      req.on('close', cleanup);
      res.on('error', cleanup);
      // Modules re-send their state (banners, pending prompts) to just this connection.
      const reply = (type, data) => res.write(frame(type, data));
      for (const fn of connectFns) {
        try {
          fn(reply);
        } catch {
          // One module's failure must not stop the stream.
        }
      }
    },

    send(type, data) {
      const text = frame(type, data);
      for (const c of clients) c.res.write(text);
    },

    // Ends every stream for which fn(client) is true ({ deviceId }), telling it why.
    closeWhere(fn, reason) {
      for (const c of [...clients]) if (fn(c)) end(c, reason);
    },

    // How many browser tabs are connected.
    size() {
      return clients.size;
    },

    // fn(reply) runs for every new connection; reply(type, data) writes to that connection only.
    onConnect(fn) {
      connectFns.push(fn);
    },

    close() {
      for (const c of clients) {
        clearInterval(c.timer);
        c.res.end();
      }
      clients.clear();
    },
  };
}
