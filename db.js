const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Try loading local .env.local if present
try {
  const envPath = path.join(__dirname, '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const k = trimmed.slice(0, idx).trim();
        let v = trimmed.slice(idx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
} catch (e) {}

const rawConn = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
let pool = null;

if (rawConn) {
  try {
    const parsed = new URL(rawConn);
    pool = new Pool({
      host: parsed.hostname,
      port: parseInt(parsed.port || '5432', 10),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ''),
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000
    });
  } catch (err) {
    console.warn('Failed to parse Postgres URL:', err.message);
  }
}

// Auto-migrate tables
let isInitialized = false;
async function initDb() {
  if (isInitialized || !pool) return;
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS mail_accounts (
          id VARCHAR(255) PRIMARY KEY,
          username VARCHAR(255) NOT NULL,
          domain VARCHAR(255) NOT NULL,
          address VARCHAR(255) UNIQUE NOT NULL,
          token TEXT,
          provider VARCHAR(50) DEFAULT 'guerrilla',
          note TEXT,
          is_permanent BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS mail_messages (
          id VARCHAR(255) PRIMARY KEY,
          account_id VARCHAR(255),
          account_address VARCHAR(255) NOT NULL,
          sender VARCHAR(255),
          subject TEXT,
          intro TEXT,
          body_text TEXT,
          body_html TEXT,
          otp VARCHAR(50),
          is_seen BOOLEAN DEFAULT FALSE,
          received_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Seed initial user account if empty
      const countRes = await client.query('SELECT COUNT(*) FROM mail_accounts');
      if (parseInt(countRes.rows[0].count, 10) === 0) {
        await client.query(`
          INSERT INTO mail_accounts (id, username, domain, address, token, provider, note, is_permanent)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (address) DO NOTHING;
        `, [
          'acc_bsh26m8',
          'mail_bsh26m8',
          'sharklasers.com',
          'mail_bsh26m8@sharklasers.com',
          '6o26h622pubbur5j9todms38ds',
          'guerrilla',
          'حساب فيسبوك (دائم)',
          true
        ]);
      }

      isInitialized = true;
      console.log('✓ PostgreSQL Database initialized and ready');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('PostgreSQL initialization warning:', err.message);
  }
}

// Fallback JSON File setup
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

function localLoad(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return [];
  }
}

function localSave(filePath, data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

async function getAccounts() {
  await initDb();
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM mail_accounts ORDER BY created_at DESC');
      if (res.rows && res.rows.length > 0) {
        return res.rows.map(row => ({
          id: row.id,
          username: row.username,
          domain: row.domain,
          address: row.address,
          token: row.token,
          provider: row.provider,
          note: row.note,
          isPermanent: row.is_permanent,
          createdAt: row.created_at
        }));
      }
    } catch (e) {
      console.warn('DB getAccounts failed, using local/vault fallback:', e.message);
    }
  }

  // Fallback to local
  const accounts = localLoad(ACCOUNTS_FILE);
  if (accounts.length === 0) {
    return [{
      id: 'acc_bsh26m8',
      username: 'mail_bsh26m8',
      domain: 'sharklasers.com',
      address: 'mail_bsh26m8@sharklasers.com',
      token: '6o26h622pubbur5j9todms38ds',
      provider: 'guerrilla',
      note: 'حساب فيسبوك (دائم)',
      isPermanent: true,
      createdAt: new Date().toISOString()
    }];
  }
  return accounts;
}

async function saveAccount(acc) {
  await initDb();
  if (pool) {
    try {
      await pool.query(`
        INSERT INTO mail_accounts (id, username, domain, address, token, provider, note, is_permanent, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (address) DO UPDATE SET
          token = EXCLUDED.token,
          note = EXCLUDED.note,
          is_permanent = EXCLUDED.is_permanent,
          updated_at = NOW();
      `, [
        acc.id,
        acc.username || acc.address.split('@')[0],
        acc.domain || acc.address.split('@')[1],
        acc.address,
        acc.token || '',
        acc.provider || 'guerrilla',
        acc.note || '',
        acc.isPermanent !== false
      ]);
    } catch (e) {
      console.warn('DB saveAccount failed:', e.message);
    }
  }

  const list = localLoad(ACCOUNTS_FILE).filter(a => a.address !== acc.address);
  list.unshift(acc);
  localSave(ACCOUNTS_FILE, list);
}

async function deleteAccount(id) {
  await initDb();
  if (pool) {
    try {
      await pool.query('DELETE FROM mail_accounts WHERE id = $1 OR address = $1', [id]);
      await pool.query('DELETE FROM mail_messages WHERE account_id = $1 OR account_address = $1', [id]);
    } catch (e) {
      console.warn('DB deleteAccount failed:', e.message);
    }
  }

  const list = localLoad(ACCOUNTS_FILE).filter(a => a.id !== id && a.address !== id);
  localSave(ACCOUNTS_FILE, list);
}

async function getArchivedMessages(accountAddress) {
  await initDb();
  if (pool) {
    try {
      const res = await pool.query(
        'SELECT * FROM mail_messages WHERE account_address = $1 ORDER BY received_at DESC',
        [accountAddress]
      );
      return res.rows.map(row => ({
        id: row.id,
        accountId: row.account_id,
        accountAddress: row.account_address,
        from: row.sender,
        subject: row.subject,
        intro: row.intro,
        text: row.body_text,
        html: row.body_html,
        otp: row.otp,
        seen: row.is_seen,
        createdAt: row.received_at
      }));
    } catch (e) {
      console.warn('DB getArchivedMessages failed:', e.message);
    }
  }

  const allMessages = localLoad(MESSAGES_FILE);
  return allMessages.filter(m => m.accountAddress === accountAddress);
}

async function saveArchivedMessage(msg) {
  await initDb();
  if (pool) {
    try {
      await pool.query(`
        INSERT INTO mail_messages (id, account_id, account_address, sender, subject, intro, body_text, body_html, otp, is_seen, received_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          otp = COALESCE(EXCLUDED.otp, mail_messages.otp),
          body_text = COALESCE(EXCLUDED.body_text, mail_messages.body_text),
          body_html = COALESCE(EXCLUDED.body_html, mail_messages.body_html),
          is_seen = EXCLUDED.is_seen;
      `, [
        String(msg.id),
        msg.accountId || '',
        msg.accountAddress,
        typeof msg.from === 'object' ? (msg.from?.address || msg.from?.name || 'Unknown') : (msg.from || 'Unknown'),
        msg.subject || '(بدون عنوان)',
        msg.intro || '',
        msg.text || '',
        msg.html || null,
        msg.otp || null,
        msg.seen || false,
        msg.createdAt || new Date().toISOString()
      ]);
    } catch (e) {
      console.warn('DB saveArchivedMessage failed:', e.message);
    }
  }

  const all = localLoad(MESSAGES_FILE);
  const existingIdx = all.findIndex(m => m.id === String(msg.id));
  if (existingIdx !== -1) {
    all[existingIdx] = { ...all[existingIdx], ...msg };
  } else {
    all.unshift(msg);
  }
  localSave(MESSAGES_FILE, all);
}

async function getArchivedMessageDetails(msgId) {
  await initDb();
  if (pool) {
    try {
      const res = await pool.query('SELECT * FROM mail_messages WHERE id = $1', [String(msgId)]);
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          id: row.id,
          accountId: row.account_id,
          accountAddress: row.account_address,
          from: { name: row.sender, address: row.sender },
          to: [{ address: row.account_address }],
          subject: row.subject,
          intro: row.intro,
          text: row.body_text,
          html: row.body_html,
          otp: row.otp,
          seen: true,
          createdAt: row.received_at
        };
      }
    } catch (e) {
      console.warn('DB getArchivedMessageDetails failed:', e.message);
    }
  }

  const all = localLoad(MESSAGES_FILE);
  const found = all.find(m => String(m.id) === String(msgId));
  if (found) {
    return {
      id: found.id,
      accountId: found.accountId,
      accountAddress: found.accountAddress,
      from: typeof found.from === 'object' ? found.from : { name: found.from, address: found.from },
      to: [{ address: found.accountAddress }],
      subject: found.subject,
      intro: found.intro,
      text: found.text,
      html: found.html,
      otp: found.otp,
      seen: true,
      createdAt: found.createdAt
    };
  }
  return null;
}

module.exports = {
  initDb,
  getAccounts,
  saveAccount,
  deleteAccount,
  getArchivedMessages,
  saveArchivedMessage,
  getArchivedMessageDetails
};
