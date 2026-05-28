const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ─── EMAIL CONFIG (Resend HTTP API) ───────────────────────────
// Usa a API HTTP do Resend (porta 443) — evita bloqueio de portas SMTP em cloud
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.SMTP_FROM || 'no-reply@promptshouse.com';

  if (!apiKey) {
    console.log(`📧 [EMAIL SIMULADO] Para: ${to} | Assunto: ${subject}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: `Prompts House <${from}>`, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error: ${err}`);
  }
  console.log(`✅ Email enviado para ${to}`);
}

// IDs dos produtos Kiwify → plano
const KIWIFY_PLANS = {
  monthly: { days: 30,  label: 'Mensal' },
  annual:  { days: 365, label: 'Anual'  },
};
function detectPlan(product) {
  const name = (product?.name || '').toLowerCase();
  const id   = (product?.id   || '').toLowerCase();
  if (name.includes('anual') || name.includes('annual') || id.includes('bCQL1VF'.toLowerCase())) return 'annual';
  return 'monthly';
}

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

    // Se o buffer for menor que o mínimo do formato criptografado,
    // o dado é texto simples (prompt criado antes da criptografia).
    const MIN_ENCRYPTED_SIZE = SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1;
    if (buffer.length < MIN_ENCRYPTED_SIZE) {
      console.log('📄 Prompt em texto simples (pré-criptografia)');
      return encryptedData;
    }

    const salt = buffer.slice(0, SALT_LENGTH);
    const iv   = buffer.slice(SALT_LENGTH, TAG_POSITION);
    const tag  = buffer.slice(TAG_POSITION, ENCRYPTED_POSITION);
    const encrypted = buffer.slice(ENCRYPTED_POSITION);

    const key = getKey(salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = decipher.update(encrypted) + decipher.final('utf8');
    console.log('🔓 Prompt decrypted for subscriber');
    return decrypted;
  } catch (err) {
    // Falha na descriptografia — dado pode ser texto simples com conteúdo longo.
    // Retorna como está para não quebrar a experiência do assinante.
    console.error('⚠️ Decryption failed, returning as plain text:', err.message);
    return encryptedData;
  }
}

// ─── Cloudinary config ────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dx6uxrr6s',
  api_key:    process.env.CLOUDINARY_API_KEY    || '637614521198185',
  api_secret: process.env.CLOUDINARY_API_SECRET
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

// Serve arquivos estáticos mas não index.html — a rota SPA injeta o config
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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
  // Migrations seguras para DBs antigos (ADD COLUMN IF NOT EXISTS)
  const userMigrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_subscriber BOOLEAN DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(50)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscribed_at TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS kiwify_customer_id VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS kiwify_subscription_id VARCHAR(255)`,
  ];
  for (const sql of userMigrations) {
    await pool.query(sql).catch(e => console.log(`⚠️ Migration skip: ${e.message}`));
  }

  // Fix 1: is_subscriber=true mas data vencida (admin não resetava subscription_expires_at)
  const fixExpired = await pool.query(`
    UPDATE users SET subscription_expires_at = NOW() + INTERVAL '365 days'
    WHERE is_subscriber = true
      AND subscription_expires_at IS NOT NULL
      AND subscription_expires_at < NOW()
    RETURNING email
  `);
  if (fixExpired.rowCount > 0)
    console.log(`🔧 Fix1 subscription_expires_at:`, fixExpired.rows.map(r => r.email));

  // Fix 2: is_subscriber=true sem data — apenas Kiwify (admin accounts devem ficar NULL = permanente)
  const fixNull = await pool.query(`
    UPDATE users SET subscription_expires_at = NOW() + INTERVAL '365 days'
    WHERE is_subscriber = true
      AND subscription_expires_at IS NULL
      AND kiwify_customer_id IS NOT NULL
    RETURNING email
  `);
  if (fixNull.rowCount > 0)
    console.log(`🔧 Fix2 subscription_expires_at Kiwify:`, fixNull.rows.map(r => r.email));

  // Fix 3: contas ativadas pelo admin (sem kiwify_customer_id) que foram
  // indevidamente expiradas pelo auto-expiry antes do deploy deste fix.
  // Conditions relaxadas: qualquer conta sem kiwify, sem is_subscriber,
  // que tenha subscription_expires_at vencida (sinal de que houve ativação prévia).
  // Re-ativa com NULL = acesso permanente (nunca auto-expira).
  const fixAdminExpired = await pool.query(`
    UPDATE users SET is_subscriber = true, subscription_expires_at = NULL
    WHERE is_subscriber = false
      AND kiwify_customer_id IS NULL
      AND subscription_expires_at IS NOT NULL
      AND subscription_expires_at < NOW()
    RETURNING email
  `);
  if (fixAdminExpired.rowCount > 0)
    console.log(`🔧 Fix3 reativado contas admin expiradas:`, fixAdminExpired.rows.map(r => r.email));

  // Fix 4: garantia direta — conta master sem Kiwify que ainda esteja inativa
  // (cobre o caso em que subscription_expires_at=NULL e Fix3 não alcança)
  const fixMaster = await pool.query(`
    UPDATE users SET is_subscriber = true, plan = COALESCE(plan, 'annual'), subscription_expires_at = NULL
    WHERE email = 'rubenspubli@gmail.com'
      AND is_subscriber = false
      AND kiwify_customer_id IS NULL
    RETURNING email
  `);
  if (fixMaster.rowCount > 0)
    console.log(`🔧 Fix4 conta master reativada:`, fixMaster.rows.map(r => r.email));

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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP`);
  console.log('✅ Tabela site_config criada/verificada');

  // Gerenciador de Tags
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_tags (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      code TEXT NOT NULL,
      position VARCHAR(10) NOT NULL DEFAULT 'head',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Tabela site_tags criada/verificada');


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
    const { category, search, tipo, limit, offset } = req.query;
    const isPaginated = limit !== undefined;

    let whereClause = 'WHERE 1=1';
    const params = [];
    if (category && category !== 'all') { params.push(category); whereClause += ` AND category = $${params.length}`; }
    if (tipo) { params.push(tipo); whereClause += ` AND tipo = $${params.length}`; }
    if (search) { params.push(`%${search}%`); whereClause += ` AND (title ILIKE $${params.length} OR description ILIKE $${params.length})`; }

    let query = `SELECT * FROM prompts ${whereClause} ORDER BY created_at DESC`;
    if (isPaginated) {
      const lim = Math.min(parseInt(limit) || 12, 100);
      const off = parseInt(offset) || 0;
      query += ` LIMIT ${lim} OFFSET ${off}`;
    }

    const { rows } = await pool.query(query, params);

    // Verificar se é admin ou assinante — requer token assinado (nunca confiar em header não verificado)
    const adminToken = req.headers['x-admin-token'];
    const isAdmin = adminToken && verifyAdminToken(adminToken);
    let isSubscriber = false;
    if (!isAdmin) {
      const verified = verifyUserToken(req.headers['x-user-token']);
      if (verified) {
        const userResult = await pool.query('SELECT is_subscriber FROM users WHERE id = $1 AND email = $2', [verified.userId, verified.email]);
        isSubscriber = userResult.rows.length > 0 && userResult.rows[0].is_subscriber;
      }
    }

    // Processar prompts PRO (desencriptar ou ocultar)
    // Nota: isAdmin NÃO dá acesso ao conteúdo PRO — apenas assinatura válida dá.
    // O admin acessa conteúdo PRO via endpoint dedicado /api/admin/prompts/:id.
    const filteredRows = rows.map(prompt => {
      if (prompt.tipo === 'pro') {
        if (isSubscriber) {
          return { ...prompt, prompt_text: decryptPrompt(prompt.prompt_text) };
        } else {
          return { ...prompt, prompt_text: '🔒 Conteúdo exclusivo para assinantes PRO' };
        }
      }
      return prompt;
    });

    if (isPaginated) {
      const countResult = await pool.query(`SELECT COUNT(*) FROM prompts ${whereClause}`, params);
      const total = parseInt(countResult.rows[0].count);
      return res.json({ data: filteredRows, total });
    }

    res.json(filteredRows);
  } catch (err) {
    console.error('Erro ao buscar prompts:', err);
    res.status(500).json({ error: 'Erro ao buscar prompts' });
  }
});

// GET prompt por ID (com proteção PRO + desencriptação)
app.get('/api/prompts/:id', async (req, res) => {
  try {
    await pool.query('UPDATE prompts SET views = views + 1 WHERE id = $1', [req.params.id]);
    const { rows } = await pool.query('SELECT * FROM prompts WHERE id = $1', [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Prompt não encontrado' });

    const prompt = rows[0];

    // Verificar acesso — requer token assinado
    const adminToken = req.headers['x-admin-token'];
    const isAdmin = adminToken && verifyAdminToken(adminToken);
    let isSubscriber = false;
    if (!isAdmin) {
      const verified = verifyUserToken(req.headers['x-user-token']);
      if (verified) {
        const userResult = await pool.query('SELECT is_subscriber FROM users WHERE id = $1 AND email = $2', [verified.userId, verified.email]);
        isSubscriber = userResult.rows.length > 0 && userResult.rows[0].is_subscriber;
      }
    }

    // Processar prompt PRO (desencriptar ou ocultar)
    // isAdmin NÃO desbloqueia aqui — use /api/admin/prompts/:id para edição.
    if (prompt.tipo === 'pro') {
      if (isSubscriber) {
        prompt.prompt_text = decryptPrompt(prompt.prompt_text);
      } else {
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
app.post('/api/prompts', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, description, prompt_text, category, tool, tipo } = req.body;
    if (!title || !prompt_text || !category) return res.status(400).json({ error: 'Campos obrigatórios: title, prompt_text, category' });
    if (prompt_text.startsWith('🔒')) return res.status(400).json({ error: 'O texto do prompt não pode ser o placeholder de bloqueio. Cole o prompt real.' });

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
app.put('/api/prompts/:id', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { title, description, prompt_text, category, tool, tipo } = req.body;
    if (prompt_text && prompt_text.startsWith('🔒')) return res.status(400).json({ error: 'O texto do prompt não pode ser o placeholder de bloqueio. Cole o prompt real.' });
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
app.delete('/api/prompts/:id', requireAdmin, async (req, res) => {
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
    
    const password_hash = password ? await bcrypt.hash(password, 10) : null;
    
    const { rows } = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, is_subscriber, plan',
      [email, name, password_hash]
    );
    const newUser = rows[0];
    newUser.token = generateUserToken(newUser.id, newUser.email);
    res.json(newUser);
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
      'SELECT id, email, name, is_subscriber, plan, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });

    if (password && rows[0].password_hash) {
      const isBcrypt = rows[0].password_hash.startsWith('$2');
      let valid = false;
      if (isBcrypt) {
        valid = await bcrypt.compare(password, rows[0].password_hash);
      } else {
        // legado: base64 — migra automaticamente para bcrypt no login
        valid = Buffer.from(password).toString('base64') === rows[0].password_hash;
        if (valid) {
          const upgraded = await bcrypt.hash(password, 10);
          await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [upgraded, email]);
        }
      }
      if (!valid) return res.status(401).json({ error: 'Senha incorreta' });
    }

    const { password_hash: _, ...safeUser } = rows[0];
    safeUser.token = generateUserToken(safeUser.id, safeUser.email);
    res.json(safeUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// GET verificar status de assinatura (chamado no load da página)
app.get('/api/auth/me', async (req, res) => {
  try {
    // Aceita x-user-token (novo, seguro) ou x-user-email (legado, apenas para /me)
    let email = null;
    const verified = verifyUserToken(req.headers['x-user-token']);
    if (verified) {
      email = verified.email;
    } else {
      email = req.headers['x-user-email']; // fallback legado só para este endpoint
    }
    if (!email) return res.status(401).json({ error: 'Não autenticado' });
    const { rows } = await pool.query(
      'SELECT id, email, name, is_subscriber, plan, subscription_expires_at, kiwify_customer_id FROM users WHERE email = $1',
      [email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    const u = rows[0];
    // Auto-expiry apenas para assinantes Kiwify (kiwify_customer_id preenchido)
    // Contas ativadas manualmente pelo admin nunca expiram automaticamente
    if (u.is_subscriber && u.kiwify_customer_id && u.subscription_expires_at && new Date(u.subscription_expires_at) < new Date()) {
      await pool.query('UPDATE users SET is_subscriber = false WHERE email = $1', [email]);
      u.is_subscriber = false;
    }
    // Retorna token atualizado (caso o usuário ainda use token legado)
    const token = generateUserToken(u.id, u.email);
    res.json({ ...u, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST trocar senha
app.post('/api/auth/change-password', async (req, res) => {
  try {
    const email = getAuthEmail(req);
    if (!email) return res.status(401).json({ error: 'Não autenticado' });
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (rows[0].password_hash) {
      const isBcrypt = rows[0].password_hash.startsWith('$2');
      const valid = isBcrypt
        ? await bcrypt.compare(current_password, rows[0].password_hash)
        : Buffer.from(current_password).toString('base64') === rows[0].password_hash;
      if (!valid) return res.status(400).json({ error: 'Senha atual incorreta' });
    }
    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [newHash, email]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });

    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    // Responde sempre com sucesso para não expor se o email existe
    if (!rows.length) return res.json({ ok: true });

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3',
      [token, expires, email]
    );

    const appUrl = process.env.APP_URL || 'https://promptshouse.com';
    const resetUrl = `${appUrl}/reset-password?token=${token}`;
    console.log(`🔑 Reset token para ${email}: ${token}`);

    await sendEmail({
      to: email,
      subject: 'Redefinição de senha — Prompts House',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#080b14;color:#fff;border-radius:16px;overflow:hidden">
          <div style="padding:32px;background:linear-gradient(135deg,#f59e0b,#ec4899);text-align:center">
            <h1 style="margin:0;font-size:28px;color:#08080a">Prompts House</h1>
            <p style="margin:8px 0 0;color:#08080a;opacity:.8">Redefinição de senha</p>
          </div>
          <div style="padding:32px">
            <p style="font-size:16px">Olá!</p>
            <p>Recebemos uma solicitação para redefinir sua senha. Clique no botão abaixo para criar uma nova:</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${resetUrl}" style="background:linear-gradient(90deg,#f59e0b,#ec4899);color:#08080a;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px">Redefinir senha →</a>
            </div>
            <p style="color:#9ca3af;font-size:13px">Este link expira em 1 hora. Se você não solicitou a redefinição, ignore este email.</p>
            <hr style="border:1px solid rgba(255,255,255,.1);margin:24px 0">
            <p style="color:#6b7280;font-size:12px;text-align:center">Prompts House · Todos os direitos reservados</p>
          </div>
        </div>
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'Token e senha (mínimo 6 caracteres) são obrigatórios' });
    }
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'Token inválido ou expirado' });
    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [newHash, rows[0].id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PUT /api/auth/profile — atualizar nome do usuário
app.put('/api/auth/profile', async (req, res) => {
  try {
    const email = getAuthEmail(req);
    if (!email) return res.status(401).json({ error: 'Não autenticado' });
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
    const { rows } = await pool.query(
      'UPDATE users SET name = $1 WHERE email = $2 RETURNING id, email, name, is_subscriber, plan',
      [name.trim(), email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/cancel-subscription — cancelar assinatura
app.post('/api/auth/cancel-subscription', async (req, res) => {
  try {
    const email = getAuthEmail(req);
    if (!email) return res.status(401).json({ error: 'Não autenticado' });

    const { rows } = await pool.query(
      'SELECT id, name, is_subscriber, kiwify_subscription_id, subscription_expires_at FROM users WHERE email = $1',
      [email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    const user = rows[0];

    if (!user.is_subscriber) return res.status(400).json({ error: 'Você não possui assinatura ativa' });

    // Tentar cancelar na Kiwify via API (OAuth 2.0)
    const clientId     = process.env.KIWIFY_CLIENT_ID;
    const clientSecret = process.env.KIWIFY_CLIENT_SECRET;
    const accountId    = process.env.KIWIFY_ACCOUNT_ID;
    const subId        = user.kiwify_subscription_id;

    if (clientId && clientSecret && subId) {
      try {
        // 1. Obter access_token
        const tokenRes = await fetch('https://api.kiwify.com.br/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
        });
        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        if (accessToken) {
          // 2. Cancelar assinatura
          const cancelRes = await fetch(`https://api.kiwify.com.br/v1/subscriptions/${subId}/cancel`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              ...(accountId ? { 'account-id': accountId } : {}),
            },
          });
          console.log(`🔔 Kiwify cancel response: ${cancelRes.status}`);
        } else {
          console.log(`⚠️ Kiwify não retornou access_token:`, tokenData);
        }
      } catch (kErr) {
        console.log(`⚠️ Kiwify API error (cancelamento local aplicado): ${kErr.message}`);
      }
    } else {
      console.log(`⚠️ Cancelamento sem Kiwify API (vars ausentes ou subscription_id não registrado)`);
    }

    // Cancela renovação mas mantém acesso até o fim do período pago
    await pool.query(
      'UPDATE users SET kiwify_subscription_id = NULL WHERE email = $1',
      [email]
    );

    const expiresAt = user.subscription_expires_at
      ? new Date(user.subscription_expires_at).toLocaleDateString('pt-BR')
      : null;

    // Enviar email de confirmação
    await sendEmail({
      to: email,
      subject: 'Sua assinatura do Prompts House foi cancelada',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#080b14;color:#fff;border-radius:16px;overflow:hidden">
          <div style="padding:32px;background:linear-gradient(135deg,#374151,#1f2937);text-align:center">
            <h1 style="margin:0;font-size:24px;color:#fff">Prompts House</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,.7)">Cancelamento de assinatura</p>
          </div>
          <div style="padding:32px">
            <p style="font-size:16px">Olá, <strong>${user.name || email}</strong>!</p>
            <p>Sua assinatura do <strong>Prompts House</strong> foi cancelada com sucesso e não será renovada.</p>
            ${expiresAt
              ? `<p style="color:#9ca3af;font-size:14px">Você ainda tem acesso a todos os prompts premium até <strong style="color:#fff">${expiresAt}</strong>, quando o período pago se encerra.</p>`
              : `<p style="color:#9ca3af;font-size:14px">Seu acesso permanece ativo até o fim do período pago.</p>`
            }
            <div style="text-align:center;margin:28px 0">
              <a href="https://promptshouse.com" style="background:linear-gradient(90deg,#f59e0b,#ec4899);color:#08080a;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px">Acessar o site →</a>
            </div>
            <hr style="border:1px solid rgba(255,255,255,.1);margin:24px 0">
            <p style="color:#6b7280;font-size:12px;text-align:center">Prompts House · Todos os direitos reservados</p>
          </div>
        </div>
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN AUTH (server-side) ─────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pablo2025';
// Token is a signed HMAC so the server can verify it without a DB lookup
function generateAdminToken() {
  const payload = `admin:${Date.now()}`;
  const sig = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}
function verifyAdminToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const lastColon = decoded.lastIndexOf(':');
    const payload = decoded.slice(0, lastColon);
    const sig = decoded.slice(lastColon + 1);
    const expected = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('hex');
    return sig === expected;
  } catch { return false; }
}

// ─── USER SESSION TOKENS (HMAC-assinados, sem DB) ─────────────
const USER_TOKEN_SECRET = process.env.JWT_SECRET || ENCRYPTION_KEY;

function generateUserToken(userId, email) {
  const payload = `${userId}:${email}`;
  const sig = crypto.createHmac('sha256', USER_TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

function verifyUserToken(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const lastColon = decoded.lastIndexOf(':');
    const payload = decoded.slice(0, lastColon);
    const sig     = decoded.slice(lastColon + 1);
    const expected = crypto.createHmac('sha256', USER_TOKEN_SECRET).update(payload).digest('hex');
    // timing-safe compare
    const sBuf = Buffer.from(sig,      'hex');
    const eBuf = Buffer.from(expected, 'hex');
    if (sBuf.length !== eBuf.length) return null;
    if (!crypto.timingSafeEqual(sBuf, eBuf)) return null;
    const firstColon = payload.indexOf(':');
    const userId = parseInt(payload.slice(0, firstColon));
    const email  = payload.slice(firstColon + 1);
    if (!userId || !email) return null;
    return { userId, email };
  } catch { return null; }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !verifyAdminToken(token)) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

// Helper: extrai email autenticado do request (token verificado ou fallback legado)
function getAuthEmail(req) {
  const verified = verifyUserToken(req.headers['x-user-token']);
  if (verified) return verified.email;
  return req.headers['x-user-email'] || null; // fallback legado
}

// GET /api/admin/prompts/:id — retorna prompt com texto descriptografado para edição (admin only)
app.get('/api/admin/prompts/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM prompts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Prompt não encontrado' });
    const prompt = rows[0];
    if (prompt.tipo === 'pro') {
      prompt.prompt_text = decryptPrompt(prompt.prompt_text);
    }
    res.json(prompt);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/prompts-debug — mostra estado real dos prompts PRO (admin only)
app.get('/api/admin/prompts-debug', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, title, tipo, CASE WHEN prompt_text IS NULL THEN 'NULL' WHEN length(prompt_text) < 97 THEN 'PLAIN_TEXT' ELSE 'ENCRYPTED' END AS text_status, length(prompt_text) AS text_length FROM prompts WHERE tipo = 'pro' ORDER BY id`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/auth — validate admin password, return signed token
app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  res.json({ token: generateAdminToken() });
});

// GET /api/admin/verify — check if admin token is valid
app.get('/api/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token || !verifyAdminToken(token)) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  res.json({ ok: true });
});

// GET all users (admin)
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id, email, name, is_subscriber, plan, created_at,
        COALESCE(subscribed_at, NULL) AS subscribed_at,
        COALESCE(subscription_expires_at, NULL) AS subscription_expires_at
      FROM users
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ /api/users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST resend credentials email (admin only) — gera nova senha temp e envia email
app.post('/api/admin/users/:id/resend-credentials', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, plan FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    const user = rows[0];

    const plainPassword = crypto.randomBytes(5).toString('hex');
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);

    const planLabel = KIWIFY_PLANS[user.plan]?.label || 'Premium';
    await sendEmail({
      to: user.email,
      subject: '🔑 Seus dados de acesso — Prompts House',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#080b14;color:#fff;border-radius:16px;overflow:hidden">
          <div style="padding:32px;background:linear-gradient(135deg,#f59e0b,#ec4899);text-align:center">
            <h1 style="margin:0;font-size:28px;color:#08080a">Prompts House</h1>
            <p style="margin:8px 0 0;color:#08080a;opacity:.8">Seus dados de acesso</p>
          </div>
          <div style="padding:32px">
            <p style="font-size:16px">Olá, <strong>${user.name || user.email}</strong>!</p>
            <p>Sua assinatura <strong>${planLabel}</strong> está ativa. Aqui estão seus dados de acesso:</p>
            <div style="background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px;margin:20px 0">
              <p style="margin:0 0 8px"><span style="color:#9ca3af">Email:</span> <strong>${user.email}</strong></p>
              <p style="margin:0"><span style="color:#9ca3af">Senha:</span> <strong style="font-size:18px;letter-spacing:2px">${plainPassword}</strong></p>
            </div>
            <p style="color:#9ca3af;font-size:13px">Recomendamos que você troque sua senha após o primeiro login, na seção "Minha Conta".</p>
            <div style="text-align:center;margin:28px 0">
              <a href="https://promptshouse.com" style="background:linear-gradient(90deg,#f59e0b,#ec4899);color:#08080a;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px">Acessar o site →</a>
            </div>
            <hr style="border:1px solid rgba(255,255,255,.1);margin:24px 0">
            <p style="color:#6b7280;font-size:12px;text-align:center">Prompts House · Todos os direitos reservados</p>
          </div>
        </div>
      `,
    });

    console.log(`📧 Credenciais reenviadas para: ${user.email}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT reset user password (admin only)
app.put('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });
    const newHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email',
      [newHash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    console.log(`🔑 Admin resetou senha de: ${rows[0].email}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update user subscription (admin manual)
app.put('/api/users/:id/subscription', requireAdmin, async (req, res) => {
  try {
    const { is_subscriber, plan } = req.body;
    const subscribed_at = is_subscriber ? new Date() : null;
    // Ativações manuais pelo admin = acesso permanente (subscription_expires_at = NULL)
    // Nunca haverá auto-expiry pois kiwify_customer_id também é NULL nestas contas
    const expires_at = null;

    const { rows } = await pool.query(
      'UPDATE users SET is_subscriber = $1, plan = $2, subscribed_at = $3, subscription_expires_at = $4 WHERE id = $5 RETURNING *',
      [is_subscriber, plan, subscribed_at, expires_at, req.params.id]
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
    const webhookToken = process.env.KIWIFY_WEBHOOK_TOKEN;
    if (webhookToken) {
      const received = req.query.token || req.headers['x-kiwify-token'];
      if (received !== webhookToken) {
        console.log('⚠️ Webhook rejeitado: token inválido');
        return res.status(401).json({ error: 'Token inválido' });
      }
    }

    console.log('🔔 Webhook Kiwify recebido:', JSON.stringify(req.body));

    const { event, Customer: customer, Product: product, order_status, subscription_status } = req.body;

    const email = customer?.email;
    if (!email) { console.log('⚠️ Webhook sem email'); return res.json({ success: true }); }

    const isActivation  = event === 'order.paid' || order_status === 'paid' || subscription_status === 'active';
    // Reembolso = perde acesso imediatamente; cancelamento = mantém até subscription_expires_at
    const isRefund       = event === 'order.refunded' || order_status === 'refunded';
    const isCancellation = subscription_status === 'canceled';

    const subscriptionId = req.body?.Subscription?.id || req.body?.subscription?.id || null;

    if (isActivation) {
      const plan = detectPlan(product);
      const planDays = KIWIFY_PLANS[plan].days;
      const expiresAt = new Date(Date.now() + planDays * 24 * 60 * 60 * 1000);
      const name = customer?.name || email.split('@')[0];

      // Verificar se usuário já existe
      const existing = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
      const isNewUser = existing.rows.length === 0;

      // Gerar senha aleatória apenas para usuários novos
      const plainPassword = isNewUser ? crypto.randomBytes(5).toString('hex') : null;
      const passwordHash = plainPassword ? await bcrypt.hash(plainPassword, 10) : undefined;

      if (isNewUser) {
        await pool.query(
          `INSERT INTO users (email, name, password_hash, is_subscriber, plan, subscribed_at, subscription_expires_at, kiwify_customer_id, kiwify_subscription_id)
           VALUES ($1, $2, $3, true, $4, NOW(), $5, $6, $7)`,
          [email, name, passwordHash, plan, expiresAt, customer?.id, subscriptionId]
        );
      } else {
        await pool.query(
          `UPDATE users SET is_subscriber = true, plan = $1, subscribed_at = NOW(),
           subscription_expires_at = $2, kiwify_customer_id = $3, kiwify_subscription_id = $4 WHERE email = $5`,
          [plan, expiresAt, customer?.id, subscriptionId, email]
        );
      }

      console.log(`💚 Assinatura ${plan} ativada: ${email} | Expira: ${expiresAt.toISOString()}`);

      const planLabel = KIWIFY_PLANS[plan].label;

      if (isNewUser && plainPassword) {
        // Novo usuário: envia email com credenciais de acesso
        await sendEmail({
          to: email,
          subject: '🎉 Bem-vindo ao Prompts House! Aqui estão suas credenciais',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#080b14;color:#fff;border-radius:16px;overflow:hidden">
              <div style="padding:32px;background:linear-gradient(135deg,#f59e0b,#ec4899);text-align:center">
                <h1 style="margin:0;font-size:28px;color:#08080a">Prompts House</h1>
                <p style="margin:8px 0 0;color:#08080a;opacity:.8">Sua assinatura está ativa!</p>
              </div>
              <div style="padding:32px">
                <p style="font-size:16px">Olá, <strong>${name}</strong>!</p>
                <p>Sua assinatura <strong>${planLabel}</strong> foi ativada com sucesso. Aqui estão seus dados de acesso:</p>
                <div style="background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px;margin:20px 0">
                  <p style="margin:0 0 8px"><span style="color:#9ca3af">Email:</span> <strong>${email}</strong></p>
                  <p style="margin:0"><span style="color:#9ca3af">Senha:</span> <strong style="font-size:18px;letter-spacing:2px">${plainPassword}</strong></p>
                </div>
                <p style="color:#9ca3af;font-size:13px">Recomendamos que você troque sua senha após o primeiro login, na seção "Minha Conta".</p>
                <div style="text-align:center;margin:28px 0">
                  <a href="https://promptshouse.com" style="background:linear-gradient(90deg,#f59e0b,#ec4899);color:#08080a;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px">Acessar o site →</a>
                </div>
                <hr style="border:1px solid rgba(255,255,255,.1);margin:24px 0">
                <p style="color:#6b7280;font-size:12px;text-align:center">Prompts House · Todos os direitos reservados</p>
              </div>
            </div>
          `,
        });
      } else if (!isNewUser) {
        // Usuário existente: envia confirmação de ativação sem expor senha
        await sendEmail({
          to: email,
          subject: '✅ Sua assinatura Prompts House está ativa!',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#080b14;color:#fff;border-radius:16px;overflow:hidden">
              <div style="padding:32px;background:linear-gradient(135deg,#f59e0b,#ec4899);text-align:center">
                <h1 style="margin:0;font-size:28px;color:#08080a">Prompts House</h1>
                <p style="margin:8px 0 0;color:#08080a;opacity:.8">Assinatura ativada!</p>
              </div>
              <div style="padding:32px">
                <p style="font-size:16px">Olá, <strong>${name}</strong>!</p>
                <p>Sua assinatura <strong>${planLabel}</strong> foi ativada com sucesso.</p>
                <p>Acesse o site com seu email e senha habituais para desbloquear todos os prompts premium:</p>
                <div style="background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px;margin:20px 0">
                  <p style="margin:0"><span style="color:#9ca3af">Email:</span> <strong>${email}</strong></p>
                </div>
                <div style="text-align:center;margin:28px 0">
                  <a href="https://promptshouse.com" style="background:linear-gradient(90deg,#f59e0b,#ec4899);color:#08080a;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:15px">Acessar o site →</a>
                </div>
                <hr style="border:1px solid rgba(255,255,255,.1);margin:24px 0">
                <p style="color:#6b7280;font-size:12px;text-align:center">Prompts House · Todos os direitos reservados</p>
              </div>
            </div>
          `,
        });
      }
    }

    if (isRefund) {
      // Reembolso: revoga acesso imediatamente
      console.log(`💸 Reembolso — revogando acesso imediato: ${email}`);
      await pool.query(
        'UPDATE users SET is_subscriber = false, subscription_expires_at = NOW() WHERE email = $1',
        [email]
      );
    }

    if (isCancellation) {
      // Cancelamento: mantém acesso até o fim do período pago (subscription_expires_at já está definido)
      console.log(`🔕 Cancelamento — acesso mantido até expirar: ${email}`);
      await pool.query(
        'UPDATE users SET kiwify_subscription_id = NULL WHERE email = $1',
        [email]
      );
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
app.put('/api/config', requireAdmin, async (req, res) => {
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
    _cachedConfig = null; // invalida cache para próxima requisição buscar do banco

    res.json(rows[0]);
  } catch (err) {
    console.error('❌ Erro ao atualizar config:', err);
    console.error('❌ Stack:', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── Tags ─────────────────────────────────────────────────────
app.get('/api/tags', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM site_tags ORDER BY created_at ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tags', requireAdmin, async (req, res) => {
  try {
    const { name, code, position } = req.body;
    if (!name || !code || !position) return res.status(400).json({ error: 'name, code e position são obrigatórios' });
    const { rows } = await pool.query(
      'INSERT INTO site_tags (name, code, position) VALUES ($1, $2, $3) RETURNING *',
      [name, code, position]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tags/:id', requireAdmin, async (req, res) => {
  try {
    const { name, code, position, active } = req.body;
    const { rows } = await pool.query(
      'UPDATE site_tags SET name=$1, code=$2, position=$3, active=$4 WHERE id=$5 RETURNING *',
      [name, code, position, active, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tags/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM site_tags WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Config cache (server-side) ───────────────────────────────
// Injeta o config visual diretamente no HTML para eliminar o flash em novas máquinas
const fs = require('fs');
const indexHtmlPath = path.join(__dirname, 'public', 'index.html');
let _indexHtml = '';
try { _indexHtml = fs.readFileSync(indexHtmlPath, 'utf8'); } catch(e) { console.error('Erro ao ler index.html:', e.message); }

let _cachedConfig = null;
let _configCachedAt = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getConfigCached() {
  if (_cachedConfig && Date.now() - _configCachedAt < CONFIG_CACHE_TTL) return _cachedConfig;
  const { rows } = await pool.query('SELECT * FROM site_config WHERE id = 1');
  _cachedConfig = rows[0] || {};
  _configCachedAt = Date.now();
  return _cachedConfig;
}

// SPA fallback — injeta config no HTML antes de servir
app.get('*', async (req, res) => {
  try {
    const config = await getConfigCached();
    const script = `<script>window.__INITIAL_CONFIG__=${JSON.stringify(config)};</script>`;
    const html = _indexHtml.replace('</head>', script + '</head>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch(e) {
    res.sendFile(indexHtmlPath);
  }
});

// ─── Start ────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Prompt Max rodando na porta ${PORT}`));
}).catch(err => { console.error('Erro ao conectar no banco:', err); process.exit(1); });
