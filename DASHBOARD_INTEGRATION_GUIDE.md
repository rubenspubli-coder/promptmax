# 📊 PROMPT HOUSE — Dashboard Integração

## 📋 Resumo do que foi implementado

### ✅ Backend (Node.js + Express + PostgreSQL)

**Novas Tabelas:**
- `users` — Perfil de usuários (email, name, avatar, google_id, etc)
- `subscriptions` — Planos ativos (free, semestral, anual, vitalicio)
- `user_favorites` — Prompts que o usuário favoritou
- `user_history` — Histórico de prompts visualizados
- `payments` — Registro de pagamentos e transações
- `contacts` — Formulário de contato (já existente)

**Novas Rotas de API:**

#### 🔐 Autenticação
- `POST /api/auth/register` — Registro com email/password
- `POST /api/auth/login` — Login com email/password
- `POST /api/auth/google` — Login com Google OAuth

#### 👤 Perfil & Dashboard
- `GET /api/user/profile` — Perfil + assinatura ativa (requer JWT)
- `GET /api/user/stats` — Estatísticas (favoritos, views, assinatura)
- `GET /api/user/favorites` — Lista de prompts favoritados
- `POST /api/user/favorites/:promptId` — Adicionar aos favoritos
- `DELETE /api/user/favorites/:promptId` — Remover dos favoritos
- `GET /api/user/history` — Histórico de visualizações
- `POST /api/user/history/:promptId` — Registrar visualização

#### 🎟️ Assinatura & Pagamentos
- `POST /api/subscription/create` — Criar assinatura (semestral/anual/vitalicio)
- `PUT /api/subscription/:id` — Atualizar status da assinatura
- `GET /api/user/payments` — Histórico de pagamentos

---

## 🚀 Passo a Passo de Implementação

### 1️⃣ Atualizar o `server.js`

**Instale as dependências necessárias:**
```bash
npm install jsonwebtoken bcryptjs
```

**Substitua o `server.js` pelo arquivo `server-updated.js` que foi criado:**
- Contém todas as rotas de auth, dashboard e subscriptions
- Cria automaticamente as tabelas ao inicializar
- Tem middlewares de JWT para proteger rotas

### 2️⃣ Variáveis de Ambiente (Railway)

Adicione ao seu `.env` na Railway:

```
JWT_SECRET=seu-super-secret-key-aleatorio-e-seguro
DATABASE_URL=postgresql://...
CLOUDINARY_CLOUD_NAME=dx6uxrr6s
CLOUDINARY_API_KEY=637614521198185
CLOUDINARY_API_SECRET=ZP6GcJf1rWU6RXFEoz50vjX2GM4
NODE_ENV=production
```

> ⚠️ **IMPORTANTE:** Gere uma JWT_SECRET aleatória e segura! Use:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 3️⃣ Integrar o Componente React

**Copie os arquivos para seu projeto:**

```
src/
  ├── components/
  │   ├── Dashboard.jsx        ← Copiar Dashboard.jsx
  │   └── Dashboard.css        ← Copiar Dashboard.css
  └── pages/
      ├── App.jsx              ← Modificar
      └── Home.jsx
```

**No seu `App.jsx`, adicione a lógica de roteamento:**

```jsx
import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import Home from './pages/Home';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('authToken'));
  const [user, setUser] = useState(null);

  useEffect(() => {
    if (token) {
      // Verificar se token é válido
      fetch('/api/user/profile', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) setUser(data.user);
        else handleLogout();
      })
      .catch(() => handleLogout());
    }
  }, [token]);

  const handleLogin = (newToken) => {
    setToken(newToken);
    localStorage.setItem('authToken', newToken);
  };

  const handleLogout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('authToken');
  };

  // Se tem token, mostra dashboard
  if (token && user) {
    return <Dashboard token={token} onLogout={handleLogout} />;
  }

  // Senão, mostra home com modal de auth
  return <Home onLogin={handleLogin} />;
}
```

### 4️⃣ Atualizar Modal de Auth (Home.jsx)

Seu modal de login precisa agora fazer requisições reais:

```jsx
const handleLogin = async (email, password) => {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (res.ok) {
      const { token, user } = await res.json();
      onLogin(token);  // Passa token pro App.jsx
    } else {
      const error = await res.json();
      alert('Erro: ' + error.error);
    }
  } catch (err) {
    alert('Erro ao fazer login: ' + err.message);
  }
};

const handleRegister = async (email, name, password) => {
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, password })
    });

    if (res.ok) {
      const { token, user } = await res.json();
      onLogin(token);
    } else {
      const error = await res.json();
      alert('Erro: ' + error.error);
    }
  } catch (err) {
    alert('Erro ao registrar: ' + err.message);
  }
};

const handleGoogleLogin = async (googleUser) => {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: googleUser.email,
        name: googleUser.name,
        avatar_url: googleUser.picture,
        google_id: googleUser.sub
      })
    });

    if (res.ok) {
      const { token, user } = await res.json();
      onLogin(token);
    } else {
      alert('Erro ao fazer login com Google');
    }
  } catch (err) {
    alert('Erro: ' + err.message);
  }
};
```

### 5️⃣ Registrar Visualizações (ao ver um prompt)

Quando o usuário clica em um prompt para ver detalhes:

```jsx
useEffect(() => {
  if (token && promptId) {
    // Registrar visualização
    fetch(`/api/user/history/${promptId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    }).catch(err => console.error(err));
  }
}, [token, promptId]);
```

### 6️⃣ Favoritos (nos cards de prompts)

```jsx
const handleToggleFavorite = async (promptId, isFavorited) => {
  if (!token) {
    alert('Faça login para adicionar aos favoritos');
    return;
  }

  const method = isFavorited ? 'DELETE' : 'POST';
  const res = await fetch(`/api/user/favorites/${promptId}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (res.ok) {
    // Atualizar UI
  }
};
```

---

## 🎨 Customizações do Dashboard

### Cores & Tema
Todos os estilos usam CSS Variables. Para mudar cores, edite `Dashboard.css`:

```css
:root {
  --primary-amber: #f59e0b;    /* Amarelo quente */
  --primary-pink: #ec4899;      /* Rosa vibrante */
  --primary-purple: #a855f7;    /* Roxo elétrico */
  --primary-dark: #0f172a;      /* Fundo escuro */
}
```

### Planos de Assinatura
Para ajustar preços e features, edite a seção de planos em `Dashboard.jsx`:

```javascript
const prices = {
  semestral: 47,    // ← Mude aqui
  anual: 77,        // ← Mude aqui
  vitalicio: 197    // ← Mude aqui
};
```

---

## 📈 Fluxo de Dados

```
┌─────────────────┐
│  Usuário (UI)   │
└────────┬────────┘
         │
         ├─→ Clica "Entrar" → POST /api/auth/login → JWT Token
         ├─→ Clica em Prompt → POST /api/user/history/:id → Registra view
         ├─→ Clica ❤️ → POST /api/user/favorites/:id → Salva favorito
         └─→ Acessa Dashboard → GET /api/user/profile → Mostra dados
         
┌─────────────────┐
│   Node.js API   │
└────────┬────────┘
         │
         ├─→ Verifica JWT (verifyToken middleware)
         ├─→ Consulta PostgreSQL
         ├─→ Retorna dados estruturados
         └─→ Registra no banco
         
┌─────────────────┐
│  PostgreSQL DB  │
└─────────────────┘
```

---

## 🔐 Segurança

### JWT Token
- ✅ Valida em cada requisição protegida
- ✅ Expira em 30 dias
- ✅ Armazenado no localStorage (pode melhorar com httpOnly cookies)

### Senhas
- ✅ Hash com bcryptjs (10 rounds)
- ✅ Nunca são retornadas nas respostas da API
- ✅ Comparação segura com bcrypt.compare()

### CORS
- ✅ Habilitado com `cors()` middleware
- ✅ Restrinja domínios em produção: `cors({ origin: 'https://seu-dominio.com' })`

---

## ⚡ Próximos Passos Sugeridos

1. **Integração de Pagamento (Stripe/Mercado Pago)**
   - Criar endpoint `/api/subscription/checkout`
   - Webhook para confirmar pagamento
   - Atualizar status de assinatura

2. **Email Verification**
   - Enviar email de confirmação ao registrar
   - Verificar email antes de ativar conta

3. **Reset de Senha**
   - POST `/api/auth/forgot-password`
   - POST `/api/auth/reset-password`

4. **Avatar Upload**
   - Adicionar upload de avatar na seção de perfil
   - Usar Cloudinary igual aos prompts

5. **Analytics**
   - Dashboard admin para ver estatísticas gerais
   - Quais prompts mais populares
   - Quantos usuários por plano

6. **Notificações**
   - Email quando novo prompt é adicionado
   - Push notification quando assinatura vai expirar

---

## 🐛 Troubleshooting

### "Token inválido" após login
- Verifique se JWT_SECRET está set no `.env`
- Reinicie a aplicação após mudar JWT_SECRET

### "Erro ao conectar no banco"
- Verifique DATABASE_URL na Railway
- Teste conexão: `psql $DATABASE_URL`

### CORS bloqueando requisições
- Certifique-se que `cors()` está no topo do middleware
- Se está em HTTPS na produção, também use HTTPS na API

### Google OAuth não funciona
- Verifique se o redirect_uri está cadastrado no Google Cloud Console
- Teste no localhost primeiro antes de produção

---

## 📞 Estrutura Pronta Para Usar

Você tem tudo agora:
- ✅ Backend completo com autenticação JWT
- ✅ 5 novas tabelas no PostgreSQL
- ✅ 13+ novas rotas de API
- ✅ React Dashboard pronto para integrar
- ✅ Design cinematográfico com glassmorphism
- ✅ Responsivo (mobile, tablet, desktop)

Quer que eu ajude com mais algum detalhe da integração? 🚀
