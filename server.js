const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-this-secret-before-production';
const root = __dirname;
const dataDir = process.env.DATA_DIR || root;
fs.mkdirSync(dataDir, { recursive: true });
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'nutrilink.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'brand', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, contract_no TEXT UNIQUE NOT NULL, factory_name TEXT NOT NULL, batch_no TEXT, sku TEXT NOT NULL, node TEXT, due_date TEXT, quantity TEXT, formula TEXT, formula_version TEXT, pack_spec TEXT, production_date TEXT, shelf_life TEXT, expiry_date TEXT, progress INTEGER DEFAULT 0, status TEXT DEFAULT '待确认', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT, size INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(order_id) REFERENCES orders(id));`);

app.use(express.json());
app.use(express.static(path.join(root, 'public')));
const auth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.user = jwt.verify(token, SECRET); next(); } catch { res.status(401).json({ error: '登录已失效，请重新登录。' }); }
};
const safeUser = user => ({ id: user.id, name: user.name, email: user.email, role: user.role });
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: '请填写姓名、邮箱和至少 8 位密码。' });
  try { const result = db.prepare('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)').run(name.trim(), email.trim().toLowerCase(), await bcrypt.hash(password, 12)); const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid); res.status(201).json({ token: jwt.sign(safeUser(user), SECRET, { expiresIn: '8h' }), user: safeUser(user) }); } catch { res.status(409).json({ error: '该邮箱已注册。' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email=?').get((req.body.email || '').trim().toLowerCase());
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password_hash))) return res.status(401).json({ error: '邮箱或密码不正确。' });
  res.json({ token: jwt.sign(safeUser(user), SECRET, { expiresIn: '8h' }), user: safeUser(user) });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));
app.get('/api/orders', auth, (req, res) => res.json(db.prepare('SELECT * FROM orders ORDER BY updated_at DESC, id DESC').all()));
app.get('/api/orders/:id', auth, (req, res) => { const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if (!order) return res.sendStatus(404); order.files = db.prepare('SELECT id,original_name,mime_type,size,created_at FROM files WHERE order_id=? ORDER BY id DESC').all(order.id); res.json(order); });
const columns = ['contract_no','factory_name','batch_no','sku','node','due_date','quantity','formula','formula_version','pack_spec','production_date','shelf_life','expiry_date','progress','status'];
app.post('/api/orders', auth, (req, res) => { const data = columns.map(c => req.body[c] ?? (c === 'progress' ? 0 : '')); if (!data[0] || !data[1] || !data[3]) return res.status(400).json({ error: '合同号、工厂名称和 SKU 为必填项。' }); try { const stmt = db.prepare(`INSERT INTO orders (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`); const result = stmt.run(...data); res.status(201).json(db.prepare('SELECT * FROM orders WHERE id=?').get(result.lastInsertRowid)); } catch { res.status(409).json({ error: '合同号已存在。' }); } });
app.put('/api/orders/:id', auth, (req, res) => { const existing = db.prepare('SELECT id FROM orders WHERE id=?').get(req.params.id); if (!existing) return res.sendStatus(404); const data = columns.map(c => req.body[c] ?? ''); if (!data[0] || !data[1] || !data[3]) return res.status(400).json({ error: '合同号、工厂名称和 SKU 为必填项。' }); try { db.prepare(`UPDATE orders SET ${columns.map(c => `${c}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...data, req.params.id); res.json(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id)); } catch { res.status(409).json({ error: '合同号已存在。' }); } });
const storage = multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`) });
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/orders/:id/files', auth, upload.single('file'), (req, res) => { if (!req.file) return res.status(400).json({ error: '请选择文件。' }); const order = db.prepare('SELECT id FROM orders WHERE id=?').get(req.params.id); if (!order) { fs.unlinkSync(req.file.path); return res.sendStatus(404); } const result = db.prepare('INSERT INTO files (order_id,original_name,stored_name,mime_type,size) VALUES (?,?,?,?,?)').run(order.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size); res.status(201).json(db.prepare('SELECT id,original_name,mime_type,size,created_at FROM files WHERE id=?').get(result.lastInsertRowid)); });
app.get('/api/files/:id', auth, (req, res) => { const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id); if (!file) return res.sendStatus(404); res.type(file.mime_type || 'application/octet-stream').sendFile(path.join(uploadDir, file.stored_name)); });
app.delete('/api/files/:id', auth, (req, res) => { const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id); if (!file) return res.sendStatus(404); db.prepare('DELETE FROM files WHERE id=?').run(file.id); fs.rmSync(path.join(uploadDir, file.stored_name), { force: true }); res.sendStatus(204); });
app.listen(PORT, () => console.log(`NutriLink running at http://localhost:${PORT}`));
