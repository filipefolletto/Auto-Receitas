# Caldo & Cozinha — Gerador de Receitas

Site estático + uma API no Cloudflare Worker. Descreva o prato e receba a
receita inteira: ingredientes com medida, modo de preparo em passos, dicas de
cozinha e estimativas nutricionais.

**Custo: $0.** Plano gratuito do Cloudflare Workers (sem cartão de crédito) +
camada gratuita do Gemini. Nenhum servidor para manter.

---

## Estrutura

```
index.html              o APP (gerador de receitas)
guide.html              o STYLE GUIDE (era o index.html antes)
assets/guide.css        tokens de design + componentes de produto (compartilhado)
assets/guide.js         comportamentos do style guide (copiar, tema, tabs)
assets/app.css          estilos só do app (complementa o guide.css)
assets/app.js           lógica do app (form, chamada à API, favoritos, cota)
worker/index.js         a API: chave da IA, cache, cota e cascata de provedores
worker/schema.sql       schema do D1 (cache + cota diária)
wrangler.toml           configuração de deploy do Worker
.assetsignore           o que NÃO vai para o estático público
```

O app é HTML/CSS/JS puro. Não há build, bundler, npm install nem framework.

---

## Rodar localmente

### Só a interface (sem API)

Abra `index.html` no navegador. O formulário, os favoritos, o tema e o
redimensionamento de porções funcionam. A geração, não: sem backend, a API
responde erro.

### Com a API (precisa de Node.js)

O `wrangler` roda em Node. Instale o Node LTS (gratuito) e:

```bash
npm install -g wrangler
wrangler login

# 1. cria o banco D1 (anote o database_id)
wrangler d1 create caldo

# 2. cole o database_id no wrangler.toml

# 3. cria as tabelas
wrangler d1 execute caldo --remote --file=./worker/schema.sql

# 4. guarda a chave da IA fora do código
wrangler secret put GEMINI_API_KEY

# 5. sobe o servidor local
wrangler dev
```

Aí o app fica em `http://localhost:8787`. Se quiser testar o `index.html`
aberto direto do disco, aponte o front-end para o servidor local:

```
index.html?api=http://localhost:8787/api
```

---

## Deploy (tudo de graça)

```bash
wrangler d1 execute caldo --remote --file=./worker/schema.sql
wrangler secret put GEMINI_API_KEY
wrangler deploy
```

O Worker serve o site estático e a API na mesma URL. Sem Node, dá para fazer
pelo painel do Cloudflare: **Workers & Pages → Create → Workers → Edit code**,
colar o `worker/index.js` e associar o D1 em *Bindings*.

> O D1 é obrigatório. Sem ele o site até abre, mas roda sem cache e **sem
> cota** — ou seja, qualquer um pode queimar a cota gratuita da sua chave.

---

## As chaves

| Segredo | Onde nasce | Para quê | Custo |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | modelo principal (`gemini-3.8-flash`) | $0 no plano gratuito |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com/keys) | reserva #1 (`openai/gpt-oss-120b`) | $0 |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | reserva #2 (modelos `:free`) | $0 |

Só o primeiro é obrigatório. Os outros dois entram na cascata automaticamente
se estiverem definidos — se o Gemini estiver fora do ar ou estourar a cota, o
Worker tenta o próximo sem você hacer nada.

A chave vive **só** nos segredos do Worker. O navegador nunca vê a chave.

---

## Como a API se comporta

```
POST /api/recipes
{
  "dish": "frango com cream de abóbora",
  "diet": ["sem lactose"],
  "difficulty": "Fácil",
  "servings": 4,
  "maxMinutes": 45,
  "equipment": "Fogão",
  "notes": "sem glúten"
}

→ 200
{
  "recipe": { "title": "...", "ingredients": [...], "steps": [...], ... },
  "provider": "gemini",
  "model": "gemini-3.8-flash",
  "cache": "miss",
  "quota": { "used": 1, "limit": 20, "remaining": 19 }
}
```

```
GET /api/health
→ 200
{
  "ok": true,
  "providers": ["gemini"],
  "database": true,
  "quota": { "used": 1, "limit": 20, "remaining": 19 }
}
```

### Cache

O pedido normalizado vira um hash SHA-256 e vira chave no D1. A mesma busca
(checando porções, dificuldade e tempo) devolve o JSON guardado em milissegundos
e **não gasta token nem cota**. Só geração nova consome cota.

### Cota

`MAX_RECIPES_PER_DAY` (padrão 20) gerações reais por IP por dia, em UTC.
Cache não conta. Quando acaba, a API responde `429` com uma mensagem clara.

### Cascata de provedores

1. **Gemini** (`gemini-3.8-flash`) — JSON Schema via `responseJsonSchema`.
   Se o endpoint recusar o campo, o Worker refaz com o subconjunto OpenAPI
   (`responseSchema`) e, se ainda assim falhar, sem schema — extraindo o JSON
   do texto. Três chances de dar certo.
2. **Groq** (`openai/gpt-oss-120b`) — `response_format: json_schema`.
3. **OpenRouter** (modelos `:free`) — `response_format: json_schema`.

---

## Valores nutricionais

As calorias, proteínas, carboidratos e gorduras são **estimativas geradas por
IA**, não dados de tabela nutricional. A interface diz isso na tela. Para dieta
clínica, confirme com um nutricionista.

---

## Limites honestos do plano gratuito

- **O Gemini usa seu conteúdo para melhorar produtos do Google** no plano
  gratuito. Se isso for um problema, use as chaves do Groq/OpenRouter ou um
  plano pago.
- As cotas por minuto/dia do Gemini variam por tier e aparecem em
  [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit). O
  Worker não consegue augmenter isso — mas a cascata cobre a queda.
- OpenRouter sem créditos limita modelos `:free` a ~20 req/min e ~50 req/dia.
- Workers Free: 100.000 requests/dia. D1 Free: 5 milhões de linhas lidas/dia,
  100 mil escritas/dia, 5 GB. Estáticos: ilimitados e grátis.
- O Wrangler é uma ferramenta Node. Se você não quiser instalar Node, o deploy
  pelo painel do Cloudflare funciona igual.

---

## Convenções de código

| Prefixo | Significado |
| --- | --- |
| `.sg-` | chrome do style guide (nav, blocos de demo, swatches) |
| sem prefixo | componentes do produto (`.btn`, `.card`, `.input`, `.badge`…) |
| `.result-*`, `.gen-*`, `.app-*` | componentes do app, em `assets/app.css` |

Regra do design system: **nenhum hex solto no CSS**. Se faltar um valor, ele
nasce como token em `assets/guide.css` primeiro.
