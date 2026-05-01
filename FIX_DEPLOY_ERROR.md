# 🔧 FIX Deploy Error - Railway

## ❌ Erro Encontrado

```
npm error notarget No matching version found for jsonwebtoken@^9.1.0
```

## ✅ Solução

O problema é na versão do **jsonwebtoken**. A versão `9.1.0` não existe no npm.

### Opção 1: Usar o package.json corrigido ⭐ (RECOMENDADO)

1. **Baixe o `package.json` atualizado**
2. **Substitua o anterior no seu projeto:**
   ```bash
   cp package.json seu-projeto-prompthouse/
   ```
3. **Faça commit e push:**
   ```bash
   git add package.json
   git commit -m "fix: corrigir versão jsonwebtoken para 9.0.2"
   git push origin main
   ```
4. **Railway faz redeploy automaticamente**

A mudança foi:
```diff
- "jsonwebtoken": "^9.1.0"
+ "jsonwebtoken": "^9.0.2"
```

---

### Opção 2: Deletar node_modules e package-lock.json (ALTERNATIVA)

Se você quiser manter a versão anterior:

```bash
# No seu projeto local
rm -rf node_modules
rm package-lock.json

# Instale novamente
npm install

# Commit
git add package.json package-lock.json
git commit -m "reinstall: atualizar lock file"
git push origin main
```

---

### Opção 3: Usar versão LTS do jsonwebtoken

Se quiser uma versão mais estável:

```json
"jsonwebtoken": "^8.5.1"
```

Mas a **Opção 1 é a melhor** - versão 9.0.2 é estável e atual.

---

## 🚀 Próximos Passos

1. **Use o package.json corrigido**
2. **Faça push para o GitHub**
3. **Aguarde Railway refazer o build** (2-5 minutos)
4. **Verifique os logs:** Deployments → Ver logs completos

---

## ✅ Como Verificar se Funcionou

Depois que o deploy terminar:

```bash
# Teste a API
curl https://splendid-rebirth-production-431c.up.railway.app/api/stats

# Deve retornar:
{"total":5,"free":3,"pro":2,"views":42400}
```

---

## 📋 Checklist

- [ ] Baixei o package.json corrigido
- [ ] Copiei para meu projeto
- [ ] Fiz `git add`, `git commit`, `git push`
- [ ] Aguardei o deploy (2-5 min)
- [ ] Verifiquei os logs do Railway
- [ ] Testei a API com curl/Postman

---

## 🆘 Se ainda não funcionar

1. **Clique em "Diagnose"** no painel do Railway
2. **Verifique os logs completos**
3. **Procure por:**
   - `npm ERR` (erro do npm)
   - `DATABASE_URL` (variável faltando?)
   - `ENOENT` (arquivo faltando?)

---

**Está tudo certo agora! Deixa rodar e me avisa se funcionar! 🚀**
