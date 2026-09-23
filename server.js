const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3333;
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure data directory and file exist
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
    console.error('Error reading accounts:', err);
    return [];
  }
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}

// Mail.tm API Helper
async function mailtmRequest(endpoint, options = {}) {
  const targetUrl = `https://api.mail.tm${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
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
    console.error(`[MailTM Error] ${res.status}:`, rawText);
    const errMsg = data.message || data['hydra:description'] || `API Error: ${res.status} - ${rawText.slice(0, 150)}`;
    const error = new Error(errMsg);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

// Helper to get or refresh account token
async function getAccountToken(account) {
  try {
    const tokenRes = await mailtmRequest('/token', {
      method: 'POST',
      body: { address: account.address, password: account.password }
    });
    return tokenRes.token;
  } catch (err) {
    console.error(`Failed to get token for ${account.address}:`, err.message);
    throw err;
  }
}

// Extract OTP / verification codes from text or HTML
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
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parseBody = () => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
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
    if (pathname === '/api/domains' && req.method === 'GET') {
      try {
        const data = await mailtmRequest('/domains');
        const domains = (data['hydra:member'] || []).filter(d => d.isActive).map(d => d.domain);
        if (domains && domains.length > 0) return sendJson({ domains });
      } catch (e) {
        console.warn('[Domains Fetch Fallback]', e.message);
      }
      return sendJson({ domains: ['uberip.com'] });
    }

    if (pathname === '/api/accounts' && req.method === 'GET') {
      const accounts = loadAccounts();
      return sendJson({ accounts });
    }

    if (pathname === '/api/accounts/create' && req.method === 'POST') {
      const body = await parseBody();
      
      let availableDomains = [];
      try {
        const domainsData = await mailtmRequest('/domains');
        availableDomains = (domainsData['hydra:member'] || []).filter(d => d.isActive);
      } catch (e) {
        console.warn('[Create Domains Fallback]', e.message);
        availableDomains = [{ domain: 'uberip.com', isActive: true }];
      }
      
      if (!availableDomains.length) {
        availableDomains = [{ domain: 'uberip.com', isActive: true }];
      }
      
      const domain = body.domain && availableDomains.some(d => d.domain === body.domain)
        ? body.domain
        : availableDomains[0].domain;

      let username = body.username ? body.username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') : '';
      if (!username) {
        username = 'mail_' + Math.random().toString(36).substring(2, 9);
      }
      
      const email = `${username}@${domain}`;
      const password = body.password || ('Pass_' + Math.random().toString(36).substring(2, 10) + '!9');
      
      console.log(`[API] Creating account: ${email}`);
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
        createdAt: new Date().toISOString(),
        note: body.note || ''
      };

      const accounts = loadAccounts();
      accounts.unshift(newAccount);
      saveAccounts(accounts);

      return sendJson({ success: true, account: newAccount }, 201);
    }

    if (pathname === '/api/token' && req.method === 'POST') {
      const body = await parseBody();
      if (!body.address || !body.password) {
        return sendError('Address and password required', 400);
      }
      try {
        const tokenRes = await mailtmRequest('/token', {
          method: 'POST',
          body: { address: body.address, password: body.password }
        });
        return sendJson(tokenRes);
      } catch (err) {
        return sendError(err.message || 'Authentication failed', 401);
      }
    }

    if (pathname.startsWith('/api/accounts/') && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      const accounts = loadAccounts();
      const account = accounts.find(a => a.id === id);
      if (!account) return sendError('Account not found', 404);

      try {
        const token = await getAccountToken(account);
        await mailtmRequest(`/accounts/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        }).catch(e => console.log('Mailtm delete note:', e.message));
      } catch (e) {
        // Continue even if remote delete fails
      }

      const filtered = accounts.filter(a => a.id !== id);
      saveAccounts(filtered);
      return sendJson({ success: true, message: 'Account removed' });
    }

    // Route for /api/messages with Bearer token
    if (pathname === '/api/messages' && req.method === 'GET') {
      const authHeader = req.headers['authorization'] || '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      const parsedUrlObj = new URL(req.url, 'http://localhost');
      if (!token) token = parsedUrlObj.searchParams.get('token');

      if (!token) {
        return sendError('Token required', 401);
      }

      const msgId = parsedUrlObj.searchParams.get('msgId');
      if (msgId) {
        try {
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
        } catch (e) {
          return sendError(e.message || 'Error fetching message', 500);
        }
      }

      try {
        const data = await mailtmRequest('/messages', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const rawMessages = data['hydra:member'] || [];
        const messages = rawMessages.map(m => ({
          id: m.id,
          from: m.from ? `${m.from.name || ''} <${m.from.address}>`.trim() : 'Unknown',
          subject: m.subject || '(بدون عنوان / No Subject)',
          intro: m.intro || '',
          createdAt: m.createdAt,
          seen: m.seen,
          hasAttachments: m.hasAttachments,
          size: m.size,
          otp: extractOtp((m.subject || '') + ' ' + (m.intro || ''))
        }));
        return sendJson({ total: data['hydra:totalItems'] || messages.length, messages });
      } catch (e) {
        return sendError(e.message || 'Error fetching message list', 500);
      }
    }

    const messagesMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/messages$/);
    if (messagesMatch && req.method === 'GET') {
      const id = messagesMatch[1];
      const accounts = loadAccounts();
      const account = accounts.find(a => a.id === id);
      
      // Token can be from saved account OR from client header
      let token = req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : null;
      if (!token && account) {
        token = await getAccountToken(account);
      }
      
      if (!token) return sendError('Account or token not found', 404);

      const data = await mailtmRequest('/messages', {
        headers: { Authorization: `Bearer ${token}` }
      });

      const rawMessages = data['hydra:member'] || [];
      const messages = rawMessages.map(m => ({
        id: m.id,
        from: m.from ? `${m.from.name || ''} <${m.from.address}>`.trim() : 'Unknown',
        subject: m.subject || '(بدون عنوان / No Subject)',
        intro: m.intro || '',
        createdAt: m.createdAt,
        seen: m.seen,
        hasAttachments: m.hasAttachments,
        size: m.size,
        otp: extractOtp((m.subject || '') + ' ' + (m.intro || ''))
      }));

      return sendJson({ total: data['hydra:totalItems'] || messages.length, messages });
    }

    const singleMsgMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/messages\/([^/]+)$/);
    if (singleMsgMatch && req.method === 'GET') {
      const accountId = singleMsgMatch[1];
      const msgId = singleMsgMatch[2];
      const accounts = loadAccounts();
      const account = accounts.find(a => a.id === accountId);
      if (!account) return sendError('Account not found', 404);

      const token = await getAccountToken(account);
      const msg = await mailtmRequest(`/messages/${msgId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const bodyText = (msg.text || '') + ' ' + (msg.subject || '');
      const detectedOtp = extractOtp(bodyText);

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
        otp: detectedOtp
      });
    }

    // Static Files
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendError('Access denied', 403);
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      return fs.createReadStream(filePath).pipe(res);
    }

    const fallbackIndex = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(fallbackIndex)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(fallbackIndex).pipe(res);
    }

    return sendError('Not Found', 404);
  } catch (err) {
    console.error(`[Server Error] ${req.method} ${pathname}:`, err);
    return sendError(err.message || 'Internal Server Error', err.status || 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`📬 InstantMail Hub Server is running at http://localhost:${PORT}`);
});
