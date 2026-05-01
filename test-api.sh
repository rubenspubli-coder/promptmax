#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# PROMPT HOUSE — API Tests
# Usando cURL para testar todas as rotas
# ═══════════════════════════════════════════════════════════════

# ⚙️ CONFIGURAÇÕES
API_URL="https://splendid-rebirth-production-431c.up.railway.app"
# API_URL="http://localhost:3000"  # Para testes locais

# ═══════════════════════════════════════════════════════════════
# 1️⃣ TESTE: REGISTRO DE USUÁRIO
# ═══════════════════════════════════════════════════════════════

echo "🔐 Registrando novo usuário..."
REGISTER_RESPONSE=$(curl -s -X POST "$API_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "teste@prompthouse.com",
    "name": "Testador Pro",
    "password": "SenhaSegura123!"
  }')

echo "Resposta do Registro:"
echo $REGISTER_RESPONSE | jq .

# Extrair token
TOKEN=$(echo $REGISTER_RESPONSE | jq -r '.token')
USER_ID=$(echo $REGISTER_RESPONSE | jq -r '.user.id')

echo "✅ Token obtido: $TOKEN"
echo "✅ User ID: $USER_ID"

# ═══════════════════════════════════════════════════════════════
# 2️⃣ TESTE: LOGIN
# ═══════════════════════════════════════════════════════════════

echo -e "\n🔑 Fazendo login..."
LOGIN_RESPONSE=$(curl -s -X POST "$API_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "teste@prompthouse.com",
    "password": "SenhaSegura123!"
  }')

echo "Resposta do Login:"
echo $LOGIN_RESPONSE | jq .

# Usar token do login
TOKEN=$(echo $LOGIN_RESPONSE | jq -r '.token')

# ═══════════════════════════════════════════════════════════════
# 3️⃣ TESTE: BUSCAR PERFIL
# ═══════════════════════════════════════════════════════════════

echo -e "\n👤 Buscando perfil do usuário..."
curl -s -X GET "$API_URL/api/user/profile" \
  -H "Authorization: Bearer $TOKEN" | jq .

# ═══════════════════════════════════════════════════════════════
# 4️⃣ TESTE: BUSCAR ESTATÍSTICAS
# ═══════════════════════════════════════════════════════════════

echo -e "\n📊 Buscando estatísticas..."
curl -s -X GET "$API_URL/api/user/stats" \
  -H "Authorization: Bearer $TOKEN" | jq .

# ═══════════════════════════════════════════════════════════════
# 5️⃣ TESTE: ADICIONAR AOS FAVORITOS
# ═══════════════════════════════════════════════════════════════

echo -e "\n❤️ Adicionando prompt 1 aos favoritos..."
curl -s -X POST "$API_URL/api/user/favorites/1" \
  -H "Authorization: Bearer $TOKEN" | jq .

echo -e "\n❤️ Adicionando prompt 2 aos favoritos..."
curl -s -X POST "$API_URL/api/user/favorites/2" \
  -H "Authorization: Bearer $TOKEN" | jq .

# ═══════════════════════════════════════════════════════════════
# 6️⃣ TESTE: BUSCAR FAVORITOS
# ═══════════════════════════════════════════════════════════════

echo -e "\n💫 Buscando prompts favoritos..."
curl -s -X GET "$API_URL/api/user/favorites" \
  -H "Authorization: Bearer $TOKEN" | jq .

# ═══════════════════════════════════════════════════════════════
# 7️⃣ TESTE: REGISTRAR VISUALIZAÇÃO
# ═══════════════════════════════════════════════════════════════

echo -e "\n👁️ Registrando visualização do prompt 1..."
curl -s -X POST "$API_URL/api/user/history/1" \
  -H "Authorization: Bearer $TOKEN" | jq .

echo -e "\n👁️ Registrando visualização do prompt 2..."
curl -s -X POST "$API_URL/api/user/history/2" \
  -H "Authorization: Bearer $TOKEN" | jq .

echo -e "\n👁️ Registrando visualização do prompt 3..."
curl -s -X POST "$API_URL/api/user/history/3" \
  -H "Authorization: Bearer $TOKEN" | jq .

# ═══════════════════════════════════════════════════════════════
# 8️⃣ TESTE: BUSCAR HISTÓRICO
# ═══════════════════════════════════════════════════════════════

echo -e "\n📚 Buscando histórico de visualizações..."
curl -s -X GET "$API_URL/api/user/history" \
  -H "Authorization: Bearer $TOKEN" | jq .

# ═══════════════════════════════════════════════════════════════
# 9️⃣ TESTE: CRIAR ASSINATURA
# ═══════════════════════════════════════════════════════════════

echo -e "\n🎟️ Criando assinatura ANUAL..."
curl -s -X POST "$API_URL/api/subscription/create" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "plan_type": "anual"
  }' | jq .

# ═══════════════════════════════════════════════════════════════
# 🔟 TESTE: REMOVER DOS FAVORITOS
# ═══════════════════════════════════════════════════════════════

echo -e "\n💔 Removendo prompt 2 dos favoritos..."
curl -s -X DELETE "$API_URL/api/user/favorites/2" \
  -H "Authorization: Bearer $TOKEN" | jq .

echo -e "\n💫 Buscando favoritos novamente (deve ter apenas 1)..."
curl -s -X GET "$API_URL/api/user/favorites" \
  -H "Authorization: Bearer $TOKEN" | jq .

# ═══════════════════════════════════════════════════════════════
# 1️⃣1️⃣ TESTE: BUSCAR PAGAMENTOS
# ═══════════════════════════════════════════════════════════════

echo -e "\n💳 Buscando histórico de pagamentos..."
curl -s -X GET "$API_URL/api/user/payments" \
  -H "Authorization: Bearer $TOKEN" | jq .

# ═══════════════════════════════════════════════════════════════
# 1️⃣2️⃣ TESTE: GOOGLE LOGIN (Simulado)
# ═══════════════════════════════════════════════════════════════

echo -e "\n🔐 Fazendo login com Google (simulado)..."
GOOGLE_RESPONSE=$(curl -s -X POST "$API_URL/api/auth/google" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "rubens@google.com",
    "name": "Rubens Designer",
    "avatar_url": "https://example.com/avatar.jpg",
    "google_id": "123456789"
  }')

echo "Resposta do Google Login:"
echo $GOOGLE_RESPONSE | jq .

# ═══════════════════════════════════════════════════════════════
# 1️⃣3️⃣ TESTE: REQUISIÇÃO SEM TOKEN (Deve falhar)
# ═══════════════════════════════════════════════════════════════

echo -e "\n❌ Tentando acessar rota protegida SEM token (deve falhar)..."
curl -s -X GET "$API_URL/api/user/profile" | jq .

# ═══════════════════════════════════════════════════════════════
# 1️⃣4️⃣ TESTE: TOKEN INVÁLIDO (Deve falhar)
# ═══════════════════════════════════════════════════════════════

echo -e "\n❌ Tentando acessar com token inválido (deve falhar)..."
curl -s -X GET "$API_URL/api/user/profile" \
  -H "Authorization: Bearer token-invalido-xyz" | jq .

# ═══════════════════════════════════════════════════════════════
# 1️⃣5️⃣ TESTE: CONTATO
# ═══════════════════════════════════════════════════════════════

echo -e "\n💬 Enviando mensagem de contato..."
curl -s -X POST "$API_URL/api/contacts" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "contato@example.com",
    "name": "João Silva",
    "message": "Adorei o Prompt House! Sugestão: adicionar mais prompts de design."
  }' | jq .

echo -e "\n✅ Todos os testes concluídos!"
