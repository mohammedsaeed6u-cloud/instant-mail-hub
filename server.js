const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3333;
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(ACCOUNTS_FILE)) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([], null, 2), 'utf8');
}

function loadAccounts() {
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    return JSON.parse(raw) || [];
  } catch (err) {
    return [];
  }
}

function saveAccounts(accounts) {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (e) {}
}

// Mail.tm API Helper
async function mailtmRequest(endpoint, options = {}) {
  const targetUrl = `https://api.mail.tm${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ...(options.headers || {})
  };
  const res = await fetch(targetUrl, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let rawText = '';
  let data = {};
  try {
    rawText = await res.text();
    data = JSON.parse(rawText);
  } catch (e) {
    data = { rawText };
  }
  if (!res.ok) {
    const errMsg = data.message || data['hydra:description'] || `API Error: ${res.status}`;
    const error = new Error(errMsg);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

// Guerrilla Mail API Helper
async function guerrillaRequest(params = {}) {
  const query = new URLSearchParams(params).toString();
  const targetUrl = `https://api.guerrillamail.com/ajax.php?${query}`;
  const res = await fetch(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`Guerrilla Mail error: ${res.status}`);
  return await res.json();
}

async function getAccountToken(account) {
  if (account.provider === 'guerrilla') {
    return account.token;
  }
  try {
    const tokenRes = await mailtmRequest('/token', {
      method: 'POST',
      body: { address: account.address, password: account.password }
    });
    return tokenRes.token;
  } catch (err) {
    return account.token;
  }
}

function extractOtp(text) {
  if (!text) return null;
  const patterns = [
    /(?:code|pin|verification|verifying|رمز|كود)[\s:=#\-]+([0-9]{4,8})/i,
    /\b([0-9]{4,8})\b/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const num = parseInt(match[1], 10);
      if (num >= 1990 && num <= 2030 && match[1].length === 4) continue;
      return match[1];
    }
  }
  return null;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Provider');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parseBody = () => new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });

  const sendJson = (data, statusCode = 200) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  const sendError = (msg, statusCode = 500) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: msg }));
  };

  try {
    // 1. Domains: GET /api/domains
    if (pathname === '/api/domains' && req.method === 'GET') {
      const domains = [
        'sharklasers.com',
        'guerrillamail.com',
        'grr.la',
        'guerrillamailblock.com'
      ];
      return sendJson({ domains });
    }

    // 2. Token Refresh: POST /api/token
    if (pathname === '/api/token' && req.method === 'POST') {
      const body = await parseBody();
      if (body.provider === 'guerrilla') {
        return sendJson({ token: body.token || body.sid_token });
      }
      try {
        const tokenRes = await mailtmRequest('/token', {
          method: 'POST',
          body: { address: body.address, password: body.password }
        });
        return sendJson(tokenRes);
      } catch (err) {
        return sendError('Token refresh failed', 401);
      }
    }

    // 3. Accounts List: GET /api/accounts
    if (pathname === '/api/accounts' && req.method === 'GET') {
      const accounts = loadAccounts();
      return sendJson({ accounts });
    }

    // 4. Create Account: POST /api/accounts/create
    if (pathname === '/api/accounts/create' && req.method === 'POST') {
      const body = await parseBody();
      let domain = body.domain || 'sharklasers.com';
      let username = body.username ? body.username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') : '';
      if (!username) {
        username = 'mail_' + Math.random().toString(36).substring(2, 9);
      }

      // Check if domain is Guerrilla Mail or fallback
      const isGuerrilla = domain.includes('guerrilla') || domain.includes('sharklasers') || domain.includes('grr.la');
      
      if (isGuerrilla || domain !== 'uberip.com') {
        try {
          const initData = await guerrillaRequest({ f: 'get_email_address' });
          const sid_token = initData.sid_token;
          
          let email = `${username}@${domain}`;
          if (username) {
            const setUserData = await guerrillaRequest({
              f: 'set_email_user',
              email_user: username,
              sid_token
            });
            email = setUserData.email_addr.replace(/@.*$/, `@${domain}`);
          } else {
            email = initData.email_addr.replace(/@.*$/, `@${domain}`);
          }

          const newAccount = {
            id: sid_token,
            address: email,
            password: 'g_' + Math.random().toString(36).substring(2, 8),
            domain: domain,
            token: sid_token,
            provider: 'guerrilla',
            createdAt: new Date().toISOString(),
            note: body.note || ''
          };

          const accounts = loadAccounts();
          accounts.unshift(newAccount);
          saveAccounts(accounts);

          return sendJson({ success: true, account: newAccount }, 201);
        } catch (gErr) {
          console.error('Guerrilla create error:', gErr);
        }
      }

      // Fallback or explicit Mail.tm creation
      try {
        const email = `${username}@${domain}`;
        const password = body.password || ('Pass_' + Math.random().toString(36).substring(2, 10) + '!9');
        const createRes = await mailtmRequest('/accounts', {
          method: 'POST',
          body: { address: email, password }
        });
        const tokenRes = await mailtmRequest('/token', {
          method: 'POST',
          body: { address: email, password }
        });

        const newAccount = {
          id: createRes.id,
          address: email,
          password: password,
          domain: domain,
          token: tokenRes.token,
          provider: 'mailtm',
          createdAt: new Date().toISOString(),
          note: body.note || ''
        };

        const accounts = loadAccounts();
        accounts.unshift(newAccount);
        saveAccounts(accounts);
        return sendJson({ success: true, account: newAccount }, 201);
      } catch (mErr) {
        // If Mail.tm fails, fallback transparently to Guerrilla Mail!
        const initData = await guerrillaRequest({ f: 'get_email_address' });
        const sid_token = initData.sid_token;
        const newAccount = {
          id: sid_token,
          address: `${username}@sharklasers.com`,
          password: 'g_' + Math.random().toString(36).substring(2, 8),
          domain: 'sharklasers.com',
          token: sid_token,
          provider: 'guerrilla',
          createdAt: new Date().toISOString(),
          note: body.note || ''
        };
        const accounts = loadAccounts();
        accounts.unshift(newAccount);
        saveAccounts(accounts);
        return sendJson({ success: true, account: newAccount }, 201);
      }
    }

    // 5. Delete Account: DELETE /api/accounts/:id
    if (pathname.startsWith('/api/accounts/') && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      const accounts = loadAccounts();
      const filtered = accounts.filter(a => a.id !== id);
      saveAccounts(filtered);
      return sendJson({ success: true, message: 'Account removed' });
    }

    // 6. Messages List & Single Message: GET /api/messages
    if (pathname === '/api/messages' && req.method === 'GET') {
      const authHeader = req.headers['authorization'] || '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) token = parsedUrl.searchParams.get('token');

      const provider = req.headers['x-provider'] || parsedUrl.searchParams.get('provider') || (token && token.length > 20 && !token.includes('.') ? 'guerrilla' : 'mailtm');
      const msgId = parsedUrl.searchParams.get('msgId');

      if (!token) return sendError('Token required', 401);

      // A. Guerrilla Mail Provider
      if (provider === 'guerrilla') {
        if (msgId) {
          const msg = await guerrillaRequest({
            f: 'fetch_email',
            email_id: msgId,
            sid_token: token
          });
          const bodyText = (msg.mail_body || '') + ' ' + (msg.mail_subject || '');
          return sendJson({
            id: msg.mail_id,
            from: { name: msg.mail_from, address: msg.mail_from },
            to: [{ address: msg.mail_recipient }],
            subject: msg.mail_subject || '(بدون عنوان)',
            intro: msg.mail_excerpt,
            text: msg.mail_body,
            html: msg.mail_body ? msg.mail_body.replace(/\r?\n/g, '<br>') : null,
            attachments: [],
            createdAt: new Date().toISOString(),
            otp: extractOtp(bodyText)
          });
        }

        const listData = await guerrillaRequest({
          f: 'get_email_list',
          offset: 0,
          sid_token: token
        });
        const raw = listData.list || [];
        const messages = raw.map(m => ({
          id: m.mail_id,
          from: m.mail_from || 'Unknown',
          subject: m.mail_subject || '(بدون عنوان)',
          intro: m.mail_excerpt || '',
          createdAt: new Date().toISOString(),
          seen: m.mail_read === 1,
          hasAttachments: m.att > 0,
          size: m.size || 0,
          otp: extractOtp((m.mail_subject || '') + ' ' + (m.mail_excerpt || ''))
        }));
        return sendJson({ total: messages.length, messages });
      }

      // B. Mail.tm Provider
      if (msgId) {
        const msg = await mailtmRequest(`/messages/${msgId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const bodyText = (msg.text || '') + ' ' + (msg.subject || '');
        return sendJson({
          id: msg.id,
          from: msg.from,
          to: msg.to,
          subject: msg.subject || '(بدون عنوان)',
          intro: msg.intro,
          text: msg.text,
          html: msg.html ? msg.html[0] : null,
          attachments: msg.attachments || [],
          createdAt: msg.createdAt,
          otp: extractOtp(bodyText)
        });
      }

      const data = await mailtmRequest('/messages', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const rawMessages = data['hydra:member'] || [];
      const messages = rawMessages.map(m => ({
        id: m.id,
        from: m.from ? `${m.from.name || ''} <${m.from.address}>`.trim() : 'Unknown',
        subject: m.subject || '(بدون عنوان)',
        intro: m.intro || '',
        createdAt: m.createdAt,
        seen: m.seen,
        hasAttachments: m.hasAttachments,
        size: m.size,
        otp: extractOtp((m.subject || '') + ' ' + (m.intro || ''))
      }));
      return sendJson({ total: data['hydra:totalItems'] || messages.length, messages });
    }

    // Static Files (check root first, then public/)
    let reqPath = pathname === '/' ? '/index.html' : pathname;
    let localPath = path.join(__dirname, reqPath);
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
      localPath = path.join(PUBLIC_DIR, reqPath);
    }

    if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
      const ext = path.extname(localPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      return fs.createReadStream(localPath).pipe(res);
    }

    // Fallback to index.html
    const fallbackPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(fallbackPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(fallbackPath).pipe(res);
    }

    return sendError('Not Found', 404);
  } catch (err) {
    console.error(`[Server Error] ${req.method} ${pathname}:`, err);
    return sendError(err.message || 'Internal Server Error', err.status || 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`📬 InstantMail Hub Server is running at port ${PORT}`);
});
