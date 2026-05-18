const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto'); // For AES-256-GCM encryption

const app = express();
const PORT = process.env.PORT || 3000;

// ─── ENCRYPTION CONFIG ────────────────────────────────────────
// CRITICAL: Store this key in environment variable!
const ENCRYPTION_KEY = process.env.PROMPT_ENCRYPTION_KEY || 'your-32-character-secret-key-here-change-this-in-production!!';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

// Generate encryption key from password (PBKDF2 for security)
function getKey(salt) {
  return crypto.pbkdf2Sync(ENCRYPTION_KEY, salt, 100000, 32, 'sha512');
}

// Encrypt PRO prompt text (AES-256-GCM)
function encryptPrompt(text) {
  if (!text) return null;
  
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey(salt);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  // Format: salt + iv + tag + encrypted
  const result = Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
  
  console.log('🔐 Prompt encrypted');
  return result;
}

// Decrypt PRO prompt text (AES-256-GCM)
function decryptPrompt(encryptedData) {
  if (!encryptedData) return null;
  
  try {
    const buffer = Buffer.from(encryptedData, 'base64');
    
    const salt = buffer.slice(0, SALT_LENGTH);
    const iv = buffer.slice(SALT_LENGTH, TAG_POSITION);
    const tag = buffer.slice(TAG_POSITION, ENCRYPTED_POSITION);
    const encrypted = buffer.slice(ENCRYPTED_POSITION);
    
    const key = getKey(salt);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    const decrypted = decipher.update(encrypted) + decipher.final('utf8');
    
    console.log('🔓 Prompt decrypted for subscriber');
    return decrypted;
  } catch (err) {
    console.error('❌ Decryption failed:', err.message);
    return '🔒 Erro ao desencriptar prompt';
  }
}

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
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Log all requests
app.use((req, res, next) => {
  console.log(`📍 ${req.method} ${req.path}`);
  next();
});

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

  // Criar tabela site_config para configurações visuais
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      logo_url TEXT,
      favicon_url TEXT,
      bullet_text VARCHAR(200),
      headline VARCHAR(200),
      subheadline VARCHAR(500),
      hero_font VARCHAR(100) DEFAULT 'Bebas Neue',
      video_url TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Inserir configuração padrão se não existir
  await pool.query(`
    INSERT INTO site_config (id, bullet_text, headline, subheadline)
    SELECT 1, 'Biblioteca completa de prompts', 'Dê asas a sua imaginação', 'Prompts profissionais para Gemini, Nano Banana e GPT2. Grátis pra começar.'
    WHERE NOT EXISTS (SELECT 1 FROM site_config WHERE id = 1)
  `);
  await pool.query(`ALTER TABLE site_config ADD COLUMN IF NOT EXISTS hero_font VARCHAR(100) DEFAULT 'Bebas Neue'`);
  console.log('✅ Tabela site_config criada/verificada');


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

// GET todos os prompts (com proteção PRO + desencriptação)
app.get('/api/prompts', async (req, res) => {
  try {
    const { category, search, tipo } = req.query;
    const userEmail = req.headers['x-user-email']; // Email do usuário logado
    
    let query = 'SELECT * FROM prompts WHERE 1=1';
    const params = [];
    if (category && category !== 'all') { params.push(category); query += ` AND category = $${params.length}`; }
    if (tipo) { params.push(tipo); query += ` AND tipo = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (title ILIKE $${params.length} OR description ILIKE $${params.length})`; }
    query += ' ORDER BY created_at DESC';
    
    const { rows } = await pool.query(query, params);
    
    // Verificar se usuário é assinante
    let isSubscriber = false;
    if (userEmail) {
      const userResult = await pool.query('SELECT is_subscriber FROM users WHERE email = $1', [userEmail]);
      isSubscriber = userResult.rows.length > 0 && userResult.rows[0].is_subscriber;
    }
    
    // Processar prompts PRO (desencriptar ou ocultar)
    const filteredRows = rows.map(prompt => {
      if (prompt.tipo === 'pro') {
        if (isSubscriber) {
          // Assinante: desencriptar prompt_text
          return {
            ...prompt,
            prompt_text: decryptPrompt(prompt.prompt_text)
          };
        } else {
          // Não-assinante: ocultar prompt_text
          return {
            ...prompt,
            prompt_text: '🔒 Conteúdo exclusivo para assinantes PRO'
          };
        }
      }
      return prompt;
    });
    
    res.json(filteredRows);
  } catch (err) { 
    console.error('Erro ao buscar prompts:', err);
    res.status(500).json({ error: 'Erro ao buscar prompts' }); 
  }
});

// GET prompt por ID (com proteção PRO + desencriptação)
app.get('/api/prompts/:id', async (req, res) => {
  try {
    const userEmail = req.headers['x-user-email'];
    
    await pool.query('UPDATE prompts SET views = views + 1 WHERE id = $1', [req.params.id]);
    const { rows } = await pool.query('SELECT * FROM prompts WHERE id = $1', [req.params.id]);
    
    if (!rows.length) return res.status(404).json({ error: 'Prompt não encontrado' });
    
    const prompt = rows[0];
    
    // Verificar se usuário é assinante
    let isSubscriber = false;
    if (userEmail) {
      const userResult = await pool.query('SELECT is_subscriber FROM users WHERE email = $1', [userEmail]);
      isSubscriber = userResult.rows.length > 0 && userResult.rows[0].is_subscriber;
    }
    
    // Processar prompt PRO (desencriptar ou ocultar)
    if (prompt.tipo === 'pro') {
      if (isSubscriber) {
        // Assinante: desencriptar prompt_text
        prompt.prompt_text = decryptPrompt(prompt.prompt_text);
      } else {
        // Não-assinante: ocultar prompt_text
        prompt.prompt_text = '🔒 Conteúdo exclusivo para assinantes PRO';
      }
    }
    
    res.json(prompt);
  } catch (err) { 
    console.error('Erro ao buscar prompt:', err);
    res.status(500).json({ error: 'Erro ao buscar prompt' }); 
  }
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
      }
    }

    // ENCRYPT PRO prompts before saving to database
    let finalPromptText = prompt_text;
    if (tipo === 'pro') {
      finalPromptText = encryptPrompt(prompt_text);
      console.log('🔐 Prompt PRO encrypted before saving');
    }

    const { rows } = await pool.query(
      `INSERT INTO prompts (title, description, prompt_text, category, tool, tipo, image_url, is_new)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [title.trim(), description || '', finalPromptText, category, tool || '', tipo || 'free', image_url]
    );
    
    // Return decrypted version to creator
    const result = rows[0];
    if (result.tipo === 'pro') {
      result.prompt_text = prompt_text; // Return original unencrypted text
    }
    
    res.status(201).json(result);
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

    // ENCRYPT PRO prompts before saving to database
    let finalPromptText = prompt_text;
    if (tipo === 'pro') {
      finalPromptText = encryptPrompt(prompt_text);
      console.log('🔐 Prompt PRO encrypted before updating');
    }

    const { rows } = await pool.query(
      `UPDATE prompts SET title=$1, description=$2, prompt_text=$3, category=$4, tool=$5, tipo=$6, image_url=$7
       WHERE id=$8 RETURNING *`,
      [title, description, finalPromptText, category, tool, tipo, image_url, req.params.id]
    );
    
    // Return decrypted version to editor
    const result = rows[0];
    if (result.tipo === 'pro') {
      result.prompt_text = prompt_text; // Return original unencrypted text
    }
    
    res.json(result);
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

// ─── GET site config ──────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM site_config WHERE id = 1');
    if (rows.length === 0) {
      return res.json({
        bullet_text: 'Biblioteca completa de prompts',
        headline: 'Transforme ideias em criações profissionais',
        subheadline: 'Engines selecionadas compatível com +30 IAs, criado por engenheiros de Prompts'
      });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao buscar config:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT site config (admin only) ─────────────────────────────
app.put('/api/config', async (req, res) => {
  console.log('🔵 PUT /api/config CHAMADO');
  console.log('📦 Headers:', req.headers);
  console.log('📦 Body:', req.body);
  
  try {
    const { logo_url, favicon_url, bullet_text, headline, subheadline, hero_font, video_url } = req.body;
    
    console.log('📝 Saving config:', { 
      logo_url: logo_url ? `present (${logo_url.length} chars)` : 'null', 
      favicon_url: favicon_url ? `present (${favicon_url.length} chars)` : 'null', 
      bullet_text, 
      headline, 
      subheadline, 
      video_url: video_url ? `present (${video_url.length} chars)` : 'null' 
    });
    
    // Ensure site_config row exists
    console.log('🔧 Ensuring site_config row exists...');
    await pool.query(`
      INSERT INTO site_config (id, bullet_text, headline, subheadline)
      VALUES (1, 'Biblioteca completa de prompts', 'Dê asas a sua imaginação', 'Prompts profissionais para Gemini, Nano Banana e GPT2. Grátis pra começar.')
      ON CONFLICT (id) DO NOTHING
    `);
    console.log('✅ Row ensured');
    
    // Update config
    console.log('🔧 Updating config...');
    await pool.query(`
      UPDATE site_config
      SET logo_url = COALESCE($1, logo_url),
          favicon_url = COALESCE($2, favicon_url),
          bullet_text = COALESCE($3, bullet_text),
          headline = COALESCE($4, headline),
          subheadline = COALESCE($5, subheadline),
          hero_font = COALESCE($6, hero_font),
          video_url = COALESCE($7, video_url),
          updated_at = NOW()
      WHERE id = 1
    `, [logo_url, favicon_url, bullet_text, headline, subheadline, hero_font, video_url]);
    console.log('✅ Config updated');
    
    const { rows } = await pool.query('SELECT * FROM site_config WHERE id = 1');
    console.log('✅ Config saved successfully:', rows[0]);
    
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar config:', err);
    console.error('❌ Stack:', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Prompt Max rodando na porta ${PORT}`));
}).catch(err => { console.error('Erro ao conectar no banco:', err); process.exit(1); });
