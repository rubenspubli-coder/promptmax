const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'seu_secret_jwt_super_seguro_aqui';

// ─── Cloudinary config ────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dx6uxrr6s',
  api_key:    process.env.CLOUDINARY_API_KEY    || '637614521198185',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'ZP6GcJf1rWU6RXFEoz50vjX2GM4'
});

// ─── Multer (memória — envia direto pro Cloudinary) ───────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Apenas imagens são permitidas'));
  }
});

// ─── Função helper: upload pro Cloudinary ─────────────────────
function uploadToCloudinary(buffer, folder = 'prompthouse') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PostgreSQL ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ─── Middleware: Verificar JWT ────────────────────────────────
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Token inválido ou expirado' });
  }
}

// ─── Init DB ──────────────────────────────────────────────────
async function initDB() {
  try {
    // Tabela: prompts
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prompts (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        prompt_text TEXT NOT NULL,
        category VARCHAR(50) NOT NULL,
        tool VARCHAR(100),
        tipo VARCHAR(10) DEFAULT 'free',
        image_url VARCHAR(500),
        views INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        is_new BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Tabela: users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        name VARCHAR(255),
        google_id VARCHAR(255) UNIQUE,
        avatar_url VARCHAR(500),
        subscription_plan VARCHAR(50) DEFAULT 'free',
        subscription_start TIMESTAMP,
        subscription_end TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Tabela: favorites
    await pool.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        prompt_id INTEGER REFERENCES prompts(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, prompt_id)
      )
    `);

    // Tabela: view_history
    await pool.query(`
      CREATE TABLE IF NOT EXISTS view_history (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        prompt_id INTEGER REFERENCES prompts(id) ON DELETE CASCADE,
        viewed_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Tabela: subscriptions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        plan VARCHAR(50) NOT NULL,
        price DECIMAL(10, 2),
        start_date TIMESTAMP DEFAULT NOW(),
        end_date TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        payment_method VARCHAR(50),
        payment_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Adicionar colunas faltando (caso upgrade)
    await pool.query(`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)`).catch(() => {});
    await pool.query(`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0`).catch(() => {});

    // Seed: Prompts iniciais
    const { rows } = await pool.query('SELECT COUNT(*) FROM prompts');
    if (parseInt(rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO prompts (title, description, prompt_text, category, tool, tipo, views, is_new) VALUES
        ('Atleta Futebol AAA', 'Render ultra-realista de jogador em estilo EA Sports FC com iluminação cinematográfica.', 'Ultra-realistic 3D render of a soccer player, dramatic stadium spotlight, Unreal Engine 5, candy-tone color grading, 8K.', 'sports', 'Midjourney', 'free', 17100, true),
        ('Retrato Fotorrealista', 'Foto de retrato profissional com bokeh cinematográfico e luz natural dourada.', 'Photorealistic portrait, golden hour lighting, cinematic bokeh, 8K ultra-high fidelity.', 'photo', 'Leonardo AI', 'pro', 11700, false),
        ('Copy de Alta Conversão', 'Texto persuasivo para landing pages com gatilhos mentais.', 'Write a high-converting landing page copy with psychological triggers, urgency, and clear CTA.', 'text', 'ChatGPT', 'free', 5100, false),
        ('UI Interface Dark', 'Design de interface premium dark com glassmorphism.', 'Design a dark premium UI with glassmorphism, neon accents, and futuristic typography.', 'design', 'Figma AI', 'free', 5000, false),
        ('Mascote 3D Esportivo', 'Mascote 3D estilizado para times esportivos.', '3D stylized sports mascot, iGen proportions, candy-tone colors, Pixar render style.', 'sports', 'Midjourney', 'pro', 3200, true)
      `);
    }

    console.log('✅ Banco de dados inicializado');
  } catch (err) {
    console.error('❌ Erro ao inicializar DB:', err);
  }
}

// ─── ROTAS: PROMPTS ───────────────────────────────────────────

// GET todos os prompts
app.get('/api/prompts', async (req, res) => {
  try {
    const { category, search, tipo } = req.query;
    let query = 'SELECT * FROM prompts WHERE 1=1';
    const params = [];
    if (category && category !== 'all') { params.push(category); query += ` AND category = $${params.length}`; }
    if (tipo) { params.push(tipo); query += ` AND tipo = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (title ILIKE $${params.length} OR description ILIKE $${params.length})`; }
    query += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar prompts' }); }
});

// GET prompt por ID (incrementa views)
app.get('/api/prompts/:id', async (req, res) => {
  try {
    const userId = req.query.userId || null;
    
    // Incrementar views
    await pool.query('UPDATE prompts SET views = views + 1 WHERE id = $1', [req.params.id]);
    
    // Registrar no histórico se usuário logado
    if (userId) {
      await pool.query(
        'INSERT INTO view_history (user_id, prompt_id) VALUES ($1, $2)',
        [userId, req.params.id]
      ).catch(() => {}); // Ignora erro se duplicado
    }
    
    const { rows } = await pool.query('SELECT * FROM prompts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Prompt não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar prompt' }); }
});

// GET stats
app.get('/api/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM prompts');
    const free  = await pool.query("SELECT COUNT(*) FROM prompts WHERE tipo = 'free'");
    const pro   = await pool.query("SELECT COUNT(*) FROM prompts WHERE tipo = 'pro'");
    const views = await pool.query('SELECT SUM(views) FROM prompts');
    res.json({
      total: parseInt(total.rows[0].count),
      free:  parseInt(free.rows[0].count),
      pro:   parseInt(pro.rows[0].count),
      views: parseInt(views.rows[0].sum) || 0
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar stats' }); }
});

// POST novo prompt
app.post('/api/prompts', verifyToken, upload.single('image'), async (req, res) => {
  try {
    const { title, description, prompt_text, category, tool, tipo } = req.body;
    if (!title || !prompt_text || !category) return res.status(400).json({ error: 'Campos obrigatórios: title, prompt_text, category' });

    let image_url = null;
    if (req.file) {
      image_url = await uploadToCloudinary(req.file.buffer);
    }

    const { rows } = await pool.query(
      `INSERT INTO prompts (title, description, prompt_text, category, tool, tipo, image_url, is_new)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [title.trim(), description || '', prompt_text, category, tool || '', tipo || 'free', image_url]
    );
    res.status(201).json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao criar prompt' }); }
});

// PUT editar prompt
app.put('/api/prompts/:id', verifyToken, upload.single('image'), async (req, res) => {
  try {
    const { title, description, prompt_text, category, tool, tipo } = req.body;
    const existing = await pool.query('SELECT image_url FROM prompts WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Prompt não encontrado' });

    let image_url = existing.rows[0].image_url;
    if (req.file) {
      image_url = await uploadToCloudinary(req.file.buffer);
    }

    const { rows } = await pool.query(
      `UPDATE prompts SET title=$1, description=$2, prompt_text=$3, category=$4, tool=$5, tipo=$6, image_url=$7
       WHERE id=$8 RETURNING *`,
      [title, description, prompt_text, category, tool, tipo, image_url, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao editar prompt' }); }
});

// DELETE prompt
app.delete('/api/prompts/:id', verifyToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM prompts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao deletar prompt' }); }
});

// ─── ROTAS: AUTENTICAÇÃO ──────────────────────────────────────

// POST Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });

    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, subscription_plan',
      [email, password_hash, name || 'Usuário']
    );

    const token = jwt.sign({ id: rows[0].id }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ user: rows[0], token });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email já cadastrado' });
    res.status(500).json({ error: 'Erro ao registrar' });
  }
});

// POST Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Email ou senha inválidos' });

    const user = rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) return res.status(401).json({ error: 'Email ou senha inválidos' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: { id: user.id, email: user.email, name: user.name, subscription_plan: user.subscription_plan }, token });
  } catch (err) { res.status(500).json({ error: 'Erro ao fazer login' }); }
});

// POST Google Login
app.post('/api/auth/google', async (req, res) => {
  try {
    const { email, name, google_id, avatar_url } = req.body;
    if (!email || !google_id) return res.status(400).json({ error: 'Email e google_id obrigatórios' });

    let user = await pool.query('SELECT * FROM users WHERE google_id = $1', [google_id]);
    if (!user.rows.length) {
      user = await pool.query(
        'INSERT INTO users (email, google_id, name, avatar_url) VALUES ($1, $2, $3, $4) RETURNING id, email, name, subscription_plan',
        [email, google_id, name, avatar_url]
      );
    } else {
      user = { rows: [user.rows[0]] };
    }

    const token = jwt.sign({ id: user.rows[0].id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ user: user.rows[0], token });
  } catch (err) { res.status(500).json({ error: 'Erro ao autenticar com Google' }); }
});

// ─── ROTAS: DASHBOARD ─────────────────────────────────────────

// GET Dashboard do usuário
app.get('/api/users/:id/dashboard', verifyToken, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Acesso negado' });

    const user = await pool.query('SELECT id, email, name, subscription_plan, subscription_start, subscription_end FROM users WHERE id = $1', [req.userId]);
    if (!user.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });

    const favorites = await pool.query(
      `SELECT p.* FROM prompts p 
       INNER JOIN favorites f ON p.id = f.prompt_id 
       WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT 10`,
      [req.userId]
    );

    const history = await pool.query(
      `SELECT DISTINCT ON (p.id) p.*, vh.viewed_at FROM prompts p 
       INNER JOIN view_history vh ON p.id = vh.prompt_id 
       WHERE vh.user_id = $1 ORDER BY p.id, vh.viewed_at DESC LIMIT 10`,
      [req.userId]
    );

    const subscription = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
      [req.userId, 'active']
    );

    res.json({
      user: user.rows[0],
      favorites: favorites.rows,
      history: history.rows,
      subscription: subscription.rows[0] || null
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao buscar dashboard' }); }
});

// GET Favoritos
app.get('/api/users/:id/favorites', verifyToken, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Acesso negado' });

    const { rows } = await pool.query(
      `SELECT p.* FROM prompts p 
       INNER JOIN favorites f ON p.id = f.prompt_id 
       WHERE f.user_id = $1 ORDER BY f.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar favoritos' }); }
});

// GET Histórico
app.get('/api/users/:id/history', verifyToken, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Acesso negado' });

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (p.id) p.*, vh.viewed_at FROM prompts p 
       INNER JOIN view_history vh ON p.id = vh.prompt_id 
       WHERE vh.user_id = $1 ORDER BY p.id, vh.viewed_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar histórico' }); }
});

// GET Assinatura ativa
app.get('/api/users/:id/subscription', verifyToken, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.userId) return res.status(403).json({ error: 'Acesso negado' });

    const { rows } = await pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1`,
      [req.userId, 'active']
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar assinatura' }); }
});

// ─── ROTAS: FAVORITOS ─────────────────────────────────────────

// POST Adicionar favorito
app.post('/api/favorites/:userId/:promptId', verifyToken, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Acesso negado' });

    await pool.query(
      'INSERT INTO favorites (user_id, prompt_id) VALUES ($1, $2)',
      [req.params.userId, req.params.promptId]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Já favoritado' });
    res.status(500).json({ error: 'Erro ao adicionar favorito' });
  }
});

// DELETE Remover favorito
app.delete('/api/favorites/:userId/:promptId', verifyToken, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Acesso negado' });

    await pool.query(
      'DELETE FROM favorites WHERE user_id = $1 AND prompt_id = $2',
      [req.params.userId, req.params.promptId]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover favorito' }); }
});

// GET Verificar se é favorito
app.get('/api/favorites/:userId/:promptId', verifyToken, async (req, res) => {
  try {
    if (parseInt(req.params.userId) !== req.userId) return res.status(403).json({ error: 'Acesso negado' });

    const { rows } = await pool.query(
      'SELECT * FROM favorites WHERE user_id = $1 AND prompt_id = $2',
      [req.params.userId, req.params.promptId]
    );
    res.json({ isFavorite: rows.length > 0 });
  } catch (err) { res.status(500).json({ error: 'Erro ao verificar favorito' }); }
});

// ─── ROTAS: ASSINATURA ────────────────────────────────────────

// POST Criar assinatura
app.post('/api/subscriptions', verifyToken, async (req, res) => {
  try {
    const { plan, price } = req.body;
    if (!plan) return res.status(400).json({ error: 'Plano obrigatório' });

    const planDays = {
      'semestral': 180,
      'anual': 365,
      'vitalicio': 36500 // 100 anos
    };

    const days = planDays[plan] || 365;
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + days);

    const { rows } = await pool.query(
      `INSERT INTO subscriptions (user_id, plan, price, end_date, status) 
       VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
      [req.userId, plan, price || 0, endDate]
    );

    // Atualizar subscription do usuário
    await pool.query(
      'UPDATE users SET subscription_plan = $1, subscription_end = $2 WHERE id = $3',
      [plan, endDate, req.userId]
    );

    res.status(201).json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao criar assinatura' }); }
});

// ─── SPA fallback ─────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Prompt House rodando na porta ${PORT}`));
}).catch(err => { console.error('Erro ao conectar no banco:', err); process.exit(1); });
