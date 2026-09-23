module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

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
    const body = await getBody();

    const domainRes = await fetch('https://api.mail.tm/domains', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const domainsData = await domainRes.json();
    const available = (domainsData['hydra:member'] || []).filter(d => d.isActive);
    if (!available.length) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'No domains available' }));
    }

    const domain = body.domain && available.some(d => d.domain === body.domain)
      ? body.domain
      : available[0].domain;

    let username = body.username ? body.username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') : '';
    if (!username) username = 'mail_' + Math.random().toString(36).substring(2, 9);

    const email = `${username}@${domain}`;
    const password = body.password || ('Pass_' + Math.random().toString(36).substring(2, 10) + '!9');

    const createRes = await fetch('https://api.mail.tm/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ address: email, password })
    });
    const createData = await createRes.json();
    if (!createRes.ok) throw new Error(createData.message || createData['hydra:description'] || 'Failed to create');

    const tokenRes = await fetch('https://api.mail.tm/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ address: email, password })
    });
    const tokenData = await tokenRes.json();

    const account = {
      id: createData.id,
      address: email,
      password: password,
      domain: domain,
      token: tokenData.token,
      createdAt: new Date().toISOString(),
      note: body.note || ''
    };

    res.statusCode = 201;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: true, account }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.message }));
  }
};
