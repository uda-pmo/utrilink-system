const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SECRET || !url || !serviceKey) throw new Error('JWT_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const auth = (req, res, next) => { try { req.user = jwt.verify((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), SECRET); next(); } catch { res.status(401).json({ error: '登录已失效，请重新登录。' }); } };
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, factory_name: u.factory_name || null });
const fail = (res, error, fallback = '操作失败。') => res.status(500).json({ error: error?.message || fallback });
const columns = ['product_name','contract_no','factory_name','batch_no','sku','node','due_date','quantity','formula','formula_version','pack_spec','production_date','shelf_life','expiry_date','progress','status'];
const orderRecord = body => Object.fromEntries(columns.map(column => [column, body[column] === '' ? null : (body[column] ?? (column === 'progress' ? 0 : null))]));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const isFactory = user => user.role === 'factory';
const activity = async ({ orderId, action, detail, actor, targetRole, fileId = null }) => {
  const { error } = await supabase.from('nl_activity').insert({ order_id: orderId, action, detail, actor_name: actor.name, actor_role: actor.role, target_role: targetRole, file_id: fileId });
  return error;
};
const factoryOrderIds = async factoryName => {
  const { data, error } = await supabase.from('nl_orders').select('id').eq('factory_name', factoryName);
  return { ids: new Set((data || []).map(order => order.id)), error };
};
const canAccessFile = async (user, file) => {
  if (!isFactory(user)) return { allowed: true };
  const { data, error } = await supabase.from('nl_orders').select('factory_name').eq('id', file.order_id).maybeSingle();
  return { allowed: !error && data?.factory_name === user.factory_name, error };
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role = 'brand', factory_name = '' } = req.body;
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: '请填写姓名、邮箱和至少 8 位密码。' });
  const { data: exists, error: findError } = await supabase.from('nl_users').select('id').eq('email', email.trim().toLowerCase()).maybeSingle();
  if (findError) return fail(res, findError); if (exists) return res.status(409).json({ error: '该邮箱已注册。' });
  if (!['brand', 'factory'].includes(role) || (role === 'factory' && !factory_name.trim())) return res.status(400).json({ error: '请选择账号类型；工厂账号需填写工厂名称。' });
  const { data: user, error } = await supabase.from('nl_users').insert({ name: name.trim(), email: email.trim().toLowerCase(), password_hash: await bcrypt.hash(password, 12), role, factory_name: factory_name.trim() || null }).select().single();
  if (error) return fail(res, error); res.status(201).json({ token: jwt.sign(safeUser(user), SECRET, { expiresIn: '8h' }), user: safeUser(user) });
});
app.post('/api/auth/login', async (req, res) => {
  const { data: user, error } = await supabase.from('nl_users').select('*').eq('email', (req.body.email || '').trim().toLowerCase()).maybeSingle();
  if (error) return fail(res, error); if (!user || !(await bcrypt.compare(req.body.password || '', user.password_hash))) return res.status(401).json({ error: '邮箱或密码不正确。' });
  res.json({ token: jwt.sign(safeUser(user), SECRET, { expiresIn: '8h' }), user: safeUser(user) });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));
app.get('/api/orders', auth, async (req, res) => { let query = supabase.from('nl_orders').select('*').order('updated_at', { ascending: false }); if (isFactory(req.user)) query = query.eq('factory_name', req.user.factory_name); const { data, error } = await query; if (error) return fail(res, error); res.json(data); });
app.get('/api/orders/:id', auth, async (req, res) => { const { data: order, error } = await supabase.from('nl_orders').select('*').eq('id', req.params.id).maybeSingle(); if (error) return fail(res, error); if (!order) return res.sendStatus(404); if (isFactory(req.user) && order.factory_name !== req.user.factory_name) return res.sendStatus(403); const { data: files, error: fileError } = await supabase.from('nl_files').select('id,original_name,mime_type,size,created_at,uploaded_by_name,uploaded_by_role,review_status,review_note,reviewed_by_name,reviewed_at').eq('order_id', order.id).order('id', { ascending: false }); if (fileError) return fail(res, fileError); const { data: actions, error: actionError } = await supabase.from('nl_activity').select('*').eq('order_id', order.id).order('created_at', { ascending: false }); if (actionError) return fail(res, actionError); res.json({ ...order, files, actions }); });
app.get('/api/files', auth, async (req, res) => { const { data, error } = await supabase.from('nl_files').select('id,order_id,original_name,mime_type,size,created_at,uploaded_by_name,uploaded_by_role,review_status,review_note,reviewed_by_name,reviewed_at').order('id', { ascending: false }); if (error) return fail(res, error); if (!isFactory(req.user)) return res.json(data); const { ids, error: orderError } = await factoryOrderIds(req.user.factory_name); if (orderError) return fail(res, orderError); res.json(data.filter(file => ids.has(file.order_id))); });
app.get('/api/activity', auth, async (req, res) => { const { data, error } = await supabase.from('nl_activity').select('*').order('created_at', { ascending: false }).limit(40); if (error) return fail(res, error); if (!isFactory(req.user)) return res.json(data.filter(item => !item.target_role || item.target_role === req.user.role || item.actor_role === req.user.role)); const { ids, error: orderError } = await factoryOrderIds(req.user.factory_name); if (orderError) return fail(res, orderError); res.json(data.filter(item => ids.has(item.order_id) && (!item.target_role || item.target_role === req.user.role || item.actor_role === req.user.role))); });
app.post('/api/orders', auth, async (req, res) => { const record = orderRecord(req.body); if (!record.product_name || !record.factory_name) return res.status(400).json({ error: '产品名称和工厂名称为必填项。' }); const { data, error } = await supabase.from('nl_orders').insert(record).select().single(); if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? '合同号已存在。' : error.message }); res.status(201).json(data); });
app.put('/api/orders/:id', auth, async (req, res) => { const record = orderRecord(req.body); if (!record.product_name || !record.factory_name) return res.status(400).json({ error: '产品名称和工厂名称为必填项。' }); if (isFactory(req.user) && record.factory_name !== req.user.factory_name) return res.sendStatus(403); record.updated_at = new Date().toISOString(); const { data, error } = await supabase.from('nl_orders').update(record).eq('id', req.params.id).select().maybeSingle(); if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? '合同号已存在。' : error.message }); if (!data) return res.sendStatus(404); if (isFactory(req.user)) await activity({ orderId: data.id, action: '更新订单资料', detail: '工厂更新了报价、配方或生产信息', actor: req.user, targetRole: 'brand' }); res.json(data); });
app.post('/api/orders/:id/files', auth, upload.single('file'), async (req, res) => { if (!req.file) return res.status(400).json({ error: '请选择文件。' }); const { data: order, error: orderError } = await supabase.from('nl_orders').select('id,factory_name').eq('id', req.params.id).maybeSingle(); if (orderError) return fail(res, orderError); if (!order) return res.sendStatus(404); if (isFactory(req.user) && order.factory_name !== req.user.factory_name) return res.sendStatus(403); const storagePath = `${order.id}/${crypto.randomUUID()}${path.extname(req.file.originalname)}`; const { error: uploadError } = await supabase.storage.from('nutrilink-files').upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false }); if (uploadError) return fail(res, uploadError); const { data, error } = await supabase.from('nl_files').insert({ order_id: order.id, original_name: req.file.originalname, storage_path: storagePath, mime_type: req.file.mimetype, size: req.file.size, uploaded_by_name: req.user.name, uploaded_by_role: req.user.role, review_status: isFactory(req.user) ? '待审批' : '已确认' }).select('id,original_name,mime_type,size,created_at,uploaded_by_name,uploaded_by_role,review_status').single(); if (error) { await supabase.storage.from('nutrilink-files').remove([storagePath]); return fail(res, error); } if (isFactory(req.user)) await activity({ orderId: order.id, action: '上传文件', detail: req.file.originalname, actor: req.user, targetRole: 'brand', fileId: data.id }); res.status(201).json(data); });
app.post('/api/files/:id/review', auth, async (req, res) => { if (isFactory(req.user)) return res.sendStatus(403); const decision = req.body.decision, note = String(req.body.note || '').trim(); if (!['确认', '驳回'].includes(decision) || (decision === '驳回' && !note)) return res.status(400).json({ error: '驳回时必须填写原因。' }); const { data: file, error: findError } = await supabase.from('nl_files').select('*').eq('id', req.params.id).maybeSingle(); if (findError) return fail(res, findError); if (!file) return res.sendStatus(404); const { data, error } = await supabase.from('nl_files').update({ review_status: decision === '确认' ? '已确认' : '已驳回', review_note: note || null, reviewed_by_name: req.user.name, reviewed_at: new Date().toISOString() }).eq('id', file.id).select().single(); if (error) return fail(res, error); await activity({ orderId: file.order_id, action: `文件${decision}`, detail: note || file.original_name, actor: req.user, targetRole: 'factory', fileId: file.id }); res.json(data); });
app.get('/api/files/:id', auth, async (req, res) => { const { data: file, error } = await supabase.from('nl_files').select('*').eq('id', req.params.id).maybeSingle(); if (error) return fail(res, error); if (!file) return res.sendStatus(404); const { allowed, error: accessError } = await canAccessFile(req.user, file); if (accessError) return fail(res, accessError); if (!allowed) return res.sendStatus(403); const { data, error: downloadError } = await supabase.storage.from('nutrilink-files').download(file.storage_path); if (downloadError) return fail(res, downloadError); res.type(file.mime_type || 'application/octet-stream').send(Buffer.from(await data.arrayBuffer())); });
app.delete('/api/files/:id', auth, async (req, res) => { const { data: file, error } = await supabase.from('nl_files').select('*').eq('id', req.params.id).maybeSingle(); if (error) return fail(res, error); if (!file) return res.sendStatus(404); const { allowed, error: accessError } = await canAccessFile(req.user, file); if (accessError) return fail(res, accessError); if (!allowed || (isFactory(req.user) && file.uploaded_by_name !== req.user.name)) return res.sendStatus(403); const { error: storageError } = await supabase.storage.from('nutrilink-files').remove([file.storage_path]); if (storageError) return fail(res, storageError); const { error: deleteError } = await supabase.from('nl_files').delete().eq('id', file.id); if (deleteError) return fail(res, deleteError); res.sendStatus(204); });
app.listen(PORT, () => console.log(`NutriLink running on ${PORT}`));
