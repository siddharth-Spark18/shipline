// Server-sent events: one stream per browser tab. Node 20+, no dependencies.

const HEARTBEAT_MS = 15_000;

export function createHub() {
  const clients = new Set();
  const connectFns = [];

  const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  return {
    connect(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const client = { res, timer: null };
      client.timer = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
      client.timer.unref();
      clients.add(client);
      const cleanup = () => {
        clearInterval(client.timer);
        clients.delete(client);
      };
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
