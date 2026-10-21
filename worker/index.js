/**
 * ============================================================================
 *  Caldo & Cozinha — API do Gerador de Receitas
 *  Cloudflare Worker (plano Free) + D1 (cache de receitas + cota diária)
 *
 *  O que este Worker faz:
 *   1. guarda a chave da IA fora do navegador (segredo do Worker);
 *   2. limita quantas receitas cada IP pode GERAR por dia (cache não conta);
 *   3. cacheia por hash do pedido — a mesma busca devolve o mesmo JSON e
 *      não gasta token nenhum;
 *   4. cascata de provedores gratuitos: Gemini -> Groq -> OpenRouter;
 *   5. normaliza a resposta do modelo antes de devolver (defensive, no schema).
 *
 *  Nenhuma dependência externa. Nada de npm. Só JavaScript padrão.
 * ============================================================================
 */

/* -------------------------------------------------------------------------- */
/*  CONSTANTES                                                                 */
/* -------------------------------------------------------------------------- */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

const CACHE_TTL_DAYS = 30;

/**
 * Schema da receita. É enviado como JSON Schema para o Gemini e como
 * `json_schema` para os provedores OpenAI-compatible.
 */
const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Nome do prato. Curto e apetitoso.' },
    description: { type: 'string', description: 'Uma ou duas frases sobre o prato.' },
    emoji: { type: 'string', description: 'Um único emoji que represente o prato.' },
    servings: { type: 'integer', description: 'Quantas porções a receita rende.' },
    prepMinutes: { type: 'integer' },
    cookMinutes: { type: 'integer' },
    totalMinutes: { type: 'integer' },
    difficulty: { type: 'string', enum: ['Fácil', 'Média', 'Desafio'] },
    cuisine: { type: 'string', description: 'Cozinha de referência. Ex.: Mineira, Italiana, Brasileira.' },
    calories: { type: 'integer', description: 'Calorias estimadas por porção.' },
    proteinGrams: { type: 'integer' },
    carbsGrams: { type: 'integer' },
    fatGrams: { type: 'integer' },
    ingredients: {
      type: 'array',
      description: 'Lista de ingredientes com medida.',
      items: {
        type: 'object',
        properties: {
          quantity: { type: 'string', description: 'Medida. Ex.: "2 xícaras", "1 colher (sopa)", "300 g".' },
          name: { type: 'string', description: 'Nome do ingrediente.' },
          note: { type: 'string', description: 'Detalhe opcional. Ex.: "em cubos", "sem pele".' }
        },
        required: ['quantity', 'name']
      }
    },
    steps: {
      type: 'array',
      description: 'Modo de preparo, em ordem.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Nome curto do passo. Ex.: "Refogar a cebola".' },
          durationMinutes: { type: 'integer' },
          description: { type: 'string', description: 'O passo em si, no imperativo.' }
        },
        required: ['description']
      }
    },
    tips: { type: 'array', description: '2 a 4 dicas práticas de cozinha.', items: { type: 'string' } },
    tags: { type: 'array', description: 'Até 4 tags curtas. Ex.: "rápido", "vegetariano".', items: { type: 'string' } }
  },
  required: [
    'title', 'description', 'emoji', 'servings', 'prepMinutes', 'cookMinutes',
    'totalMinutes', 'difficulty', 'cuisine', 'calories', 'proteinGrams',
    'carbsGrams', 'fatGrams', 'ingredients', 'steps', 'tips', 'tags'
  ]
};

/**
 * Instrução de sistema. Vai em português do Brasil e define o "jeito de pensar"
 * do chef — o resto (quantas porções, restrições) vai no prompt do usuário.
 */
const SYSTEM_PROMPT = [
  'Você é um chef de cozinha brasileiro, formado em cozinha profissional e',
  'treinado para escrever receitas que uma pessoa comum executa em casa, com o',
  'que tem na dispensa e sem equipamento caro.',
  '',
  'Regras:',
  '1. Responda SEMPRE em português do Brasil, com tom acolhedor e direto.',
  '2. Devolva SOMENTE o JSON do schema. Nenhum texto antes ou depois, sem markdown.',
  '3. Ingredientes: use medidas reais da cozinha brasileira ("2 xícaras",',
  '   "1 colher (sopa)", "300 g"), sempre com o nome do ingrediente depois.',
  '4. As quantidades têm de render exatamente o número de porções pedido.',
  '   Multiplique de verdade, não chute.',
  '5. Modo de preparo: entre 5 e 9 passos, no imperativo e curtos',
  '   ("Leve a panela ao fogo médio"). Diga temperatura ou tempo quando',
  '   importarem para o resultado.',
  '6. Dicas: 2 a 4 dicas práticas que evitem erro comum (ponto da carne,',
  '   temperatura do forno, descanso da massa, sal na hora certa).',
  '7. Valor nutricional: é uma ESTIMATIVA por porção. Use números redondos e',
  '   realistas. Não invente preciseza.',
  '8. Não cite marcas, não inclua links, não invente fontes.'
].join('\n');

/* -------------------------------------------------------------------------- */
/*  ERROS                                                                      */
/* -------------------------------------------------------------------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ProviderError extends Error {
  constructor(provider, status, detail) {
    super(`${provider}: ${detail}`);
    this.provider = provider;
    this.status = status;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/*  ENTRYPOINT                                                                 */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    // Estáticos (index.html, guide.html, assets/…) — servidos pelo próprio
    // Workers Assets. O Worker só é acionado quando não há arquivo.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return text('Não encontrado', 404);
  }
};

/* -------------------------------------------------------------------------- */
/*  ROTEAMENTO                                                                 */
/* -------------------------------------------------------------------------- */

async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }

  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') return cors(json({ error: 'Método não permitido.' }, 405));
    return cors(json(await health(env, request)));
  }

  if (url.pathname === '/api/recipes') {
    if (request.method !== 'POST') return cors(json({ error: 'Método não permitido.' }, 405));
    return cors(await generate(request, env));
  }

  return cors(json({ error: 'Rota não encontrada.' }, 404));
}

/* -------------------------------------------------------------------------- */
/*  GET /api/health                                                            */
/* -------------------------------------------------------------------------- */

async function health(env, request) {
  const client = clientId(request);
  const day = utcDay();
  const quota = await readQuota(env, client, day);

  return {
    ok: true,
    service: 'caldo-e-cozinha',
    model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    // só diz QUEM está configurado, nunca a chave
    providers: providerIds(env),
    database: Boolean(env.DB),
    quota: quota,
    limits: {
      maxMinutes: 180,
      maxServings: 12,
      cacheTtlDays: CACHE_TTL_DAYS
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  POST /api/recipes                                                          */
/* -------------------------------------------------------------------------- */

async function generate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: 'Corpo da requisição inválido — JSON esperado.' }, 400);
  }

  let input;
  try {
    input = parseInput(body);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    throw err;
  }

  const hash = await sha256(canonical(input));
  const client = clientId(request);
  const day = utcDay();

  // 1) CACHE — de graça, não gasta cota nem token.
  const cached = await readCache(env, hash);
  if (cached) {
    const quota = await readQuota(env, client, day);
    return json({
      recipe: cached.recipe,
      provider: cached.provider,
      model: cached.model,
      cache: 'hit',
      quota: quota
    });
  }

  // 2) COTA — só conta geração de verdade.
  const before = await readQuota(env, client, day);
  if (before.limit > 0 && before.used >= before.limit) {
    return json({
      error: `Você usou as ${before.limit} receitas de hoje. A cota renova amanhã.`,
      quota: { used: before.used, limit: before.limit, remaining: 0 }
    }, 429);
  }

  // 3) GERAÇÃO — cascata de provedores gratuitos.
  const prompt = buildPrompt(input);
  const failures = [];

  for (const id of providerIds(env)) {
    try {
      const result = await PROVIDERS[id](env, prompt);
      if (!result) continue;

      const recipe = normalizeRecipe(result.recipe, input);

      await writeCache(env, hash, recipe, result.provider, result.model);
      await bumpQuota(env, client, day);

      const quota = await readQuota(env, client, day);
      return json({
        recipe: recipe,
        provider: result.provider,
        model: result.model,
        cache: 'miss',
        quota: quota
      });
    } catch (err) {
      failures.push({
        provider: id,
        status: err instanceof ProviderError ? err.status : 0,
        detail: err instanceof ProviderError ? err.detail : String(err && err.message || err)
      });
    }
  }

  // Nenhum provedor respondeu.
  const hasKeys = providerIds(env).length > 0;
  return json({
    error: hasKeys
      ? 'Nenhum provedor de IA respondeu agora. Tente de novo em instantes.'
      : 'A API ainda não foi configurada. O dono do projeto precisa criar o segredo GEMINI_API_KEY no Worker.',
    failures: failures
  }, 502);
}

/* -------------------------------------------------------------------------- */
/*  PROVEDORES                                                                 */
/* -------------------------------------------------------------------------- */

/** Ordem de tentativa. Cada um só entra se tiver chave configurada. */
const PROVIDERS = {
  gemini: callGemini,
  groq: callGroq,
  openrouter: callOpenRouter
};

function providerIds(env) {
  const ids = [];
  if (env.GEMINI_API_KEY) ids.push('gemini');
  if (env.GROQ_API_KEY) ids.push('groq');
  if (env.OPENROUTER_API_KEY) ids.push('openrouter');
  return ids;
}

/**
 * Gemini — REST direto, sem SDK.
 * Tenta três configurações em ordem decrescente de rigidez:
 *   1. responseJsonSchema (JSON Schema completo) + thinkingLevel
 *   2. responseSchema (subconjunto OpenAPI) sem thinking
 *   3. só responseMimeType (o modelo devolve JSON e a gente extrai)
 */
async function callGemini(env, prompt) {
  const key = env.GEMINI_API_KEY;
  if (!key) return null;

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `${GEMINI_BASE}/models/${model}:generateContent`;

  const attempts = [
    {
      responseMimeType: 'application/json',
      responseJsonSchema: RECIPE_SCHEMA,
      thinkingConfig: { thinkingLevel: 'low', includeThoughts: false }
    },
    {
      responseMimeType: 'application/json',
      responseSchema: toOpenApiSchema(RECIPE_SCHEMA)
    },
    {
      responseMimeType: 'application/json'
    }
  ];

  let lastError = null;

  for (const generationConfig of attempts) {
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: Object.assign({ maxOutputTokens: 8192 }, generationConfig)
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      lastError = new ProviderError('gemini', res.status, await safeText(res));
      // 400 costuma ser "campo não suportado" — tenta a próxima configuração.
      if (res.status === 400) continue;
      throw lastError;
    }

    const data = await res.json();
    const candidate = data && data.candidates && data.candidates[0];

    if (!candidate) {
      const block = data && data.promptFeedback && data.promptFeedback.blockReason;
      lastError = new ProviderError('gemini', 200, block ? `bloqueado (${block})` : 'resposta vazia');
      continue;
    }

    if (candidate.finishReason === 'MAX_TOKENS') {
      lastError = new ProviderError('gemini', 200, 'resposta cortada por falta de tokens');
      continue;
    }

    const text = (candidate.content && candidate.content.parts || [])
      .map(p => p.text || '')
      .join('');

    const parsed = parseJson(text);
    if (!parsed) {
      lastError = new ProviderError('gemini', 200, 'o modelo não devolveu JSON válido');
      continue;
    }

    return { recipe: parsed, provider: 'gemini', model: model };
  }

  throw lastError || new ProviderError('gemini', 0, 'sem resposta');
}

/** Groq — API compatível com OpenAI. */
async function callGroq(env, prompt) {
  const key = env.GROQ_API_KEY;
  if (!key) return null;

  return callOpenAICompatible({
    url: GROQ_URL,
    key: key,
    model: env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
    prompt: prompt,
    extraHeaders: {}
  });
}

/** OpenRouter — API compatível com OpenAI, modelos `:free`. */
async function callOpenRouter(env, prompt) {
  const key = env.OPENROUTER_API_KEY;
  if (!key) return null;

  const headers = {};
  if (env.PUBLIC_URL) headers['HTTP-Referer'] = env.PUBLIC_URL;
  if (env.PUBLIC_URL) headers['X-Title'] = 'Caldo & Cozinha';

  return callOpenAICompatible({
    url: OPENROUTER_URL,
    key: key,
    model: env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    prompt: prompt,
    extraHeaders: headers
  });
}

/**
 * Genérico para APIs OpenAI-compatible (Groq e OpenRouter).
 * Se o provedor recusar `response_format`, refaz sem ele e extrai o JSON
 * do texto — melhor que perder a receita inteira.
 */
async function callOpenAICompatible(opts) {
  const { url, key, model, prompt, extraHeaders } = opts;

  const base = {
    model: model,
    temperature: 0.8,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]
  };

  const headers = Object.assign({
    'content-type': 'application/json',
    'authorization': `Bearer ${key}`
  }, extraHeaders || {});

  const withSchema = Object.assign({}, base, {
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'recipe', schema: RECIPE_SCHEMA }
    }
  });

  let res = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(withSchema)
  });

  if (res.status === 400) {
    // provedor sem suporte a structured output — refaz no modo texto
    res = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(base)
    });
  }

  if (!res.ok) {
    throw new ProviderError(new URL(url).hostname, res.status, await safeText(res));
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const raw = choice && choice.message && choice.message.content || '';

  const parsed = parseJson(raw);
  if (!parsed) {
    throw new ProviderError(new URL(url).hostname, 200, 'o modelo não devolveu JSON válido');
  }

  return {
    recipe: parsed,
    provider: new URL(url).hostname.replace('api.', '').replace('.com', '').replace('.ai', ''),
    model: model
  };
}

/* -------------------------------------------------------------------------- */
/*  PROMPT                                                                     */
/* -------------------------------------------------------------------------- */

function buildPrompt(input) {
  const lines = [];

  lines.push(`Prato pedido: ${input.dish}`);

  if (input.diet.length) {
    lines.push(`Restrições e preferências: ${input.diet.join(', ')}.`);
  }
  if (input.difficulty && input.difficulty !== 'Qualquer uma') {
    lines.push(`Nível de dificuldade desejado: ${input.difficulty}.`);
  }

  lines.push(`Rende exatamente ${input.servings} porções.`);

  if (input.maxMinutes) {
    lines.push(`O preparo inteiro (inclui forno, cozimento e descanso) cabe em até ${input.maxMinutes} minutos.`);
  }
  if (input.equipment && input.equipment !== 'Qualquer um') {
    lines.push(`Use apenas este equipamento: ${input.equipment}.`);
  }
  if (input.notes) {
    lines.push(`Observações do usuário (valem mais que o resto): ${input.notes}`);
  }

  lines.push('');
  lines.push('Devolva a receita completa no formato JSON do schema.');

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  ENTRADA                                                                    */
/* -------------------------------------------------------------------------- */

function parseInput(body) {
  const b = body && typeof body === 'object' ? body : {};

  const dish = String(b.dish || '').trim();
  if (dish.length < 2) {
    throw new HttpError(400, 'Descreva o prato que você quer cozinhar.');
  }
  if (dish.length > 120) {
    throw new HttpError(400, 'O nome do prato deve ter no máximo 120 caracteres.');
  }

  const diet = Array.isArray(b.diet)
    ? b.diet
        .filter(v => typeof v === 'string')
        .map(v => v.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  const difficulty = ['Fácil', 'Média', 'Desafio'].indexOf(b.difficulty) >= 0
    ? b.difficulty
    : 'Qualquer uma';

  return {
    dish: dish,
    diet: diet,
    difficulty: difficulty,
    servings: clamp(toInt(b.servings, 4), 2, 12),
    maxMinutes: clamp(toInt(b.maxMinutes, 45), 15, 180),
    equipment: typeof b.equipment === 'string' ? b.equipment.trim().slice(0, 40) : 'Qualquer um',
    notes: typeof b.notes === 'string' ? b.notes.trim().slice(0, 280) : ''
  };
}

/** String estável do pedido — é a chave do cache. */
function canonical(input) {
  return JSON.stringify([
    input.dish.toLowerCase().trim(),
    input.diet.slice().sort(),
    input.difficulty,
    input.servings,
    input.maxMinutes,
    input.equipment,
    input.notes.toLowerCase().trim()
  ]);
}

/* -------------------------------------------------------------------------- */
/*  SAÍDA — normalização defensiva                                             */
/* -------------------------------------------------------------------------- */

/**
 * O modelo pode devolver campo faltando, número como string ou texto
 * inesperado. Aqui a gente garante que o front-end sempre receba a mesma forma.
 */
function normalizeRecipe(raw, input) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
    .map(item => ({
      quantity: toStr(item && item.quantity, ''),
      name: toStr(item && item.name, ''),
      note: toStr(item && item.note, '')
    }))
    .filter(item => item.name.length > 0);

  const steps = (Array.isArray(r.steps) ? r.steps : [])
    .map(step => ({
      title: toStr(step && step.title, ''),
      durationMinutes: clamp(toInt(step && step.durationMinutes, 0), 0, 600),
      description: toStr(step && step.description, '')
    }))
    .filter(step => step.description.length > 0);

  const prep = clamp(toInt(r.prepMinutes, 0), 0, 1440);
  const cook = clamp(toInt(r.cookMinutes, 0), 0, 1440);
  const total = clamp(toInt(r.totalMinutes, prep + cook), 1, 1440);

  const difficulty = ['Fácil', 'Média', 'Desafio'].indexOf(r.difficulty) >= 0
    ? r.difficulty
    : 'Média';

  return {
    title: toStr(r.title, 'Receita sem nome'),
    description: toStr(r.description, ''),
    emoji: toEmoji(r.emoji),
    servings: clamp(toInt(r.servings, input.servings), 1, 24),
    prepMinutes: prep,
    cookMinutes: cook,
    totalMinutes: total,
    difficulty: difficulty,
    cuisine: toStr(r.cuisine, ''),
    nutrition: {
      calories: clamp(toInt(r.calories, 0), 0, 5000),
      proteinGrams: clamp(toInt(r.proteinGrams, 0), 0, 500),
      carbsGrams: clamp(toInt(r.carbsGrams, 0), 0, 1000),
      fatGrams: clamp(toInt(r.fatGrams, 0), 0, 500)
    },
    ingredients: ingredients,
    steps: steps,
    tips: toStrArray(r.tips, 6),
    tags: toStrArray(r.tags, 6)
  };
}

/* -------------------------------------------------------------------------- */
/*  D1 — cache e cota                                                          */
/* -------------------------------------------------------------------------- */

async function readCache(env, hash) {
  if (!env.DB) return null;

  try {
    const row = await env.DB
      .prepare('SELECT payload, provider, model FROM recipes WHERE hash = ?1')
      .bind(hash)
      .first();

    if (!row) return null;

    return {
      recipe: JSON.parse(row.payload),
      provider: row.provider || '',
      model: row.model || ''
    };
  } catch (err) {
    // Cache quebrado não pode derrubar a API — cai para gerar de novo.
    return null;
  }
}

async function writeCache(env, hash, recipe, provider, model) {
  if (!env.DB) return;

  try {
    await env.DB
      .prepare(
        'INSERT INTO recipes (hash, payload, provider, model, created_at) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5) ' +
        'ON CONFLICT(hash) DO UPDATE SET payload = excluded.payload, ' +
        'provider = excluded.provider, model = excluded.model, created_at = excluded.created_at'
      )
      .bind(hash, JSON.stringify(recipe), provider || '', model || '', Date.now())
      .run();

    // Limpeza eventual: 1 em cada 50 escritas apaga o que passou do TTL.
    if (Math.random() < 0.02) {
      const limit = Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
      await env.DB
        .prepare('DELETE FROM recipes WHERE created_at < ?1')
        .bind(limit)
        .run();
    }
  } catch (err) {
    // Falha de escrita no cache é tolerada: a resposta ainda volta.
  }
}

async function readQuota(env, client, day) {
  const limit = quotaLimit(env);
  let used = 0;

  if (env.DB) {
    try {
      const row = await env.DB
        .prepare('SELECT hits FROM quota WHERE client = ?1 AND day = ?2')
        .bind(client, day)
        .first();
      if (row && typeof row.hits === 'number') used = row.hits;
    } catch (err) {
      used = 0;
    }
  }

  return {
    used: used,
    limit: limit,
    remaining: limit > 0 ? Math.max(0, limit - used) : null
  };
}

async function bumpQuota(env, client, day) {
  if (!env.DB) return;

  try {
    await env.DB
      .prepare(
        'INSERT INTO quota (client, day, hits) VALUES (?1, ?2, 1) ' +
        'ON CONFLICT(client, day) DO UPDATE SET hits = hits + 1'
      )
      .bind(client, day)
      .run();
  } catch (err) {
    // Sem D1 o site continua funcionando, só sem cota.
  }
}

function quotaLimit(env) {
  const value = parseInt(env.MAX_RECIPES_PER_DAY, 10);
  return Number.isFinite(value) && value > 0 ? value : 20;
}

/* -------------------------------------------------------------------------- */
/*  HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

function clientId(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || request.headers.get('True-Client-IP')
    || 'desconhecido';
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Extrai o JSON de uma resposta de modelo, mesmo que venha em ```json. */
function parseJson(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

/**
 * Gemini aceita um subconjunto de OpenAPI Schema: os tipos vão em
 * MAIÚSCULO e palavras extras (`additionalProperties`) não existem.
 */
function toOpenApiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toOpenApiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const out = {};
  for (const key of Object.keys(schema)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type') {
      out.type = String(schema.type).toUpperCase();
      continue;
    }
    out[key] = toOpenApiSchema(schema[key]);
  }
  return out;
}

function toStr(value, fallback) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function toStrArray(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => toStr(item, ''))
    .filter(item => item.length > 0)
    .slice(0, limit);
}

function toEmoji(value) {
  const text = toStr(value, '');
  if (!text) return '🍲';
  // keep só o primeiro emoji / caractere de/grapheme
  const first = Array.from(text)[0];
  return first || '🍲';
}

function toInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const parsed = parseInt(value.replace(',', '.'), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function safeText(res) {
  try {
    const body = await res.text();
    return body.slice(0, 400);
  } catch (err) {
    return `HTTP ${res.status}`;
  }
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function text(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  });
}

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('Access-Control-Max-Age', '86400');
  return res;
}
