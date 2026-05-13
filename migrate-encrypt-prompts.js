#!/usr/bin/env node
/**
 * MIGRATION SCRIPT: Encrypt existing PRO prompts in database
 * 
 * Run this ONCE after deploying the encryption feature
 * Usage: node migrate-encrypt-prompts.js
 */

const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

// ─── ENCRYPTION CONFIG (same as server.js) ───────────────────
const ENCRYPTION_KEY = process.env.PROMPT_ENCRYPTION_KEY || 'your-32-character-secret-key-here-change-this-in-production!!';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

function getKey(salt) {
  return crypto.pbkdf2Sync(ENCRYPTION_KEY, salt, 100000, 32, 'sha512');
}

function encryptPrompt(text) {
  if (!text) return null;
  
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey(salt);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  const result = Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
  return result;
}

// Check if text is already encrypted (base64 format)
function isAlreadyEncrypted(text) {
  if (!text) return false;
  // Encrypted text is base64 and much longer
  return text.length > 200 && /^[A-Za-z0-9+/]+=*$/.test(text);
}

// ─── DATABASE CONNECTION ──────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function migrateEncryptPrompts() {
  try {
    console.log('🔄 Starting PRO prompts encryption migration...\n');
    
    // Get all PRO prompts
    const { rows } = await pool.query(`
      SELECT id, title, prompt_text 
      FROM prompts 
      WHERE tipo = 'pro'
    `);
    
    console.log(`📊 Found ${rows.length} PRO prompts\n`);
    
    if (rows.length === 0) {
      console.log('✅ No PRO prompts to encrypt');
      return;
    }
    
    let encrypted = 0;
    let skipped = 0;
    
    for (const prompt of rows) {
      // Check if already encrypted
      if (isAlreadyEncrypted(prompt.prompt_text)) {
        console.log(`⏭️  SKIP #${prompt.id} "${prompt.title}" - Already encrypted`);
        skipped++;
        continue;
      }
      
      console.log(`🔐 Encrypting #${prompt.id} "${prompt.title}"...`);
      
      // Encrypt the prompt_text
      const encryptedText = encryptPrompt(prompt.prompt_text);
      
      // Update in database
      await pool.query(
        'UPDATE prompts SET prompt_text = $1 WHERE id = $2',
        [encryptedText, prompt.id]
      );
      
      console.log(`   ✅ Encrypted: ${prompt.prompt_text.substring(0, 50)}...`);
      console.log(`   📦 Stored as: ${encryptedText.substring(0, 50)}...\n`);
      
      encrypted++;
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 MIGRATION SUMMARY:');
    console.log('='.repeat(60));
    console.log(`✅ Encrypted: ${encrypted} prompts`);
    console.log(`⏭️  Skipped:   ${skipped} prompts (already encrypted)`);
    console.log(`📝 Total:     ${rows.length} PRO prompts`);
    console.log('='.repeat(60));
    console.log('\n🎉 Migration completed successfully!\n');
    
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

// Run migration
migrateEncryptPrompts()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
