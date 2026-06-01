require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');

const app    = express();
const httpSv = http.createServer(app);
const io     = new Server(httpSv);
const pool   = new Pool({ connectionString: process.env.POSTGRES_URI });
const JWT_SECRET = process.env.JWT_SECRET || 'secret';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'กรุณากรอกชื่อและรหัสผ่าน' });
  if (username.trim().length > 20) return res.status(400).json({ error: 'ชื่อยาวเกิน 20 ตัวอักษร' });
  if (password.length < 4) return res.status(400).json({ error: 'รหัสผ่านสั้นเกิน 4 ตัวอักษร' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO slave_users (username, password) VALUES ($1, $2)', [username.trim(), hash]);
    const token = jwt.sign({ username: username.trim() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: username.trim() });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'ชื่อนี้ถูกใช้แล้ว' });
    console.error(e); res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'กรุณากรอกชื่อและรหัสผ่าน' });
  try {
    const r = await pool.query('SELECT * FROM slave_users WHERE username = $1', [username.trim()]);
    if (!r.rows.length) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    const ok = await bcrypt.compare(password, r.rows[0].password);
    if (!ok) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    const token = jwt.sign({ username: username.trim() }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: username.trim() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

// ── Games ─────────────────────────────────────────────────────────────────────
require('./games/slave')(app, io, JWT_SECRET);
require('./games/jigsaw')(app, pool, JWT_SECRET);
require('./games/bomberman')(app, io, pool, JWT_SECRET);

const PORT = process.env.PORT || 3000;
httpSv.listen(PORT, '0.0.0.0', () => console.log(`🎮 Server → http://localhost:${PORT}`));
