// Simple HTTP server - ESM format
import http from 'http';

const port = 3001;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    pid: process.pid,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  }));
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});