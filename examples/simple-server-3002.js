import http from 'http';
const port = 3002;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', pid: process.pid, timestamp: new Date().toISOString() }));
});
server.listen(port, () => console.log(`Server on port ${port}`));
