// الباك إند الخاص ببرنامج متابعة التحصيلات — يحل محل Airtable بالكامل.
// سيرفر Node.js + Express + PostgreSQL، بينشر على Render.

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const API_KEY = process.env.API_KEY || '';

// كل الطلبات لازم يبقى معاها هيدر x-api-key مطابق لمفتاح السيرفر
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.header('x-api-key');
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

function newId(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex');
}

// ---------- دوال عامة تشتغل على أي جدول شكله (id TEXT PRIMARY KEY, fields JSONB) ----------

async function listAll(table) {
  const { rows } = await pool.query(`SELECT id, fields FROM ${table} ORDER BY id`);
  return { records: rows.map(r => ({ id: r.id, fields: r.fields })) };
}

async function createOne(table, id, fields) {
  await pool.query(
    `INSERT INTO ${table} (id, fields, updated_at) VALUES ($1, $2, now())`,
    [id, fields]
  );
  return { id, fields };
}

async function updateOne(table, id, fields) {
  const { rows } = await pool.query(`SELECT fields FROM ${table} WHERE id = $1`, [id]);
  if (!rows.length) {
    const err = new Error('السجل غير موجود: ' + id);
    err.status = 404;
    throw err;
  }
  const merged = Object.assign({}, rows[0].fields, fields);
  await pool.query(`UPDATE ${table} SET fields = $1, updated_at = now() WHERE id = $2`, [merged, id]);
  return { id, fields: merged };
}

async function deleteOne(table, id) {
  await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return { id, deleted: true };
}

// ---------- الأقساط ----------

app.get('/api/installments', async (req, res) => {
  try { res.json(await listAll('installments')); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/installments', async (req, res) => {
  try {
    const id = newId('I');
    res.json(await createOne('installments', id, req.body.fields || {}));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/installments/batch', async (req, res) => {
  try {
    const records = req.body.records || [];
    const created = [];
    for (const r of records) {
      const id = newId('I');
      created.push(await createOne('installments', id, r.fields || {}));
    }
    res.json({ records: created });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.patch('/api/installments/:id', async (req, res) => {
  try { res.json(await updateOne('installments', req.params.id, req.body.fields || {})); }
  catch (err) { res.status(err.status || 500).json({ error: String(err) }); }
});

app.delete('/api/installments/:id', async (req, res) => {
  try { res.json(await deleteOne('installments', req.params.id)); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/installments/batchDelete', async (req, res) => {
  try {
    const ids = req.body.ids || [];
    for (const id of ids) await deleteOne('installments', id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ---------- المستخدمين (المعرف هو اسم المستخدم نفسه) ----------

app.get('/api/users', async (req, res) => {
  try { res.json(await listAll('users')); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/users', async (req, res) => {
  try {
    const fields = req.body.fields || {};
    const id = fields['اسم المستخدم'];
    if (!id) return res.status(400).json({ error: 'اسم المستخدم مطلوب' });
    res.json(await createOne('users', id, fields));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.patch('/api/users/:id', async (req, res) => {
  try { res.json(await updateOne('users', req.params.id, req.body.fields || {})); }
  catch (err) { res.status(err.status || 500).json({ error: String(err) }); }
});

app.delete('/api/users/:id', async (req, res) => {
  try { res.json(await deleteOne('users', req.params.id)); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// ---------- استيراد جماعي (يُستخدم مرة واحدة فقط لنقل البيانات من Airtable) ----------
app.post('/api/admin/import', async (req, res) => {
  try {
    const { table, records } = req.body;
    if (table !== 'installments' && table !== 'users') return res.status(400).json({ error: 'جدول غير معروف' });
    let count = 0;
    for (const r of records || []) {
      await pool.query(
        `INSERT INTO ${table} (id, fields, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET fields = EXCLUDED.fields, updated_at = now()`,
        [r.id, r.fields]
      );
      count++;
    }
    res.json({ ok: true, imported: count });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS installments (
      id TEXT PRIMARY KEY,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

// استيراد أولي تلقائي: لو الجداول فاضية (أول تشغيل بعد إنشاء قاعدة البيانات)، يستورد
// بيانات Airtable القديمة من ملفات data/installments.json و data/users.json المرفقة
// مع الكود. بعد أول استيراد ناجح، الجداول بقى فيها بيانات فمش هيتكرر تاني في أي إعادة تشغيل.
async function autoImportIfEmpty() {
  const fs = require('fs');
  const path = require('path');
  const installmentsPath = path.join(__dirname, 'data', 'installments.json');
  const usersPath = path.join(__dirname, 'data', 'users.json');

  const { rows: irows } = await pool.query('SELECT count(*)::int AS c FROM installments');
  if (irows[0].c === 0 && fs.existsSync(installmentsPath)) {
    const list = JSON.parse(fs.readFileSync(installmentsPath, 'utf-8'));
    for (const r of list) {
      if (!r.id) continue;
      await pool.query(
        `INSERT INTO installments (id, fields, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO NOTHING`,
        [r.id, r.fields]
      );
    }
    console.log('تم استيراد ' + list.length + ' قسط.');
  } else {
    console.log('الأقساط موجودة بالفعل، مفيش استيراد.');
  }

  const { rows: urows } = await pool.query('SELECT count(*)::int AS c FROM users');
  if (urows[0].c === 0 && fs.existsSync(usersPath)) {
    const list = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
    for (const r of list) {
      if (!r.id) continue;
      await pool.query(
        `INSERT INTO users (id, fields, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO NOTHING`,
        [r.id, r.fields]
      );
    }
    console.log('تم استيراد ' + list.length + ' مستخدم.');
  } else {
    console.log('المستخدمين موجودين بالفعل، مفيش استيراد.');
  }
}

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => autoImportIfEmpty())
  .then(() => app.listen(PORT, () => console.log('server listening on ' + PORT)))
  .catch(err => { console.error('فشل تجهيز الجداول أو الاستيراد:', err); process.exit(1); });
