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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const token = req.headers['authorization'] || (parsedUrl.searchParams.get('token') ? `Bearer ${parsedUrl.searchParams.get('token')}` : null);
  
  if (!token) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Token required' }));
  }

  const msgId = parsedUrl.searchParams.get('msgId');

  try {
    if (msgId) {
      const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, {
        headers: { 'Authorization': token, 'User-Agent': 'Mozilla/5.0' }
      });
      const msg = await msgRes.json();
      if (!msgRes.ok) throw new Error(msg.message || 'Error fetching message');

      const bodyText = (msg.text || '') + ' ' + (msg.subject || '');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({
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
      }));
    }

    const listRes = await fetch('https://api.mail.tm/messages', {
      headers: { 'Authorization': token, 'User-Agent': 'Mozilla/5.0' }
    });
    const listData = await listRes.json();
    if (!listRes.ok) throw new Error(listData.message || 'Error fetching messages');

    const raw = listData['hydra:member'] || [];
    const messages = raw.map(m => ({
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

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ total: listData['hydra:totalItems'] || messages.length, messages }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.message }));
  }
};
