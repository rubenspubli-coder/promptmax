const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

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
function uploadToCloudinary(buffer, folder = 'promptmax') {
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

// ─── Init DB ──────────────────────────────────────────────────
async function initDB() {
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

  await pool.query(`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)`).catch(() => {});
  await pool.query(`ALTER TABLE prompts ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0`).catch(() => {});

  // Criar tabela users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255),
      password_hash VARCHAR(255),
      is_subscriber BOOLEAN DEFAULT false,
      plan VARCHAR(50),
      subscribed_at TIMESTAMP,
      subscription_expires_at TIMESTAMP,
      kiwify_customer_id VARCHAR(255),
      google_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela users criada/verificada');


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
}

// ─── ROTAS ────────────────────────────────────────────────────

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

// GET prompt por ID
app.get('/api/prompts/:id', async (req, res) => {
  try {
    await pool.query('UPDATE prompts SET views = views + 1 WHERE id = $1', [req.params.id]);
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
app.post('/api/prompts', upload.single('image'), async (req, res) => {
  try {
    const { title, description, prompt_text, category, tool, tipo } = req.body;
    if (!title || !prompt_text || !category) return res.status(400).json({ error: 'Campos obrigatórios: title, prompt_text, category' });

    let image_url = null;
    if (req.file) {
      try {
        console.log('📸 Fazendo upload para Cloudinary...', req.file.originalname, req.file.size);
        image_url = await uploadToCloudinary(req.file.buffer);
        console.log('✅ Upload OK:', image_url);
      } catch (uploadErr) {
        console.error('⚠️ Erro no upload Cloudinary:', uploadErr.message);
        console.log('Continuando sem imagem...');
        // Não bloqueia a criação do prompt
      }
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
app.put('/api/prompts/:id', upload.single('image'), async (req, res) => {
  try {
    const { title, description, prompt_text, category, tool, tipo } = req.body;
    const existing = await pool.query('SELECT image_url FROM prompts WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Prompt não encontrado' });

    let image_url = existing.rows[0].image_url; // mantém a atual por padrão
    if (req.file) {
      console.log('📸 Editando — upload para Cloudinary...', req.file.originalname);
      image_url = await uploadToCloudinary(req.file.buffer);
      console.log('✅ Upload OK:', image_url);
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
app.delete('/api/prompts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM prompts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao deletar prompt' }); }
});

// ─── USERS & AUTH ────────────────────────────────────────────

// POST register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });
    
    // Verificar se já existe
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email já cadastrado' });
    
    // Hash básico (em produção use bcrypt)
    const password_hash = password ? Buffer.from(password).toString('base64') : null;
    
    const { rows } = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, is_subscriber, plan',
      [email, name, password_hash]
    );
    res.json(rows[0]);
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ error: 'Erro ao cadastrar' }); 
  }
});

// POST login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });
    
    const { rows } = await pool.query(
      'SELECT id, email, name, is_subscriber, plan FROM users WHERE email = $1',
      [email]
    );
    
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    res.json(rows[0]);
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ error: 'Erro ao fazer login' }); 
  }
});

// GET all users (admin)
app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name, is_subscriber, plan, subscribed_at, created_at FROM users ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ error: 'Erro ao listar usuários' }); 
  }
});

// PUT update user subscription (admin manual)
app.put('/api/users/:id/subscription', async (req, res) => {
  try {
    const { is_subscriber, plan } = req.body;
    const subscribed_at = is_subscriber ? new Date() : null;
    
    const { rows } = await pool.query(
      'UPDATE users SET is_subscriber = $1, plan = $2, subscribed_at = $3 WHERE id = $4 RETURNING *',
      [is_subscriber, plan, subscribed_at, req.params.id]
    );
    
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ error: 'Erro ao atualizar assinatura' }); 
  }
});

// ─── KIWIFY WEBHOOK ──────────────────────────────────────────

app.post('/api/webhook/kiwify', async (req, res) => {
  try {
    console.log('🔔 Webhook Kiwify recebido:', req.body);
    
    const { 
      event, 
      Customer: customer,
      Product: product,
      order_status,
      subscription_status 
    } = req.body;
    
    const email = customer?.email;
    if (!email) {
      console.log('⚠️ Webhook sem email');
      return res.json({ success: true });
    }
    
    // Eventos que ativam assinatura
    if (event === 'order.paid' || order_status === 'paid' || subscription_status === 'active') {
      console.log(`✅ Ativando assinatura para ${email}`);
      
      // Criar usuário se não existir
      await pool.query(
        `INSERT INTO users (email, name, is_subscriber, plan, subscribed_at, kiwify_customer_id)
         VALUES ($1, $2, true, $3, NOW(), $4)
         ON CONFLICT (email) 
         DO UPDATE SET is_subscriber = true, plan = $3, subscribed_at = NOW(), kiwify_customer_id = $4`,
        [email, customer?.name || email.split('@')[0], product?.name || 'kiwify', customer?.id]
      );
      
      console.log(`💚 Assinatura ativada: ${email}`);
    }
    
    // Eventos que cancelam assinatura
    if (event === 'order.refunded' || subscription_status === 'canceled' || order_status === 'refunded') {
      console.log(`❌ Cancelando assinatura para ${email}`);
      
      await pool.query(
        'UPDATE users SET is_subscriber = false WHERE email = $1',
        [email]
      );
      
      console.log(`🔴 Assinatura cancelada: ${email}`);
    }
    
    res.json({ success: true });
  } catch (err) { 
    console.error('❌ Erro no webhook:', err); 
    res.status(500).json({ error: 'Erro ao processar webhook' }); 
  }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Prompt Max rodando na porta ${PORT}`));
}).catch(err => { console.error('Erro ao conectar no banco:', err); process.exit(1); });
