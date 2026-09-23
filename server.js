const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const nodemailer = require('nodemailer');
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

// Email Transporter Factory
function createTransporter(settings) {
  const host = settings.smtp_host || 'smtp.gmail.com';
  const port = parseInt(settings.smtp_port || '465', 10);
  const secure = port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: settings.smtp_user,
      pass: settings.smtp_pass
    }
  });
}

// Forward a message to user's personal email or Telegram
async function forwardMessage(msg, settings) {
  if (!settings.forwarding_enabled || settings.forwarding_enabled === 'false') {
    return false;
  }

  let forwardedAny = false;

  // 1. Forward via Email (SMTP)
  if (settings.target_email && settings.smtp_user && settings.smtp_pass) {
    const transporter = createTransporter(settings);
    const otpBanner = msg.otp ? `
      <div style="background:#f0f7ff;border:2px dashed #1877f2;border-radius:10px;padding:16px;text-align:center;margin:15px 0;">
        <span style="font-size:14px;color:#1877f2;font-weight:bold;display:block;">🔑 كود التفعيل المستخرج:</span>
        <span style="font-size:32px;font-weight:bold;color:#1877f2;letter-spacing:6px;display:block;margin-top:6px;">${msg.otp}</span>
      </div>
    ` : '';

    const htmlContent = `
      <div dir="rtl" style="font-family:'Cairo',sans-serif,Arial;max-width:600px;margin:auto;padding:20px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;color:#1e293b;">
        <div style="border-bottom:1px solid #e2e8f0;padding-bottom:12px;margin-bottom:16px;">
          <h2 style="margin:0;color:#2563eb;font-size:20px;">⚡ بريد إنستانت - إعادة توجيه رسالة</h2>
          <small style="color:#64748b;">تم تحويل هذه الرسالة تلقائياً من بريدك الدائم</small>
        </div>
        
        ${otpBanner}

        <table style="width:100%;margin-bottom:16px;font-size:14px;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#64748b;width:120px;"><strong>المرسل:</strong></td><td style="direction:ltr;text-align:right;">${msg.from}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;"><strong>الإيميل المستلم:</strong></td><td style="direction:ltr;text-align:right;">${msg.accountAddress}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;"><strong>العنوان:</strong></td><td>${msg.subject || '(بدون عنوان)'}</td></tr>
          <tr><td style="padding:6px 0;color:#64748b;"><strong>التاريخ:</strong></td><td>${new Date(msg.createdAt).toLocaleString('ar-EG')}</td></tr>
        </table>

        <div style="border-top:1px solid #e2e8f0;padding-top:16px;margin-top:16px;">
          <h4 style="margin:0 0 10px 0;color:#334155;">محتوى الرسالة:</h4>
          ${msg.html ? msg.html : `<pre style="white-space:pre-wrap;font-family:sans-serif;background:#f8fafc;padding:12px;border-radius:8px;">${msg.text || msg.intro || ''}</pre>`}
        </div>
      </div>
    `;

    const subjectPrefix = msg.otp ? `[كود: ${msg.otp}] ` : '[بريد جديد] ';
    await transporter.sendMail({
      from: `"بريد إنستانت ⚡" <${settings.smtp_user}>`,
      to: settings.target_email,
      subject: `${subjectPrefix}${msg.subject || 'رسالة جديدة'} (${msg.accountAddress})`,
      text: `وصلتك رسالة جديدة على بريدك: ${msg.accountAddress}\n\nالمرسل: ${msg.from}\nالعنوان: ${msg.subject}\nالكود: ${msg.otp || 'غير متوفر'}\n\n${msg.text || msg.intro || ''}`,
      html: htmlContent
    });
    forwardedAny = true;
  }

  // 2. Forward via Telegram Bot (if configured)
  if (settings.telegram_token && settings.telegram_chat_id) {
    const otpLine = msg.otp ? `\n🔑 *كود التفعيل:* \`${msg.otp}\`\n` : '';
    const textMsg = `⚡ *وصلتك رسالة جديدة!*\n\n📩 *الحساب:* \`${msg.accountAddress}\`\n👤 *المرسل:* ${msg.from}\n📋 *العنوان:* ${msg.subject}${otpLine}\n📝 *الملخص:* ${msg.intro || ''}`;
    await fetch(`https://api.telegram.org/bot${settings.telegram_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegram_chat_id,
        text: textMsg,
        parse_mode: 'Markdown'
      })
    }).catch(() => {});
    forwardedAny = true;
  }

  return forwardedAny;
}

// Background Worker to check and forward new emails periodically
let isCheckingForward = false;
setInterval(async () => {
  if (isCheckingForward) return;
  isCheckingForward = true;
  try {
    const settings = await db.getSettings();
    if (settings.forwarding_enabled === 'true' && (settings.target_email || settings.telegram_chat_id)) {
      const accounts = await db.getAccounts();
      for (const acc of accounts) {
        if (acc.provider === 'guerrilla') {
          const username = acc.username || acc.address.split('@')[0];
          const activeToken = await getGuerrillaSession(username, acc.token);
          const listData = await guerrillaRequest({ f: 'get_email_list', offset: 0, sid_token: activeToken }).catch(() => null);
          if (listData && listData.list) {
            for (const m of listData.list) {
              if (m.mail_id == 1) continue;
              const mId = String(m.mail_id);
              const full = await guerrillaRequest({ f: 'fetch_email', email_id: mId, sid_token: activeToken }).catch(() => null);
              const bodyContent = (full?.mail_body || '') + ' ' + (m.mail_subject || '');
              const otpCode = extractOtp(bodyContent);

              const msgObj = {
                id: mId,
                accountId: acc.id,
                accountAddress: acc.address,
                from: m.mail_from,
                subject: m.mail_subject || '(بدون عنوان)',
                intro: m.mail_excerpt || '',
                text: full ? full.mail_body : (m.mail_excerpt || ''),
                html: full && full.mail_body ? full.mail_body.replace(/\r?\n/g, '<br>') : null,
                otp: otpCode,
                createdAt: m.mail_timestamp ? new Date(parseInt(m.mail_timestamp, 10) * 1000).toISOString() : new Date().toISOString()
              };

              await db.saveArchivedMessage(msgObj);
            }
          }
        }
      }

      // Check unforwarded messages
      const unforwarded = await db.getUnforwardedMessages();
      for (const msg of unforwarded) {
        try {
          const didForward = await forwardMessage(msg, settings);
          if (didForward) {
            await db.markMessageAsForwarded(msg.id);
          }
        } catch (fErr) {
          console.error('Forwarding error for msg', msg.id, fErr.message);
        }
      }
    }
  } catch (e) {
  } finally {
    isCheckingForward = false;
  }
}, 10000);

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

    // 4. Reclaim Account: POST /api/accounts/reclaim
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

    // 6. Settings: GET /api/settings
    if (pathname === '/api/settings' && req.method === 'GET') {
      const settings = await db.getSettings();
      // Mask password for client security
      const safe = { ...settings };
      if (safe.smtp_pass) safe.has_smtp_pass = true;
      delete safe.smtp_pass;
      return sendJson(safe);
    }

    // 7. Save Settings: POST /api/settings
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await parseBody();
      const current = await db.getSettings();
      
      const updated = {
        forwarding_enabled: body.forwarding_enabled !== undefined ? String(body.forwarding_enabled) : current.forwarding_enabled || 'false',
        target_email: body.target_email !== undefined ? body.target_email.trim() : current.target_email || '',
        smtp_host: body.smtp_host !== undefined ? body.smtp_host.trim() : current.smtp_host || 'smtp.gmail.com',
        smtp_port: body.smtp_port !== undefined ? body.smtp_port.trim() : current.smtp_port || '465',
        smtp_user: body.smtp_user !== undefined ? body.smtp_user.trim() : current.smtp_user || '',
        telegram_token: body.telegram_token !== undefined ? body.telegram_token.trim() : current.telegram_token || '',
        telegram_chat_id: body.telegram_chat_id !== undefined ? body.telegram_chat_id.trim() : current.telegram_chat_id || ''
      };

      if (body.smtp_pass && body.smtp_pass !== '••••••••') {
        updated.smtp_pass = body.smtp_pass.trim();
      }

      await db.saveSettings(updated);
      return sendJson({ success: true, message: 'Settings saved' });
    }

    // 8. Test Forwarding: POST /api/settings/test
    if (pathname === '/api/settings/test' && req.method === 'POST') {
      const body = await parseBody();
      const current = await db.getSettings();
      const testSettings = { ...current, ...body };

      if (!testSettings.target_email) {
        return sendError('يرجى إدخال إيميلك الشخصي أولاً', 400);
      }

      try {
        const testMsg = {
          id: 'test_' + Date.now(),
          accountId: 'test',
          accountAddress: 'demo@sharklasers.com',
          from: 'system@instant-mail-hub',
          subject: 'رسالة تجربة التحويل التلقائي 🚀',
          intro: 'هذه رسالة اختبار للتأكد من وصول التحويل إلى بريدك الشخصي بنجاح.',
          text: 'تهانينا! نظام التحويل التلقائي في بريد إنستانت يعمل بنجاح 100%، وسيتم إرسال أي كود تفعيل يصلك هنا فوراً.',
          html: '<div style="padding:20px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px;color:#166534;"><h3 style="margin:0 0 10px 0;">🎉 نجاح اختبار التحويل!</h3><p>نظام التحويل التلقائي يعمل بنجاح. أي رسالة أو كود تفعيل يصل إلى أي بريد دائم عندك سيتم تحويله إلى هذا الإيميل فوراً.</p></div>',
          otp: '123456',
          createdAt: new Date().toISOString()
        };

        const result = await forwardMessage(testMsg, { ...testSettings, forwarding_enabled: 'true' });
        if (result) {
          return sendJson({ success: true, message: 'تم إرسال الرسالة التجريبية بنجاح إلى إيميلك! افحص صندوق الوارد (أو Spam).' });
        } else {
          return sendError('يرجى التأكد من كتابة إيميلك وبيانات الإرسال', 400);
        }
      } catch (tErr) {
        console.error('Test email error:', tErr);
        return sendError('فشل الإرسال: ' + tErr.message, 500);
      }
    }

    // 9. Messages List & Single Message: GET /api/messages
    if (pathname === '/api/messages' && req.method === 'GET') {
      const authHeader = req.headers['authorization'] || '';
      let token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) token = parsedUrl.searchParams.get('token');

      const accountAddress = req.headers['x-address'] || parsedUrl.searchParams.get('address') || '';
      const provider = req.headers['x-provider'] || parsedUrl.searchParams.get('provider') || 'guerrilla';
      const msgId = parsedUrl.searchParams.get('msgId');

      // A. Specific Message Detail
      if (msgId) {
        const archivedDetail = await db.getArchivedMessageDetails(msgId);
        if (archivedDetail && (archivedDetail.text || archivedDetail.html)) {
          return sendJson(archivedDetail);
        }

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
              createdAt: new Date().toISOString(),
              otp: otpCode,
              seen: true
            };

            await db.saveArchivedMessage(fullMsg);
            return sendJson(fullMsg);
          } catch (err) {
            if (archivedDetail) return sendJson(archivedDetail);
          }
        }

        if (archivedDetail) return sendJson(archivedDetail);
        return sendError('Message not found', 404);
      }

      // B. Messages List
      const archivedMessages = accountAddress ? await db.getArchivedMessages(accountAddress) : [];

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
            if (m.mail_id == 1) continue;
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

            const alreadyArchived = archivedMessages.some(am => String(am.id) === mId);
            if (!alreadyArchived) {
              guerrillaRequest({ f: 'fetch_email', email_id: mId, sid_token: activeToken })
                .then(async full => {
                  const saved = {
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
                  };
                  await db.saveArchivedMessage(saved);
                  
                  // Forward immediately if enabled!
                  const curSettings = await db.getSettings();
                  if (curSettings.forwarding_enabled === 'true') {
                    forwardMessage(saved, curSettings)
                      .then(ok => { if (ok) db.markMessageAsForwarded(mId); })
                      .catch(() => {});
                  }
                })
                .catch(() => {});
            }
          }
        } catch (err) {
          console.warn('Live fetch error:', err.message);
        }

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
