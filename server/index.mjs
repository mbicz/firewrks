import http from 'node:http';
import serveHandler from 'serve-handler';
const server = http.createServer((req, res) =>
  serveHandler(req, res, { public: 'dist', directoryListing: false }));
const port = process.env.PORT ?? 4173;
server.listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));
