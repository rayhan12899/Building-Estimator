'use strict';

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '20kb' }));

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.BE_LICENSE_ADMIN_TOKEN;
const PRIVATE_KEY = process.env.BE_LICENSE_PRIVATE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ADMIN_TOKEN || !PRIVATE_KEY || !DATABASE_URL) {
  throw new Error('Set DATABASE_URL, BE_LICENSE_ADMIN_TOKEN and BE_LICENSE_PRIVATE_KEY environment variables.');
}

// Neon requires TLS. Keep the connection string in Render Secrets, never in source control.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function signed(payload) {
  return {
    payload,
    signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), PRIVATE_KEY).toString('base64')
  };
}

function validDevice(req) {
  return typeof req.body.deviceId === 'string' && /^[a-f0-9-]{36}$/i.test(req.body.deviceId);
}

function isAdmin(req) {
  return req.get('authorization') === `Bearer ${ADMIN_TOKEN}`;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_devices (
      device_id TEXT PRIMARY KEY,
      trial_started_at TIMESTAMPTZ NOT NULL,
      trial_ends_at TIMESTAMPTZ NOT NULL,
      license_key TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_keys (
      license_key TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      device_id TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS license_keys_device_id_idx ON license_keys(device_id)');
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'Building Estimator License Server', database: 'connected' });
  } catch (_err) {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.post('/v1/status', async (req, res) => {
  if (!validDevice(req)) return res.status(400).json({ error: 'Invalid device.' });
  const client = await pool.connect();
  try {
    const id = req.body.deviceId;
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO license_devices(device_id, trial_started_at, trial_ends_at, license_key)
       VALUES ($1, NOW(), NOW() + INTERVAL '24 hours', NULL)
       ON CONFLICT (device_id) DO NOTHING`, [id]
    );
    const deviceResult = await client.query('SELECT * FROM license_devices WHERE device_id=$1 FOR UPDATE', [id]);
    const device = deviceResult.rows[0];

    if (device.license_key) {
      const keyResult = await client.query('SELECT * FROM license_keys WHERE license_key=$1', [device.license_key]);
      const key = keyResult.rows[0];
      if (key && key.active && (!key.expires_at || new Date(key.expires_at).getTime() > Date.now())) {
        await client.query('COMMIT');
        return res.json(signed({
          status: 'licensed', deviceId: id,
          expiresAt: key.expires_at ? new Date(key.expires_at).toISOString() : null,
          licenseKey: device.license_key
        }));
      }
    }

    await client.query('COMMIT');
    const endMs = new Date(device.trial_ends_at).getTime();
    return res.json(signed({
      status: Date.now() < endMs ? 'trial' : 'expired',
      deviceId: id,
      trialStartedAt: new Date(device.trial_started_at).toISOString(),
      trialEndsAt: new Date(device.trial_ends_at).toISOString(),
      remainingMs: Math.max(0, endMs - Date.now())
    }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('status error:', err.message);
    return res.status(500).json({ error: 'Unable to check license status.' });
  } finally {
    client.release();
  }
});

app.post('/v1/activate', async (req, res) => {
  if (!validDevice(req) || typeof req.body.key !== 'string') {
    return res.status(400).json({ error: 'Invalid activation request.' });
  }
  const id = req.body.deviceId;
  const keyText = req.body.key.trim().toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keyResult = await client.query('SELECT * FROM license_keys WHERE license_key=$1 FOR UPDATE', [keyText]);
    const lic = keyResult.rows[0];
    if (!lic || !lic.active) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Product Key is invalid or deactivated.' });
    }
    if (lic.expires_at && new Date(lic.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Product Key has expired.' });
    }
    if (lic.device_id && lic.device_id !== id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This Product Key is already activated on another computer.' });
    }

    await client.query('UPDATE license_keys SET device_id=$1 WHERE license_key=$2 AND device_id IS NULL', [id, keyText]);
    await client.query(
      `INSERT INTO license_devices(device_id, trial_started_at, trial_ends_at, license_key)
       VALUES ($1, NOW(), NOW(), $2)
       ON CONFLICT (device_id) DO UPDATE SET license_key=EXCLUDED.license_key`, [id, keyText]
    );
    await client.query('COMMIT');
    return res.json(signed({
      status: 'licensed', deviceId: id,
      expiresAt: lic.expires_at ? new Date(lic.expires_at).toISOString() : null,
      licenseKey: keyText
    }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('activation error:', err.message);
    return res.status(500).json({ error: 'Unable to activate license.' });
  } finally {
    client.release();
  }
});

app.post('/admin/keys', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const count = Math.min(100, Math.max(1, Math.floor(Number(req.body.count) || 1)));
  const expiresAt = req.body.expiresAt || null;
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    return res.status(400).json({ error: 'Expiry must be a future date in ISO format.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = [];
    for (let i = 0; i < count; i++) {
      let key;
      do {
        key = `BE25-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      } while ((await client.query('SELECT 1 FROM license_keys WHERE license_key=$1', [key])).rowCount);
      await client.query(
        'INSERT INTO license_keys(license_key, active, device_id, expires_at) VALUES ($1, TRUE, NULL, $2)',
        [key, expiresAt]
      );
      keys.push(key);
    }
    await client.query('COMMIT');
    return res.json({ keys, expiresAt });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('key generation error:', err.message);
    return res.status(500).json({ error: 'Unable to generate keys.' });
  } finally {
    client.release();
  }
});

app.post('/admin/revoke', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const key = String(req.body.key || '').trim().toUpperCase();
  try {
    const result = await pool.query('UPDATE license_keys SET active=FALSE WHERE license_key=$1', [key]);
    if (!result.rowCount) return res.status(404).json({ error: 'Key not found' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('revoke error:', err.message);
    return res.status(500).json({ error: 'Unable to revoke key.' });
  }
});

initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`License server listening on ${PORT}`)))
  .catch((err) => {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  });
