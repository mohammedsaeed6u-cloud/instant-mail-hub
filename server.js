const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');

const PORT = process.env.PORT || 3333;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Guerrilla Mail API Helper
async function guerrillaRequest(params = {}) {
  const query = new URLSearchParams(params).toString();
  const targetUrl = `https://api.guerrillamail.com/ajax.php?${query}`;
  const res = await fetch(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) throw new Error(`Guerrilla Mail error: ${res.status}`);
  return await res.json();
}

// Mail.tm API Helper (fallback)
async function mailtmRequest(endpoint, options = {}) {
  const targetUrl = `https://api.mail.tm${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
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

// Ensure an active Guerrilla session for a given username
async function getGuerrillaSession(username, existingToken) {
  if (existingToken) {
    try {
      const check = await guerrillaRequest({ f: 'get_email_address', sid_token: existingToken });
      if (check && check.sid_token) {
        if (username && !check.email_addr.startsWith(username)) {
          await guerrillaRequest({ f: 'set_email_user', email_user: username, sid_token: check.sid_token });
        }
        return check.sid_token;
      }
    } catch (e) {}
  }

  // Create fresh session and assign username
  try {
    const init = await guerrillaRequest({ f: 'get_email_address' });
    if (username) {
      await guerrillaRequest({ f: 'set_email_user', email_user: username, sid_token: init.sid_token });
    }
    return init.sid_token;
  } catch (err) {
    console.error('Guerrilla session error:', err);
    return existingToken;
  }
}

// Extract OTP / verification codes
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Provider, X-Address, X-Account-Id');

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

    // 2. Accounts List: GET /api/accounts
    if (pathname === '/api/accounts' && req.method === 'GET') {
      const accounts = await db.getAccounts();
      return sendJson({ accounts });
    }

    // 3. Create Account: POST /api/accounts/create
    if (pathname === '/api/accounts/create' && req.method === 'POST') {
      const body = await parseBody();
      let domain = body.domain || 'sharklasers.com';
      let username = body.username ? body.username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') : '';
      if (!username) {
        username = 'mail_' + Math.random().toString(36).substring(2, 9);
      }

      try {
        const initData = await guerrillaRequest({ f: 'get_email_address' });
        const sid_token = initData.sid_token;

        let email = `${username}@${domain}`;
        const setUserData = await guerrillaRequest({
          f: 'set_email_user',
          email_user: username,
          sid_token
        });
        if (setUserData && setUserData.email_addr) {
          email = setUserData.email_addr.replace(/@.*$/, `@${domain}`);
        }

        const newAccount = {
          id: 'acc_' + username,
          username: username,
          address: email,
          domain: domain,
          token: sid_token,
          provider: 'guerrilla',
          createdAt: new Date().toISOString(),
          note: body.note || '',
          isPermanent: true
        };

        await db.saveAccount(newAccount);
        return sendJson({ success: true, account: newAccount }, 201);
      } catch (gErr) {
        console.error('Account creation error:', gErr);
        return sendError('Failed to create account: ' + gErr.message, 500);
      }
    }

    // 4. Reclaim / Add Existing Account: POST /api/accounts/reclaim
    if (pathname === '/api/accounts/reclaim' && req.method === 'POST') {
      const body = await parseBody();
      let address = (body.address || '').trim().toLowerCase();
      let domain = body.domain || 'sharklasers.com';
      let username = body.username ? body.username.trim().toLowerCase() : '';

      if (address.includes('@')) {
        const parts = address.split('@');
        username = parts[0];
        domain = parts[1] || domain;
      }

      if (!username) {
        return sendError('Username or address is required', 400);
      }

      const sid_token = await getGuerrillaSession(username);
      const email = `${username}@${domain}`;
      const account = {
        id: 'acc_' + username,
        username: username,
        address: email,
        domain: domain,
        token: sid_token,
        provider: 'guerrilla',
        createdAt: new Date().toISOString(),
        note: body.note || 'حساب مسترجع (دائم)',
        isPermanent: true
      };

      await db.saveAccount(account);
      return sendJson({ success: true, account }, 200);
    }

    // 5. Delete Account: DELETE /api/accounts/:id
    if (pathname.startsWith('/api/accounts/') && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      await db.deleteAccount(id);
      return sendJson({ success: true, message: 'Account removed' });
    }

    // 6. Messages List & Single Message: GET /api/messages
    if (pathname === '/api/messages' && req.method === 'GET') {
      const authHeader = req.headers['authorization'] || '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) token = parsedUrl.searchParams.get('token');

      const accountAddress = req.headers['x-address'] || parsedUrl.searchParams.get('address') || '';
      const provider = req.headers['x-provider'] || parsedUrl.searchParams.get('provider') || 'guerrilla';
      const msgId = parsedUrl.searchParams.get('msgId');

      // A. Fetch Specific Message Detail
      if (msgId) {
        // 1. Check persistent database first
        const archivedDetail = await db.getArchivedMessageDetails(msgId);
        if (archivedDetail && (archivedDetail.text || archivedDetail.html)) {
          return sendJson(archivedDetail);
        }

        // 2. Fetch from Guerrilla Mail if provider is guerrilla
        if (provider === 'guerrilla' && token) {
          try {
            const msg = await guerrillaRequest({
              f: 'fetch_email',
              email_id: msgId,
              sid_token: token
            });

            const bodyText = (msg.mail_body || '') + ' ' + (msg.mail_subject || '');
            const otpCode = extractOtp(bodyText);
            const fullMsg = {
              id: String(msg.mail_id),
              accountAddress: accountAddress || msg.mail_recipient,
              from: { name: msg.mail_from, address: msg.mail_from },
              to: [{ address: msg.mail_recipient || accountAddress }],
              subject: msg.mail_subject || '(بدون عنوان)',
              intro: msg.mail_excerpt || '',
              text: msg.mail_body || '',
              html: msg.mail_body ? msg.mail_body.replace(/\r?\n/g, '<br>') : null,
              attachments: [],
              createdAt: msg.mail_date ? new Date().toISOString() : new Date().toISOString(),
              otp: otpCode,
              seen: true
            };

            // Archive to Supabase
            await db.saveArchivedMessage(fullMsg);
            return sendJson(fullMsg);
          } catch (err) {
            console.warn('Guerrilla fetch_email failed, checking archive:', err.message);
            if (archivedDetail) return sendJson(archivedDetail);
          }
        }

        if (archivedDetail) return sendJson(archivedDetail);
        return sendError('Message not found or expired', 404);
      }

      // B. Fetch Messages List for Account
      const archivedMessages = accountAddress ? await db.getArchivedMessages(accountAddress) : [];

      // If Guerrilla, fetch fresh live emails and merge
      if (provider === 'guerrilla') {
        let liveMessages = [];
        try {
          const username = accountAddress ? accountAddress.split('@')[0] : '';
          const activeToken = await getGuerrillaSession(username, token);

          const listData = await guerrillaRequest({
            f: 'get_email_list',
            offset: 0,
            sid_token: activeToken
          });

          const rawList = listData.list || [];
          for (const m of rawList) {
            if (m.mail_id == 1) continue; // Welcome email
            const mId = String(m.mail_id);
            const bodyContent = (m.mail_subject || '') + ' ' + (m.mail_excerpt || '');
            const otpCode = extractOtp(bodyContent);

            const msgSummary = {
              id: mId,
              accountAddress: accountAddress || m.mail_recipient,
              from: m.mail_from || 'Unknown',
              subject: m.mail_subject || '(بدون عنوان)',
              intro: m.mail_excerpt || '',
              createdAt: m.mail_timestamp ? new Date(parseInt(m.mail_timestamp, 10) * 1000).toISOString() : new Date().toISOString(),
              seen: m.mail_read === 1,
              hasAttachments: m.att > 0,
              size: m.size || 0,
              otp: otpCode
            };

            liveMessages.push(msgSummary);

            // Automatically archive newly arrived email into Supabase!
            const alreadyArchived = archivedMessages.some(am => String(am.id) === mId);
            if (!alreadyArchived) {
              // Fetch full body to preserve forever before Guerrilla purges after 1 hr
              guerrillaRequest({ f: 'fetch_email', email_id: mId, sid_token: activeToken })
                .then(full => {
                  db.saveArchivedMessage({
                    id: mId,
                    accountAddress: accountAddress || m.mail_recipient,
                    from: full.mail_from,
                    subject: full.mail_subject,
                    intro: full.mail_excerpt,
                    text: full.mail_body,
                    html: full.mail_body ? full.mail_body.replace(/\r?\n/g, '<br>') : null,
                    otp: otpCode || extractOtp(full.mail_body),
                    seen: true,
                    createdAt: msgSummary.createdAt
                  });
                })
                .catch(() => {});
            }
          }
        } catch (err) {
          console.warn('Live fetch error:', err.message);
        }

        // Merge archived + live messages with unique IDs
        const map = new Map();
        for (const m of archivedMessages) {
          map.set(String(m.id), m);
        }
        for (const m of liveMessages) {
          map.set(String(m.id), { ...map.get(String(m.id)), ...m });
        }

        const merged = Array.from(map.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return sendJson({ total: merged.length, messages: merged });
      }

      // Default return archived
      return sendJson({ total: archivedMessages.length, messages: archivedMessages });
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
    const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
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
