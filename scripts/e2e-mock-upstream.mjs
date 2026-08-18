// 端到端验证用 mock 上游：HTTP 通用成功响应 + 可完成完整对话的 SMTP mock。
// 用法：node scripts/e2e-mock-upstream.mjs <httpPort> （SMTP 监听 httpPort+1）
import http from 'node:http';
import net from 'node:net';

const httpPort = Number(process.argv[2] ?? 4999);
let smtpServed = false;

const httpSrv = http.createServer((req, res) => {
  const url = `http://${req.headers.host}${req.url}`;
  console.log(`HTTP ${req.method} ${url}`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});

// 最小 SMTP 对话：EHLO → 250 PIPELINING,8BITMIME,SMTPUTF8；MAIL/RCPT → 250；DATA → 354/250；QUIT → 221
const smtpSrv = net.createServer((socket) => {
  let inData = false;
  let buffer = '';
  socket.write('220 mock-smtp ESMTP ready\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (inData) {
        if (buffer.includes('\r\n.\r\n') || line === '.') {
          inData = false;
          smtpServed = true;
          socket.write('250 OK: queued as MOCK1\r\n');
        }
        continue;
      }
      const command = line.slice(0, 4).toUpperCase();
      if (command.startsWith('EHLO') || command.startsWith('HELO')) socket.write('250-mock-smtp\r\n250-PIPELINING\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
      else if (command.startsWith('MAIL') || command.startsWith('RCPT')) socket.write('250 OK\r\n');
      else if (command.startsWith('DATA')) { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (command.startsWith('QUIT')) { socket.write('221 Bye\r\n'); socket.end(); }
      else socket.write('250 OK\r\n');
    }
  });
  socket.on('error', () => socket.destroy());
});

httpSrv.listen(httpPort, '127.0.0.1', () => {
  smtpSrv.listen(httpPort + 1, '127.0.0.1', () => {
    console.log(`mock upstream: http://127.0.0.1:${httpPort} smtp://127.0.0.1:${httpPort + 1}`);
  });
});
process.on('SIGTERM', () => { httpSrv.close(); smtpSrv.close(); process.exit(0); });
