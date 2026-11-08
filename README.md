# Saborê — Gerador de Receitas

Site estático + uma API no Cloudflare Worker. Cozinhe com o que tem: descreva o
prato e receba a receita inteira — ingredientes com medida, modo de preparo em
passos, dicas de cozinha e estimativas nutricionais.

**Custo: $0.** Plano gratuito do Cloudflare Workers (sem cartão de crédito) +
camada gratuita do Gemini. Nenhum servidor para manter.

---

## Estrutura

```
index.html              o APP (gerador de receitas)
assets/guide.css        tokens, reset, tipografia base e componentes em uso
assets/app.css          estilos só do app (complementa o guide.css)
assets/app.js           lógica do app (form, chamada à API, favoritos, cota)
assets/favicon.svg      ícone da marca (tomate de chef)
assets/og.png           card de compartilhamento (1200×630)
worker/index.js         a API: chave da IA, cache, cota e cascata de provedores
worker/schema.sql       schema do D1 (cache + cota diária)
wrangler.toml           configuração de deploy do Worker
.assetsignore           o que NÃO vai para o estático público
```

O app é HTML/CSS/JS puro. Não há build, bundler, npm install nem framework.

---

## Design system

Tudo vive em `assets/guide.css`, na seção `1. TOKENS`. A identidade segue o
style guide **Saborê** (Erva, Tomate e Açafrão). Regra do projeto:
**nenhum hex solto no CSS** — se faltar um valor, ele nasce como token primeiro.

### Cores

| Papel | Token | Claro | Escuro |
| --- | --- | --- | --- |
| Primária (ações, marca) | `--primary` | `--green-500` `#28594C` | `--green-300` `#82C4B3` |
| Secundária (destaques) | `--secondary` | `--coral-700` `#BA3517` | `--coral-300` `#EB9784` |
| Tomate (marca, blocos) | `--coral-500` | `#E85D3F` | — |
| Acento (tags, "Surpreenda-me") | `--accent` | `--gold-500` `#F6C453` | `--gold-300` `#F4D48B` |
| Fundo | `--bg` | `--cream` `#F7F3E8` | `#141A18` |
| Superfície | `--surface` | `--sand-0` `#FFFDF8` | `#1A221F` |
| Texto | `--text` | `--ink` `#1F2824` | `#F1EEE7` |

Quatro rampas de marca, geradas em HSL a partir das cores do guia:
`--green-*` (H164), `--coral-*` (H11), `--gold-*` (H42) e `--sand-*` (H44,
neutro de superfície). **Só os passos que o produto usa estão declarados** —
a rampa não é um catálogo, é o conjunto de valores em circulação. Quando um
estado novo precisar de um tom, o passo nasce em `guide.css` antes de ser
usado (regra do hex solto).

No tema escuro o fundo vira `#141A18`, as superfícies ganham tom verde e o
primário **sobe de tom** (`green-300`) com texto `--ink`: branco sobre
`green-400` dava só 3,23:1 e reprovava na WCAG.

### Tipografia

| Uso | Família | Peso |
| --- | --- | --- |
| Display (títulos, números) | Fraunces | 700 em h1/h2 · 600 em h3/h4 |
| Interface (tudo o mais) | Manrope | 400 |
| Botões, labels, destaques | Manrope | 600 |
| Dados importantes (quantidades, stats, badges) | Manrope / Fraunces | 700 |

Só existem três pesos — `--fw-regular` (400), `--fw-medium` (600) e
`--fw-bold` (700). O 500 foi removido: texto corrido é 400, e nada de
intermediário.

### Acessibilidade

Todos os pares de texto/fundo passam em **4,5:1** (WCAG AA) nos dois temas —
verificado por script, não no olho. Casos que exigiram token novo:

- `--accent-text` (`gold-900`): o dourado sobre fundo dourado dava 1,62:1.
  Serve para texto de acento; `--accent` continua sendo o dourado de fundo.
- `--on-primary` muda com o tema (branco no claro, `--ink` no escuro).
- `--on-danger` faz o mesmo para o toast de erro: branco sobre `#A8371F`
  (6,50:1) no claro e `--ink` sobre `#EE8B7E` (6,22:1) no escuro.


---

## Rodar localmente

### Só a interface (sem API)

Abra `index.html` no navegador. O formulário, os favoritos, o tema e o
redimensionamento de porções funcionam. A geração, não: sem backend, a API
responde erro.

### Com a API (precisa de Node.js)

O `wrangler` roda em Node. Instale o Node LTS (gratuito) e use via
`npx wrangler` (ou `npm install -g wrangler`):

```bash
wrangler login

# 1. schema no D1 local (cache e cota no dev)
wrangler d1 execute Auto-receitas --local --file=./worker/schema.sql

# 2. chave local: crie .dev.vars (fora do git) com
#    GEMINI_API_KEY=sua-chave

# 3. sobe o servidor local
wrangler dev
```

Aí o app fica em `http://localhost:8787`. Se quiser testar o `index.html`
aberto direto do disco, aponte o front-end para o servidor local:

```
index.html?api=http://localhost:8787/api
```

---

## Deploy (tudo de graça)

O Worker serve o site estático e a API na mesma URL. O caminho recomendado é o
`wrangler`, que precisa de Node.js. No Windows:

```bash
winget install OpenJS.NodeJS.LTS
```

> Se o PowerShell bloquear `npx`/`wrangler` por execution policy, use
> `npx.cmd`/`wrangler.cmd` no lugar.

### 1. Banco D1

O projeto usa o banco **Auto-receitas**, já criado e ligado em `wrangler.toml`.
Aplique o schema:

```bash
wrangler d1 execute Auto-receitas --remote --file=./worker/schema.sql
```

Para recriar do zero: `wrangler d1 create Auto-receitas`, copie o novo
`database_id` para `wrangler.toml` e rode o comando acima.

### 2. Segredos

```bash
wrangler secret put GEMINI_API_KEY       # obrigatório
wrangler secret put GROQ_API_KEY         # opcional (reserva)
wrangler secret put OPENROUTER_API_KEY   # opcional (reserva)
```

### 3. URL pública

O `wrangler.toml` já aponta para a URL publicada:

```toml
PUBLIC_URL = "https://sabore.filipefolletto.workers.dev"
```

Serve para o `HTTP-Referer`/`X-Title` do OpenRouter. O `og:image` também já
usa essa URL absoluta.

### 4. Publicar

```bash
wrangler deploy
```

O `wrangler` publica `index.html`, `assets/` e o Worker juntos. Confira com
`GET /api/health` na URL publicada.

> **Sem Node?** Dá para publicar só a API pelo painel (**Workers & Pages →
> Create → Workers → Edit code**: colar `worker/index.js`, associar o D1 em
> *Bindings* e cadastrar o segredo em *Settings → Variables*). Mas o painel não
> envia a pasta `assets/`; para o site completo, use o `wrangler`.

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
Worker tenta o próximo sem você fazer nada.

A chave vive **só** nos segredos do Worker. O navegador nunca vê a chave.

---

## Como a API se comporta

```
POST /api/recipes
{
  "dish": "frango com creme de abóbora",
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
  Worker não consegue aumentar isso — mas a cascata cobre a queda.
- OpenRouter sem créditos limita modelos `:free` a ~20 req/min e ~50 req/dia.
- Workers Free: 100.000 requests/dia. D1 Free: 5 milhões de linhas lidas/dia,
  100 mil escritas/dia, 5 GB. Estáticos: ilimitados e grátis.
- O Wrangler é uma ferramenta Node. Se você não quiser instalar Node, o deploy
  pelo painel do Cloudflare funciona igual.

---

## Convenções de código

| Prefixo | Significado |
| --- | --- |
| sem prefixo | componentes do produto (`.btn`, `.card`, `.input`, `.badge`…) |
| `.result-*`, `.gen-*`, `.hero`, `.brand`, `.page-head` | componentes do app, em `assets/app.css` |

O `guide.css` só contém o que o app renderiza: nenhum componente de catálogo,
nenhum token sem uso. Se um componente novo for necessário, ele entra aqui
antes de aparecer na tela.

Regra do design system: **nenhum hex solto no CSS**. Se faltar um valor, ele
nasce como token em `assets/guide.css` primeiro.
