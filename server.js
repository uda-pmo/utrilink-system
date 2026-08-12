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
const resendApiKey = process.env.RESEND_API_KEY;
const reminderEmailFrom = process.env.REMINDER_EMAIL_FROM;
if (!SECRET || !url || !serviceKey) throw new Error('JWT_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const auth = (req, res, next) => { try { req.user = jwt.verify((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), SECRET); next(); } catch { res.status(401).json({ error: '登录已失效，请重新登录。' }); } };
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, factory_name: u.factory_name || null });
const fail = (res, error, fallback = '操作失败。') => res.status(500).json({ error: error?.message || fallback });
const columns = ['product_name','contract_no','factory_name','batch_no','sku','node','due_date','quantity','formula','formula_version','pack_spec','production_date','shelf_life','expiry_date','progress','status'];
const orderRecord = body => Object.fromEntries(columns.map(column => [column, body[column] === '' ? null : (body[column] ?? (column === 'progress' ? 0 : null))]));
const productInfoFields = ['formula', 'formula_version', 'pack_spec', 'shelf_life'];
const productInfoLabels = { formula: '完整配方', formula_version: '配方版本', pack_spec: '包装规格', shelf_life: '保质期要求' };
const displayValue = value => value === null || value === undefined || value === '' ? '未填写' : String(value).slice(0, 180);
const changedFields = (before, after, fields) => fields.filter(field => String(before[field] ?? '') !== String(after[field] ?? '')).map(field => `${productInfoLabels[field] || field}：${displayValue(before[field])} -> ${displayValue(after[field])}`);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const isFactory = user => user.role === 'factory';
const normalizeFilename = value => {
  const filename = String(value || '未命名文件');
  if (/[\u3400-\u9fff]/.test(filename)) return filename;
  try {
    const decoded = Buffer.from(filename, 'latin1').toString('utf8');
    return /[\u3400-\u9fff]/.test(decoded) && !decoded.includes('\uFFFD') ? decoded : filename;
  } catch { return filename; }
};
const publicFile = file => ({ ...file, original_name: normalizeFilename(file.original_name) });
const visibleContact = (contact, currentUser) => contact.email && contact.email !== currentUser.email && contact.name !== '系统维护' && !contact.email.endsWith('@nutrilink.local');
const reminderContacts = async (user, order) => {
  let query = supabase.from('nl_users').select('id,name,email,role,factory_name').order('name');
  query = isFactory(user) ? query.eq('role', 'brand') : query.eq('role', 'factory').eq('factory_name', order.factory_name);
  const { data, error } = await query;
  return { contacts: (data || []).filter(contact => visibleContact(contact, user)), error };
};
const sendReminderEmail = async ({ recipients, subject, text }) => {
  if (!resendApiKey || !reminderEmailFrom) return { sent: false, reason: '邮件服务尚未配置' };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: reminderEmailFrom, to: recipients, subject, text })
    });
    if (!response.ok) return { sent: false, reason: '邮件服务返回发送失败' };
    return { sent: true };
  } catch {
    return { sent: false, reason: '邮件服务暂时不可用' };
  }
};
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
const canAccessOrder = (user, order) => !isFactory(user) || order.factory_name === user.factory_name;
const getOrder = async id => supabase.from('nl_orders').select('*').eq('id', id).maybeSingle();
const notify = async ({ orderId, kind = '系统消息', title, detail = '', targetRole, actor }) => {
  const { error } = await supabase.from('nl_notifications').insert({ order_id: orderId, kind, title, detail, target_role: targetRole, created_by_name: actor.name, created_by_role: actor.role });
  return error;
};
const milestoneFields = ['node_key', 'node_name', 'sequence', 'plan_date', 'actual_date', 'status', 'delay_reason'];
const defaultMilestones = [
  ['formula_confirmed', '配方确认'], ['packaging_confirmed', '包材确认'], ['contract_confirmed', '合同确认'],
  ['raw_material_purchase', '原料启动采购'], ['raw_material_received', '原料进厂验收'], ['sampling', '打样'],
  ['production', '正式投产'], ['semi_finished_test', '半成品检验'], ['finished_production', '成品生产完成'],
  ['outer_packaging', '外包装完工'], ['sample_sent', '样板寄出（可选）'], ['shipment', '货物安排出货']
];
const ensureMilestones = async orderId => {
  const { data: existing, error } = await supabase.from('nl_milestones').select('id').eq('order_id', orderId).limit(1);
  if (error || existing?.length) return error;
  const { error: insertError } = await supabase.from('nl_milestones').insert(defaultMilestones.map(([node_key, node_name], sequence) => ({ order_id: orderId, node_key, node_name, sequence: sequence + 1 })));
  return insertError;
};
const orderAccess = async (req, res, id) => {
  const { data: order, error } = await getOrder(id);
  if (error) { fail(res, error); return null; }
  if (!order) { res.sendStatus(404); return null; }
  if (!canAccessOrder(req.user, order)) { res.sendStatus(403); return null; }
  return order;
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
app.get('/api/orders/:id', auth, async (req, res) => {
  const order = await orderAccess(req, res, req.params.id); if (!order) return;
  await ensureMilestones(order.id);
  const [filesResult, actionsResult, milestonesResult, commentsResult] = await Promise.all([
    supabase.from('nl_files').select('id,original_name,document_type,mime_type,size,created_at,uploaded_by_name,uploaded_by_role,review_status,review_note,reviewed_by_name,reviewed_at,review_due_date,review_transfer_to,review_reason_tag').eq('order_id', order.id).order('id', { ascending: false }),
    supabase.from('nl_activity').select('*').eq('order_id', order.id).order('created_at', { ascending: false }),
    supabase.from('nl_milestones').select('*').eq('order_id', order.id).order('sequence'),
    supabase.from('nl_comments').select('*').eq('order_id', order.id).order('created_at', { ascending: false })
  ]);
  const error = filesResult.error || actionsResult.error || milestonesResult.error || commentsResult.error;
  if (error) return fail(res, error);
  res.json({ ...order, files: filesResult.data.map(publicFile), actions: actionsResult.data, milestones: milestonesResult.data, comments: commentsResult.data });
});
app.get('/api/orders/:id/contacts', auth, async (req, res) => {
  const order = await orderAccess(req, res, req.params.id); if (!order) return;
  const { contacts, error } = await reminderContacts(req.user, order);
  if (error) return fail(res, error);
  res.json(contacts);
});
app.get('/api/files', auth, async (req, res) => { const { data, error } = await supabase.from('nl_files').select('id,order_id,original_name,document_type,mime_type,size,created_at,uploaded_by_name,uploaded_by_role,review_status,review_note,reviewed_by_name,reviewed_at').order('id', { ascending: false }); if (error) return fail(res, error); if (!isFactory(req.user)) return res.json(data.map(publicFile)); const { ids, error: orderError } = await factoryOrderIds(req.user.factory_name); if (orderError) return fail(res, orderError); res.json(data.filter(file => ids.has(file.order_id)).map(publicFile)); });
app.get('/api/activity', auth, async (req, res) => { const { data, error } = await supabase.from('nl_activity').select('*').order('created_at', { ascending: false }).limit(80); if (error) return fail(res, error); if (!isFactory(req.user)) return res.json(data.filter(item => !item.target_role || item.target_role === req.user.role || item.actor_role === req.user.role)); const { ids, error: orderError } = await factoryOrderIds(req.user.factory_name); if (orderError) return fail(res, orderError); res.json(data.filter(item => ids.has(item.order_id) && (!item.target_role || item.target_role === req.user.role || item.actor_role === req.user.role))); });
app.get('/api/notifications', auth, async (req, res) => { let query = supabase.from('nl_notifications').select('*').order('created_at', { ascending: false }).limit(100); const { data, error } = await query; if (error) return fail(res, error); if (!isFactory(req.user)) return res.json(data.filter(item => !item.target_role || item.target_role === req.user.role)); const { ids, error: orderError } = await factoryOrderIds(req.user.factory_name); if (orderError) return fail(res, orderError); res.json(data.filter(item => ids.has(item.order_id) && (!item.target_role || item.target_role === 'factory'))); });
app.post('/api/notifications/:id/read', auth, async (req, res) => { const { data, error } = await supabase.from('nl_notifications').update({ read_at: new Date().toISOString(), read_by_name: req.user.name }).eq('id', req.params.id).select().maybeSingle(); if (error) return fail(res, error); if (!data) return res.sendStatus(404); res.json(data); });
app.delete('/api/activity/:id', auth, async (req, res) => {
  if (isFactory(req.user)) return res.status(403).json({ error: '仅品牌方管理员可以删除系统记录。' });
  const { data: entry, error: findError } = await supabase.from('nl_activity').select('id,order_id').eq('id', req.params.id).maybeSingle();
  if (findError) return fail(res, findError); if (!entry) return res.sendStatus(404);
  const order = await orderAccess(req, res, entry.order_id); if (!order) return;
  const { error } = await supabase.from('nl_activity').delete().eq('id', entry.id);
  if (error) return fail(res, error); res.sendStatus(204);
});
app.post('/api/orders', auth, async (req, res) => { if (isFactory(req.user)) return res.sendStatus(403); const record = orderRecord(req.body); if (!record.product_name || !record.factory_name) return res.status(400).json({ error: '产品名称和工厂名称为必填项。' }); const { data, error } = await supabase.from('nl_orders').insert(record).select().single(); if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? '合同号已存在。' : error.message }); const milestoneError = await ensureMilestones(data.id); if (milestoneError) return fail(res, milestoneError); await activity({ orderId: data.id, action: '创建订单', detail: `${data.product_name} · 已建立里程碑计划`, actor: req.user, targetRole: 'brand' }); res.status(201).json(data); });
app.put('/api/orders/:id', auth, async (req, res) => { const current = await orderAccess(req, res, req.params.id); if (!current) return; const record = orderRecord(req.body); if (!record.product_name || !record.factory_name) return res.status(400).json({ error: '产品名称和工厂名称为必填项。' }); if (isFactory(req.user)) return res.status(403).json({ error: '工厂请通过产品与配方信息模块提交修改。' }); record.updated_at = new Date().toISOString(); const { data, error } = await supabase.from('nl_orders').update(record).eq('id', req.params.id).select().maybeSingle(); if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? '合同号已存在。' : error.message }); if (!data) return res.sendStatus(404); const changes = changedFields(current, data, productInfoFields); if (changes.length) await activity({ orderId: data.id, action: '更新产品与配方信息', detail: changes.join('；'), actor: req.user, targetRole: 'factory' }); res.json(data); });
app.patch('/api/orders/:id/product-info', auth, async (req, res) => {
  const order = await orderAccess(req, res, req.params.id); if (!order) return;
  const payload = Object.fromEntries(productInfoFields.filter(field => req.body[field] !== undefined).map(field => [field, req.body[field] === '' ? null : req.body[field]]));
  if (!Object.keys(payload).length) return res.status(400).json({ error: '没有可更新的产品或配方信息。' });
  payload.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('nl_orders').update(payload).eq('id', order.id).select().single();
  if (error) return fail(res, error);
  const changes = changedFields(order, data, productInfoFields);
  if (changes.length) await activity({ orderId: order.id, action: isFactory(req.user) ? '工厂修改产品与配方信息' : '更新产品与配方信息', detail: changes.join('；'), actor: req.user, targetRole: isFactory(req.user) ? 'brand' : 'factory' });
  res.json(data);
});
app.post('/api/orders/:id/files', auth, upload.single('file'), async (req, res) => { if (!req.file) return res.status(400).json({ error: '请选择文件。' }); const { data: order, error: orderError } = await supabase.from('nl_orders').select('id,factory_name').eq('id', req.params.id).maybeSingle(); if (orderError) return fail(res, orderError); if (!order) return res.sendStatus(404); if (isFactory(req.user) && order.factory_name !== req.user.factory_name) return res.sendStatus(403); const documentType = String(req.body.document_type || 'other').trim().slice(0, 80) || 'other'; const originalName = normalizeFilename(req.file.originalname); const storagePath = `${order.id}/${crypto.randomUUID()}${path.extname(originalName)}`; const { error: uploadError } = await supabase.storage.from('nutrilink-files').upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false }); if (uploadError) return fail(res, uploadError); const { data, error } = await supabase.from('nl_files').insert({ order_id: order.id, original_name: originalName, document_type: documentType, storage_path: storagePath, mime_type: req.file.mimetype, size: req.file.size, uploaded_by_name: req.user.name, uploaded_by_role: req.user.role, review_status: isFactory(req.user) ? '待审批' : '已确认' }).select('id,original_name,document_type,mime_type,size,created_at,uploaded_by_name,uploaded_by_role,review_status').single(); if (error) { await supabase.storage.from('nutrilink-files').remove([storagePath]); return fail(res, error); } await activity({ orderId: order.id, action: '提交关联文件', detail: originalName, actor: req.user, targetRole: isFactory(req.user) ? 'brand' : 'factory', fileId: data.id }); if (isFactory(req.user)) await notify({ orderId: order.id, kind: '文件提交', title: `${req.user.name} 在“订单全部文档”上传了文件`, detail: originalName, targetRole: 'brand', actor: req.user }); res.status(201).json(publicFile(data)); });
app.post('/api/files/:id/review', auth, async (req, res) => {
  if (isFactory(req.user)) return res.sendStatus(403);
  const decision = req.body.decision, note = String(req.body.note || '').trim(), reasonTag = String(req.body.reason_tag || '').trim(), dueDate = req.body.due_date || null, transferTo = String(req.body.transfer_to || '').trim() || null;
  const decisionMap = { '确认': '已确认', '驳回': '已驳回', '需修改后重提': '需修改后重提', '有条件通过': '有条件通过', '转交同事审批': '转交同事审批' };
  if (!decisionMap[decision] || (['驳回', '需修改后重提'].includes(decision) && !note)) return res.status(400).json({ error: '该审批结果必须填写处理说明。' });
  const { data: file, error: findError } = await supabase.from('nl_files').select('*').eq('id', req.params.id).maybeSingle();
  if (findError) return fail(res, findError); if (!file) return res.sendStatus(404);
  const { data, error } = await supabase.from('nl_files').update({ review_status: decisionMap[decision], review_note: note || null, review_reason_tag: reasonTag || null, review_due_date: dueDate, review_transfer_to: transferTo, reviewed_by_name: req.user.name, reviewed_at: new Date().toISOString() }).eq('id', file.id).select().single();
  if (error) return fail(res, error);
  const targetRole = decision === '转交同事审批' ? 'brand' : 'factory';
  await activity({ orderId: file.order_id, action: `文件${decision}`, detail: [reasonTag, note, dueDate ? `截止 ${dueDate}` : '', transferTo ? `转交 ${transferTo}` : ''].filter(Boolean).join(' · ') || file.original_name, actor: req.user, targetRole, fileId: file.id });
  await notify({ orderId: file.order_id, kind: '审批结果', title: `${req.user.name} 在“订单全部文档”${decision}`, detail: `${normalizeFilename(file.original_name)}${note ? `：${note}` : ''}`, targetRole, actor: req.user });
  res.json(data);
});
app.get('/api/orders/:id/milestones', auth, async (req, res) => { const order = await orderAccess(req, res, req.params.id); if (!order) return; const ensureError = await ensureMilestones(order.id); if (ensureError) return fail(res, ensureError); const { data, error } = await supabase.from('nl_milestones').select('*').eq('order_id', order.id).order('sequence'); if (error) return fail(res, error); res.json(data); });
app.put('/api/orders/:id/milestones/:milestoneId', auth, async (req, res) => {
  const order = await orderAccess(req, res, req.params.id); if (!order) return;
  const payload = Object.fromEntries(milestoneFields.filter(key => req.body[key] !== undefined).map(key => [key, req.body[key] === '' ? null : req.body[key]]));
  const finalize = req.body.finalize === true;
  if (isFactory(req.user)) delete payload.plan_date;
  if (finalize) {
    payload.status = '已完成';
    payload.actual_date = payload.actual_date || new Date().toISOString().slice(0, 10);
  }
  const { data: milestone, error } = await supabase.from('nl_milestones').update(payload).eq('id', req.params.milestoneId).eq('order_id', order.id).select().maybeSingle();
  if (error) return fail(res, error); if (!milestone) return res.sendStatus(404);
  const complete = milestone.status === '已完成' || milestone.actual_date;
  const { data: next } = await supabase.from('nl_milestones').select('*').eq('order_id', order.id).order('sequence');
  const current = (next || []).find(item => !(item.status === '已完成' || item.actual_date)) || milestone;
  const completed = (next || []).filter(item => item.status === '已完成' || item.actual_date).length;
  await supabase.from('nl_orders').update({ node: current.node_name, progress: Math.round(completed / Math.max((next || []).length, 1) * 100), updated_at: new Date().toISOString() }).eq('id', order.id);
  if (finalize) {
    await activity({ orderId: order.id, action: `确认完成里程碑：${milestone.node_name}`, detail: `${milestone.status} · 实际 ${milestone.actual_date}`, actor: req.user, targetRole: isFactory(req.user) ? 'brand' : 'factory' });
    await notify({ orderId: order.id, kind: '里程碑确认', title: `${req.user.name} 确认完成“${milestone.node_name}”`, detail: `实际完成日期：${milestone.actual_date}`, targetRole: isFactory(req.user) ? 'brand' : 'factory', actor: req.user });
  }
  res.json(milestone);
});
app.post('/api/orders/:id/reminders', auth, async (req, res) => {
  const order = await orderAccess(req, res, req.params.id); if (!order) return;
  const targetRole = isFactory(req.user) ? 'brand' : 'factory';
  const context = String(req.body.context || '').trim();
  const message = String(req.body.message || '').trim() || `请反馈 ${order.product_name}${context ? `的${context}` : ''}。`;
  const { contacts, error: contactError } = await reminderContacts(req.user, order);
  if (contactError) return fail(res, contactError);
  const allowedEmails = new Set(contacts.map(contact => contact.email));
  const requestedEmails = Array.isArray(req.body.recipients) ? req.body.recipients.map(value => String(value).trim().toLowerCase()) : [];
  const recipients = requestedEmails.filter(email => allowedEmails.has(email));
  const { data, error } = await supabase.from('nl_reminders').insert({ order_id: order.id, message, created_by_name: req.user.name, created_by_role: req.user.role, target_role: targetRole }).select().single();
  if (error) return fail(res, error);
  const email = recipients.length ? await sendReminderEmail({ recipients, subject: `NutriLink 提醒：${order.product_name}${context ? ` - ${context}` : ''}`, text: `${message}\n\n订单：${order.product_name}\n工厂：${order.factory_name}\n\n请登录 NutriLink 查看详情。` }) : { sent: false, reason: '未选择收件人' };
  await activity({ orderId: order.id, action: isFactory(req.user) ? '提醒品牌方' : '提醒工厂', detail: `${message}${email.sent ? ' · 邮件已发送' : recipients.length ? ` · 邮件未发送：${email.reason}` : ''}`, actor: req.user, targetRole });
  await notify({ orderId: order.id, kind: '协作提醒', title: `${req.user.name} 在“${context || '订单协作'}”提醒你处理`, detail: message, targetRole, actor: req.user });
  res.status(201).json({ ...data, email });
});
app.get('/api/reminders', auth, async (req, res) => { const { data, error } = await supabase.from('nl_reminders').select('*').order('created_at', { ascending: false }).limit(100); if (error) return fail(res, error); if (!isFactory(req.user)) return res.json(data); const { ids, error: orderError } = await factoryOrderIds(req.user.factory_name); if (orderError) return fail(res, orderError); res.json(data.filter(item => ids.has(item.order_id))); });
app.post('/api/reminders/:id/read', auth, async (req, res) => { const { data: reminder, error: findError } = await supabase.from('nl_reminders').select('*,nl_orders(factory_name)').eq('id', req.params.id).maybeSingle(); if (findError) return fail(res, findError); if (!reminder) return res.sendStatus(404); if (isFactory(req.user) && reminder.nl_orders?.factory_name !== req.user.factory_name) return res.sendStatus(403); const { data, error } = await supabase.from('nl_reminders').update({ read_at: new Date().toISOString(), read_by_name: req.user.name }).eq('id', reminder.id).select().single(); if (error) return fail(res, error); res.json(data); });
app.post('/api/orders/:id/comments', auth, async (req, res) => { const order = await orderAccess(req, res, req.params.id); if (!order) return; const message = String(req.body.message || '').trim(); const mentions = Array.isArray(req.body.mentions) ? req.body.mentions.join(', ') : String(req.body.mentions || ''); if (!message) return res.status(400).json({ error: '请输入评论内容。' }); const { data, error } = await supabase.from('nl_comments').insert({ order_id: order.id, message, mentions, created_by_name: req.user.name, created_by_role: req.user.role }).select().single(); if (error) return fail(res, error); await activity({ orderId: order.id, action: '添加协作评论', detail: message, actor: req.user, targetRole: isFactory(req.user) ? 'brand' : 'factory' }); if (mentions) await notify({ orderId: order.id, kind: '评论提及', title: `${req.user.name} 在“留言”中提及你`, detail: message, targetRole: isFactory(req.user) ? 'brand' : 'factory', actor: req.user }); res.status(201).json(data); });
app.get('/api/quotes', auth, async (req, res) => { let query = supabase.from('nl_quotes').select('*').order('quoted_at', { ascending: true }); if (req.query.product_name) query = query.eq('product_name', req.query.product_name); const { data, error } = await query; if (error) return fail(res, error); if (!isFactory(req.user)) return res.json(data); res.json(data.filter(item => item.factory_name === req.user.factory_name)); });
app.post('/api/quotes', auth, async (req, res) => { if (isFactory(req.user)) return res.sendStatus(403); const payload = { product_name: String(req.body.product_name || '').trim(), factory_name: String(req.body.factory_name || '').trim(), currency: String(req.body.currency || 'USD').trim(), unit_price: Number(req.body.unit_price), moq: req.body.moq || null, sample_fee: req.body.sample_fee || null, production_days: req.body.production_days || null, payment_terms: String(req.body.payment_terms || '').trim() || null, quoted_at: req.body.quoted_at || new Date().toISOString().slice(0, 10), note: String(req.body.note || '').trim() || null, created_by_name: req.user.name };
  if (!payload.product_name || !payload.factory_name || !Number.isFinite(payload.unit_price)) return res.status(400).json({ error: '产品、工厂和单价为必填项。' });
  const { data, error } = await supabase.from('nl_quotes').insert(payload).select().single(); if (error) return fail(res, error); res.status(201).json(data);
});
app.delete('/api/quotes/:id', auth, async (req, res) => {
  if (isFactory(req.user)) return res.sendStatus(403);
  const { error } = await supabase.from('nl_quotes').delete().eq('id', req.params.id);
  if (error) return fail(res, error);
  res.sendStatus(204);
});
app.get('/api/files/:id', auth, async (req, res) => { const { data: file, error } = await supabase.from('nl_files').select('*').eq('id', req.params.id).maybeSingle(); if (error) return fail(res, error); if (!file) return res.sendStatus(404); const { allowed, error: accessError } = await canAccessFile(req.user, file); if (accessError) return fail(res, accessError); if (!allowed) return res.sendStatus(403); const { data, error: downloadError } = await supabase.storage.from('nutrilink-files').download(file.storage_path); if (downloadError) return fail(res, downloadError); res.type(file.mime_type || 'application/octet-stream').attachment(normalizeFilename(file.original_name)).send(Buffer.from(await data.arrayBuffer())); });
app.delete('/api/files/:id', auth, async (req, res) => { const { data: file, error } = await supabase.from('nl_files').select('*').eq('id', req.params.id).maybeSingle(); if (error) return fail(res, error); if (!file) return res.sendStatus(404); const { allowed, error: accessError } = await canAccessFile(req.user, file); if (accessError) return fail(res, accessError); if (!allowed || (isFactory(req.user) && file.uploaded_by_name !== req.user.name)) return res.sendStatus(403); const { error: storageError } = await supabase.storage.from('nutrilink-files').remove([file.storage_path]); if (storageError) return fail(res, storageError); const { error: deleteError } = await supabase.from('nl_files').delete().eq('id', file.id); if (deleteError) return fail(res, deleteError); res.sendStatus(204); });
app.listen(PORT, () => console.log(`NutriLink running on ${PORT}`));
