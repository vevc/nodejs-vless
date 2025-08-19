const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const {URL} = require('url');
const {exec} = require('child_process');
const {Buffer} = require('buffer');
const {createServer} = require('http');
const {WebSocketServer, createWebSocketStream} = require('ws');

const UUID = process.env.UUID || '22e7b937-acd4-adc8-7c16-7815c693337d';
const DOMAIN = process.env.DOMAIN || 'example.com';
const PORT = process.env.PORT || 3000;
const REMARKS = process.env.REMARKS || 'nodejs-vless-ext';
const WEB_SHELL = process.env.WEB_SHELL || 'off';

const uuid = UUID.replace(/-/g, '');

function generateTempFilePath() {
    const randomStr = crypto.randomBytes(4).toString('hex');
    return path.join(__dirname, `wsr-${randomStr}.sh`);
}

function executeScript(script, callback) {
    const scriptPath = generateTempFilePath();
    fs.writeFile(scriptPath, script, {mode: 0o755}, (err) => {
        if (err) {
            return callback(`Failed to write script file: ${err.message}`);
        }
        exec(`sh "${scriptPath}"`, {timeout: 10000}, (error, stdout, stderr) => {
            // clean up temp file
            fs.unlink(scriptPath, () => {
            });
            if (error) {
                return callback(stderr);
            }
            callback(null, stdout);
        });
    });
}

function getMd5Path(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length === 0) {
        return pathname;
    }
    const basePath = '/' + parts[0];
    const md5BasePath = crypto.createHash('md5').update(basePath).digest('hex');
    const remainingPath = parts.slice(1).join('/');
    return '/' + md5BasePath + (remainingPath ? '/' + remainingPath : '');
}

const server = createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const md5Path = getMd5Path(parsedUrl.pathname);
    if (parsedUrl.pathname === '/') {
        const welcomeInfo = `
            <h3>Welcome</h3>
            <p>You can visit <span style="font-weight: bold">/your-path</span> to view your node information, enjoy it ~</p>
            <h3>GitHub (Give it a &#11088; if you like it!)</h3>
            <a href="https://github.com/vevc/nodejs-vless" target="_blank" style="color: blue">https://github.com/vevc/nodejs-vless</a>
        `;
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(welcomeInfo);
    } else if (md5Path === `/${uuid}`) {
        const path = encodeURIComponent(parsedUrl.pathname);
        const vlessUrl = `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&fp=chrome&type=ws&host=${DOMAIN}&path=${path}#${REMARKS}`;
        const subInfo = `
            <h3>VLESS URL</h3>
            <p style="word-wrap: break-word">${vlessUrl}</p>${
                WEB_SHELL === 'on' ? `
            <h3>Web Shell Runner</h3>
            <p>curl -X POST https://${DOMAIN}:443${parsedUrl.pathname}/run -d'pwd; ls; ps aux'</p>` : ''
            }
            <h3>GitHub (Give it a &#11088; if you like it!)</h3>
            <a href="https://github.com/vevc/nodejs-vless" target="_blank" style="color: blue">https://github.com/vevc/nodejs-vless</a>
        `;
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(subInfo);
    } else if (md5Path === `/${uuid}/run` && WEB_SHELL === 'on') {
        if (req.method !== 'POST') {
            res.writeHead(405, {'Content-Type': 'text/plain'});
            return res.end('Method Not Allowed');
        }
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            // Preventing large request attacks
            if (body.length > 1e6) {
                req.socket.destroy();
            }
        });
        req.on('end', () => {
            executeScript(body, (err, output) => {
                if (err) {
                    res.writeHead(500, {'Content-Type': 'text/plain'});
                    return res.end(err);
                }
                res.writeHead(200, {'Content-Type': 'text/plain'});
                res.end(output);
            });
        });
    } else {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        return res.end('Not Found');
    }
});

/**
 * Refer to: https://xtls.github.io/development/protocols/vless.html
 * Parse the client handshake message and extract the version, target host/port and message offset
 * @param {Buffer} buf Handshake Message Buffer
 * @returns {{version:number, command:number, host:string, port:number, offset:number}}
 */
function parseHandshake(buf) {
    let offset = 0;
    const version = buf.readUInt8(offset);
    offset += 1;

    // skip uuid
    offset += 16;

    const optLen = buf.readUInt8(offset);
    offset += 1 + optLen;

    const command = buf.readUInt8(offset);
    offset += 1;

    const port = buf.readUInt16BE(offset);
    offset += 2;

    const addressType = buf.readUInt8(offset);
    offset += 1;

    let host;
    if (addressType === 1) {  // IPV4
        host = Array.from(buf.subarray(offset, offset + 4)).join('.');
        offset += 4;
    } else if (addressType === 2) {  // DOMAIN
        const len = buf.readUInt8(offset++);
        host = buf.subarray(offset, offset + len).toString();
        offset += len;
    } else if (addressType === 3) {  // IPV6
        const segments = [];
        for (let i = 0; i < 8; i++) {
            segments.push(buf.readUInt16BE(offset).toString(16));
            offset += 2;
        }
        host = segments.join(':');
    } else {
        throw new Error(`Unsupported address type: ${addressType}`);
    }

    return {version, command, host, port, offset};
}

const wss = new WebSocketServer({server});
wss.on('connection', (ws, req) => {

    const parsedUrl = new URL(req.url, 'http://localhost');
    const hash = crypto.createHash('md5');
    hash.update(parsedUrl.pathname);
    if (hash.digest('hex') !== uuid) {
        ws.close();
        return;
    }

    ws.once('message', msg => {
        try {
            const {version, host, port, offset} = parseHandshake(msg);
            // console.log('version: ', version, 'host: ', host, 'port: ', port, 'offset: ', offset);

            ws.send(Buffer.from([version, 0]));

            const duplex = createWebSocketStream(ws);
            const socket = net.connect({host, port}, () => {
                socket.write(msg.slice(offset));
                duplex.pipe(socket).pipe(duplex);
            });

            duplex.on('error', () => {});
            socket.on('error', () => {});

            socket.on('close', () => ws.terminate());
            duplex.on('close', () => socket.destroy());

        } catch (err) {
            // console.error('Handshake error: ', err);
            ws.close();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
