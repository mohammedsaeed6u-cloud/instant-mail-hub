const url = require('url');

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data.message || data['hydra:description'] || `API Error: ${res.status}`;
    const error = new Error(errMsg);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
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

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  // Helper for JSON response
  const sendJson = (data, statusCode = 200) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  };

  const sendError = (msg, statusCode = 500) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: msg }));
  };

  // Helper to parse body if not already parsed
  const getBody = () => new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
  });

  try {
    // 1. Domains endpoint: GET /api/domains
    if (pathname.endsWith('/domains') && req.method === 'GET') {
      const data = await mailtmRequest('/domains');
      const domains = (data['hydra:member'] || []).filter(d => d.isActive).map(d => d.domain);
      return sendJson({ domains });
    }

    // 2. Create Account: POST /api/accounts/create
    if (pathname.endsWith('/accounts/create') && req.method === 'POST') {
      const body = await getBody();
      
      const domainsData = await mailtmRequest('/domains');
      const availableDomains = (domainsData['hydra:member'] || []).filter(d => d.isActive);
      if (!availableDomains.length) {
        return sendError('No active domains available', 503);
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
      
      const createRes = await mailtmRequest('/accounts', {
        method: 'POST',
        body: { address: email, password }
      });

      const tokenRes = await mailtmRequest('/token', {
        method: 'POST',
        body: { address: email, password }
      });

      const account = {
        id: createRes.id,
        address: email,
        password: password,
        domain: domain,
        token: tokenRes.token,
        createdAt: new Date().toISOString(),
        note: body.note || ''
      };

      return sendJson({ success: true, account }, 201);
    }

    // 3. Messages List: GET /api/messages
    const token = req.headers['authorization'] || (query.token ? `Bearer ${query.token}` : null);
    
    if (pathname.endsWith('/messages') && req.method === 'GET') {
      if (!token) return sendError('Authorization token required', 401);
      
      const msgId = query.msgId;
      if (msgId) {
        // Fetch specific message
        const msg = await mailtmRequest(`/messages/${msgId}`, {
          headers: { Authorization: token }
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

      // Fetch message list
      const data = await mailtmRequest('/messages', {
        headers: { Authorization: token }
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

    // 4. Delete Account: DELETE /api/accounts/delete
    if (pathname.endsWith('/accounts/delete') && req.method === 'DELETE') {
      const accountId = query.id;
      if (!accountId || !token) return sendError('ID and Token required', 400);

      await mailtmRequest(`/accounts/${accountId}`, {
        method: 'DELETE',
        headers: { Authorization: token }
      }).catch(e => console.log('Mailtm delete notice:', e.message));

      return sendJson({ success: true, message: 'Account removed' });
    }

    return sendError('Route not found', 404);
  } catch (err) {
    console.error(`[Vercel Function Error] ${req.method} ${pathname}:`, err);
    return sendError(err.message || 'Internal Server Error', err.status || 500);
  }
};
