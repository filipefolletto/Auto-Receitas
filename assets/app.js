/* ==========================================================================
   Caldo & Cozinha — Gerador de Receitas
   Front-end sem framework e sem build.
   Conversa com o Worker (Cloudflare) em /api — a chave da IA nunca chega aqui.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ API -- */
  // ?api=http://localhost:8787 aponta para o `wrangler dev` local.
  var API_BASE = new URLSearchParams(location.search).get('api') || '/api';

  var LS = {
    theme: 'sg-theme',            // mesma chave do style guide: tema compartilhado
    favorites: 'caldo.favorites',
    last: 'caldo.last'
  };

  var SUGESTIONS = [
    'strogonoff de frango com batata palha',
    'creme de abóbora com gengibre e alecrim',
    'carne de panela com legumes assados',
    'torta de frango com catupiry',
    'moqueca de peixe com coentro',
    'nhoque de batata com ragu de tomate',
    'omelete de forno com ervas frescas',
    'brigadeiro de chocolate com flor de sal',
    'panqueca de banana com calda de maple',
    'escondidinho de carne seca seca',
    'cuscuz com ovo, queijo e calabresa',
    'torta de limão siciliano'
  ];

  var state = {
    recipe: null,
    meta: null,
    baseServings: 4,
    servings: 4,
    quota: null,
    view: 'generator'
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------------------------------------------------------- TEMA -- */
  function applyTheme(theme) {
    var root = document.documentElement;
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem(LS.theme, theme); } catch (e) {}
    void root.offsetHeight;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { root.classList.remove('theme-switching'); });
    });
    setTimeout(function () { root.classList.remove('theme-switching'); }, 250);
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(LS.theme); } catch (e) {}
    if (!saved) {
      saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(saved);

    var btn = $('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
  }

  /* --------------------------------------------------------------- TOAST -- */
  function toast(message, kind) {
    var wrap = $('toast-wrap');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' toast--error' : '');
    var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', kind === 'error' ? '#i-alert' : '#i-check-circle');
    icon.appendChild(use);
    var text = document.createElement('span');
    text.textContent = message;
    el.appendChild(icon);
    el.appendChild(text);
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 180ms ease-out';
      setTimeout(function () { el.remove(); }, 220);
    }, 2800);
  }

  /* --------------------------------------------------------------- UTILS -- */
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function recipeKey(r) {
    return String(r.title || '').trim().toLowerCase();
  }

  /* --------------------------------------------------- ESCALA DE PORÇÕES -- */
  // "1 1/2 xícara" -> "3 xícaras" quando dobra, "3/4" -> "1/2", "200 g" -> "400 g".
  function scaleQuantity(qty, factor) {
    var q = String(qty == null ? '' : qty).trim();
    if (!q || factor === 1) return q;

    var mixed = q.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
    if (mixed) {
      var total = parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
      return formatAmount(total * factor) + q.slice(mixed[0].length);
    }

    var frac = q.match(/^(\d+)\s*\/\s*(\d+)/);
    if (frac) {
      return formatAmount((parseInt(frac[1], 10) / parseInt(frac[2], 10)) * factor) + q.slice(frac[0].length);
    }

    var dec = q.match(/^(\d+(?:[.,]\d+)?)/);
    if (dec) {
      var value = parseFloat(dec[1].replace(',', '.'));
      return formatAmount(value * factor) + q.slice(dec[0].length);
    }

    return q;
  }

  function formatAmount(n) {
    var quarter = Math.round(n * 4) / 4;
    var whole = Math.floor(quarter);
    var rest = quarter - whole;
    var map = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
    if (rest === 0) return String(whole);
    if (rest === 1) return String(whole + 1);
    if (map[rest]) return (whole ? whole + ' ' : '') + map[rest];
    return String(Math.round(n * 10) / 10).replace('.', ',');
  }

  /* -------------------------------------------------------------- FAVORITOS -- */
  function loadFavorites() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS.favorites));
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }

  function saveFavorites(list) {
    try { localStorage.setItem(LS.favorites, JSON.stringify(list)); } catch (e) {}
    updateFavCount();
  }

  function updateFavCount() {
    var badge = $('fav-count');
    if (!badge) return;
    var n = loadFavorites().length;
    badge.textContent = String(n);
    badge.hidden = n === 0;
  }

  function isFavorite(recipe) {
    var key = recipeKey(recipe);
    return loadFavorites().some(function (r) { return recipeKey(r) === key; });
  }

  function toggleFavorite(recipe) {
    var list = loadFavorites();
    var key = recipeKey(recipe);
    var index = -1;
    for (var i = 0; i < list.length; i++) {
      if (recipeKey(list[i]) === key) { index = i; break; }
    }
    if (index >= 0) {
      list.splice(index, 1);
      saveFavorites(list);
    } else {
      list.unshift(recipe);
      saveFavorites(list);
    }
    return index < 0;
  }

  /* ---------------------------------------------------------------- VIEWS -- */
  function showView(name) {
    state.view = name;
    $('view-generator').hidden = name !== 'generator';
    $('view-favorites').hidden = name !== 'favorites';
    Array.prototype.forEach.call(document.querySelectorAll('.app-nav a[data-view]'), function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-view') === name);
    });
    if (name === 'favorites') renderFavorites();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderFavorites() {
    var grid = $('favorites-grid');
    if (!grid) return;
    var list = loadFavorites();

    if (!list.length) {
      grid.innerHTML = '';
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.gridColumn = '1 / -1';
      empty.innerHTML =
        '<div class="empty-icon"><svg><use href="#i-heart"/></svg></div>' +
        '<h4>Nenhum favorito ainda</h4>' +
        '<p>Gere uma receita e toque em <strong>Salvar</strong> para guardá-la aqui. Os favoritos ficam neste navegador.</p>';
      grid.appendChild(empty);
      return;
    }

    grid.innerHTML = list.map(function (r) {
      var tone = toneFor(r.title);
      return '' +
        '<article class="card card--interactive recipe-card" data-open="' + esc(recipeKey(r)) + '" tabindex="0" role="button">' +
          '<div class="recipe-thumb recipe-thumb--' + tone + '"><span role="img" aria-label="' + esc(r.title) + '">' + esc(r.emoji || '🍲') + '</span></div>' +
          '<div class="card-body">' +
            '<h4 class="recipe-title">' + esc(r.title) + '</h4>' +
            '<p class="recipe-desc">' + esc(r.description || '') + '</p>' +
            '<div class="recipe-meta">' +
              '<span><svg><use href="#i-clock"/></svg> ' + esc(r.totalMinutes || 0) + ' min</span>' +
              '<span><svg><use href="#i-users"/></svg> ' + esc(r.servings || 0) + ' porções</span>' +
              '<span><svg><use href="#i-flame"/></svg> ' + esc(r.nutrition && r.nutrition.calories || 0) + ' kcal</span>' +
            '</div>' +
          '</div>' +
        '</article>';
    }).join('');

    grid.onclick = function (event) {
      var card = event.target.closest('[data-open]');
      if (!card) return;
      var key = card.getAttribute('data-open');
      var found = loadFavorites().filter(function (r) { return recipeKey(r) === key; })[0];
      if (!found) return;
      state.recipe = found;
      state.meta = { provider: 'favorito', model: '' };
      state.baseServings = found.servings || 4;
      state.servings = state.baseServings;
      renderRecipe(found, state.meta);
      showView('generator');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }

  function toneFor(seed) {
    var sum = 0;
    for (var i = 0; i < String(seed).length; i++) sum += String(seed).charCodeAt(i);
    return (sum % 4) + 1;
  }

  /* ------------------------------------------------------------ FORMULÁRIO -- */
  function initForm() {
    var form = $('gen-form');
    var dish = $('dish');
    var servingsOut = $('servings');
    var range = $('max-time');
    var rangeValue = $('max-time-value');
    var notes = $('notes');
    var notesCount = $('notes-count');

    dish.addEventListener('input', function () {
      dish.classList.remove('is-invalid');
      $('dish-error').hidden = true;
    });

    // chips
    Array.prototype.forEach.call(document.querySelectorAll('.chip[data-chip]'), function (chip) {
      chip.addEventListener('click', function () {
        var pressed = chip.getAttribute('aria-pressed') === 'true';
        chip.setAttribute('aria-pressed', String(!pressed));
      });
    });

    // stepper de porções
    Array.prototype.forEach.call(document.querySelectorAll('.stepper [data-step]'), function (btn) {
      btn.addEventListener('click', function () {
        var delta = parseInt(btn.getAttribute('data-step'), 10);
        var next = clamp((parseInt(servingsOut.textContent, 10) || 4) + delta, 2, 12);
        servingsOut.textContent = String(next);
      });
    });

    // range de tempo
    range.addEventListener('input', function () {
      rangeValue.textContent = range.value + ' min';
    });

    // contador de observações
    notes.addEventListener('input', function () {
      notesCount.textContent = String(notes.value.length);
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      generate();
    });

    $('surprise-btn').addEventListener('click', function () {
      dish.value = SUGGESTIONS[Math.floor(Math.random() * SUGGESTIONS.length)];
      dish.classList.remove('is-invalid');
      $('dish-error').hidden = true;
      generate();
    });

    // atalho: Enter no campo de prato gera
    dish.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        generate();
      }
    });
  }

  function collectInput() {
    var diet = [];
    Array.prototype.forEach.call(document.querySelectorAll('.chip[aria-pressed="true"]'), function (chip) {
      diet.push(chip.getAttribute('data-chip'));
    });
    return {
      dish: $('dish').value.trim(),
      diet: diet,
      difficulty: $('difficulty').value,
      servings: parseInt($('servings').textContent, 10) || 4,
      maxMinutes: parseInt($('max-time').value, 10) || 45,
      equipment: $('equipment').value,
      notes: $('notes').value.trim()
    };
  }

  /* -------------------------------------------------------------- GENERAR -- */
  function setLoading(loading) {
    var result = $('result');
    result.setAttribute('aria-busy', String(loading));
    $('result-empty').hidden = true;
    $('result-skeleton').hidden = !loading;
    $('result-content').hidden = loading;
    var btn = $('generate-btn');
    btn.classList.toggle('is-loading', loading);
    btn.disabled = loading;
  }

  function generate() {
    var input = collectInput();

    if (input.dish.length < 2) {
      $('dish').classList.add('is-invalid');
      $('dish-error').hidden = false;
      $('dish').focus();
      return;
    }

    setLoading(true);

    fetch(API_BASE + '/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Não foi possível gerar a receita agora.');
          return data;
        });
      })
      .then(function (data) {
        state.recipe = data.recipe;
        state.meta = data;
        state.baseServings = data.recipe.servings || input.servings;
        state.servings = state.baseServings;
        renderRecipe(data.recipe, data);
        updateQuota(data.quota);
        try { localStorage.setItem(LS.last, JSON.stringify(data.recipe)); } catch (e) {}
        if (data.cache === 'hit') toast('Receita recuperada do cache — nenhum token gasto');
      })
      .catch(function (err) {
        showError(err.message || 'Erro inesperado ao gerar a receita.');
      })
      .finally(function () {
        setLoading(false);
      });
  }

  function showError(message) {
    var content = $('result-content');
    $('result-empty').hidden = true;
    $('result-skeleton').hidden = true;
    content.hidden = false;
    content.innerHTML =
      '<div class="result-body">' +
        '<div class="alert alert--danger">' +
          '<svg><use href="#i-alert"/></svg>' +
          '<div><span class="alert-title">Não foi possível gerar</span>' + esc(message) + '</div>' +
        '</div>' +
      '</div>';
    toast(message, 'error');
  }

  /* ------------------------------------------------------------- RENDERIZAR -- */
  function renderRecipe(recipe, meta) {
    var content = $('result-content');
    var r = recipe;
    var factor = state.baseServings ? state.servings / state.baseServings : 1;
    var tone = toneFor(r.title || '');
    var fav = isFavorite(r);

    var badges = [];
    badges.push('<span class="badge ' + difficultyBadge(r.difficulty) + '">' + esc(r.difficulty || 'Média') + '</span>');
    badges.push('<span class="badge badge--accent"><svg><use href="#i-clock"/></svg> ' + esc(r.totalMinutes || 0) + ' min</span>');
    badges.push('<span class="badge"><svg><use href="#i-users"/></svg> ' + esc(state.servings) + ' porções</span>');
    (r.tags || []).slice(0, 4).forEach(function (tag) {
      badges.push('<span class="badge badge--diet">' + esc(tag) + '</span>');
    });

    var ingredients = (r.ingredients || []).map(function (it) {
      return '' +
        '<div class="ingredient">' +
          '<span class="ingredient-qty">' + esc(scaleQuantity(it.quantity, factor)) + '</span>' +
          '<span class="ingredient-name">' + esc(it.name) + (it.note ? '<small>' + esc(it.note) + '</small>' : '') + '</span>' +
        '</div>';
    }).join('');

    var steps = (r.steps || []).map(function (step) {
      var head = '';
      if (step.title) {
        head += '<strong>' + esc(step.title) + '</strong>';
        if (step.durationMinutes) head += ' <span class="step-time">· ' + esc(step.durationMinutes) + ' min</span>';
        head += '<br>';
      }
      return '<li><div>' + head + esc(step.description || '') + '</div></li>';
    }).join('');

    var tips = (r.tips || []).length
      ? '<ul class="tip-list">' + r.tips.map(function (tip) {
          return '<li><svg><use href="#i-check-circle"/></svg><span>' + esc(tip) + '</span></li>';
        }).join('') + '</ul>'
      : '';

    var n = r.nutrition || {};
    var stats = [
      ['i-clock', r.totalMinutes ? r.totalMinutes + ' min' : '—', 'Tempo total'],
      ['i-flame', (n.calories || 0) + ' kcal', 'Calorias'],
      ['i-users', (n.proteinGrams || 0) + ' g', 'Proteína'],
      ['i-basket', (n.carbsGrams || 0) + ' g', 'Carboidratos']
    ].map(function (s) {
      return '<div class="stat"><b><svg style="width:16px;height:16px;display:inline;vertical-align:-2px"><use href="#' + s[0] + '"/></svg> ' + esc(s[1]) + '</b><span>' + esc(s[2]) + '</span></div>';
    }).join('');

    content.innerHTML = '' +
      '<div class="result-hero result-hero--' + tone + '"><span role="img" aria-label="Ilustração do prato">' + esc(r.emoji || '🍲') + '</span></div>' +

      '<div class="result-head">' +
        '<div class="result-badges">' + badges.join('') + '</div>' +
        '<h2 class="result-title">' + esc(r.title) + '</h2>' +
        '<p class="result-desc">' + esc(r.description || '') + '</p>' +
        '<div class="result-meta">' +
          (r.cuisine ? '<span><svg><use href="#i-book"/></svg> ' + esc(r.cuisine) + '</span>' : '') +
          (meta && meta.provider ? '<span><svg><use href="#i-sparkles"/></svg> ' + esc(meta.provider) + (meta.model ? ' · ' + esc(meta.model) : '') + '</span>' : '') +
        '</div>' +
      '</div>' +

      '<div class="result-body">' +
        '<div class="stat-row">' + stats + '</div>' +
        '<p class="nutrition-note">Valores nutricionais são estimativas geradas por IA e podem variar bastante. Para dieta clínica, confirme com um nutricionista.</p>' +

        '<div class="result-grid-2" style="margin-top:var(--space-8)">' +

          '<section class="result-section">' +
            '<h3 class="result-section-title"><svg><use href="#i-basket"/></svg> Ingredientes</h3>' +
            '<div class="servings-control">' +
              '<span class="field-label">Porções <span class="servings-hint">as medidas se ajustam sozinhas</span></span>' +
              '<div class="stepper" role="group" aria-label="Ajustar porções">' +
                '<button type="button" data-scale="-1" aria-label="Diminuir porções"><svg><use href="#i-minus"/></svg></button>' +
                '<output aria-live="polite">' + esc(state.servings) + '</output>' +
                '<button type="button" data-scale="1" aria-label="Aumentar porções"><svg><use href="#i-plus"/></svg></button>' +
              '</div>' +
            '</div>' +
            ingredients +
          '</section>' +

          '<section class="result-section">' +
            '<h3 class="result-section-title"><svg><use href="#i-list"/></svg> Modo de preparo</h3>' +
            '<ol class="method">' + steps + '</ol>' +
          '</section>' +

        '</div>' +

        (tips ? '<section class="result-section"><h3 class="result-section-title"><svg><use href="#i-info"/></svg> Dicas da cozinha</h3>' + tips + '</section>' : '') +
      '</div>' +

      '<div class="result-actions">' +
        '<button class="btn btn--primary" data-action="save">' +
          '<svg><use href="#' + (fav ? 'i-heart-fill' : 'i-bookmark') + '"/></svg> ' + (fav ? 'Salva' : 'Salvar') +
        '</button>' +
        '<button class="btn btn--secondary" data-action="copy"><svg><use href="#i-copy"/></svg> Copiar</button>' +
        '<button class="btn btn--secondary" data-action="print"><svg><use href="#i-print"/></svg> Imprimir</button>' +
        '<button class="btn btn--ghost" data-action="new"><svg><use href="#i-sparkles"/></svg> Nova receita</button>' +
      '</div>';

    $('result-empty').hidden = true;
    $('result-skeleton').hidden = true;
    content.hidden = false;
  }

  function difficultyBadge(difficulty) {
    var d = String(difficulty || '').toLowerCase();
    if (d.indexOf('fácil') === 0 || d.indexOf('facil') === 0) return 'badge--easy';
    if (d.indexOf('desafio') === 0) return 'badge--hard';
    return 'badge--medium';
  }

  /* ------------------------------------------------------- AÇÕES DO RESULTADO -- */
  function initResultActions() {
    var content = $('result-content');

    content.addEventListener('click', function (event) {
      var scaleBtn = event.target.closest('[data-scale]');
      if (scaleBtn) {
        var delta = parseInt(scaleBtn.getAttribute('data-scale'), 10);
        state.servings = clamp(state.servings + delta, 1, 24);
        renderRecipe(state.recipe, state.meta);
        return;
      }

      var actionBtn = event.target.closest('[data-action]');
      if (!actionBtn || !state.recipe) return;
      var action = actionBtn.getAttribute('data-action');

      if (action === 'save') {
        var nowFav = toggleFavorite(state.recipe);
        renderRecipe(state.recipe, state.meta);
        toast(nowFav ? 'Adicionada aos favoritos' : 'Removida dos favoritos');
      } else if (action === 'copy') {
        copyRecipe(state.recipe);
      } else if (action === 'print') {
        window.print();
      } else if (action === 'new') {
        $('dish').focus();
        $('dish').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  function recipeToText(r) {
    var lines = [];
    lines.push(r.title);
    lines.push('');
    if (r.description) { lines.push(r.description); lines.push(''); }
    lines.push('Rende ' + r.servings + ' porções · ' + r.totalMinutes + ' min · ' + r.difficulty);
    lines.push('');
    lines.push('INGREDIENTES');
    (r.ingredients || []).forEach(function (it) {
      lines.push('- ' + it.quantity + ' ' + it.name + (it.note ? ' (' + it.note + ')' : ''));
    });
    lines.push('');
    lines.push('MODO DE PREPARO');
    (r.steps || []).forEach(function (step, i) {
      lines.push((i + 1) + '. ' + (step.title ? step.title + ' — ' : '') + step.description);
    });
    if ((r.tips || []).length) {
      lines.push('');
      lines.push('DICAS');
      r.tips.forEach(function (tip) { lines.push('- ' + tip); });
    }
    return lines.join('\n');
  }

  function copyRecipe(recipe) {
    var text = recipeToText(recipe);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast('Receita copiada'); },
        function () { fallbackCopy(text); }
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    toast(ok ? 'Receita copiada' : 'Não foi possível copiar', ok ? '' : 'error');
  }

  /* ---------------------------------------------------------------- COTA -- */
  function updateQuota(quota) {
    if (!quota) return;
    state.quota = quota;
    var pill = $('quota-pill');
    var text = $('quota-text');
    if (!pill || !text) return;
    text.textContent = quota.limit ? quota.used + '/' + quota.limit + ' hoje' : quota.used + ' hoje';
    pill.classList.toggle('is-exhausted', quota.limit > 0 && quota.remaining <= 0);
    pill.title = 'Receitas geradas hoje neste navegador (' + quota.used + ' de ' + quota.limit + ')';
  }

  function loadQuota() {
    return fetch(API_BASE + '/health')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        updateQuota(data.quota);
        if (data.limits && data.limits.maxMinutes) {
          var range = $('max-time');
          if (range && Number(range.max) < data.limits.maxMinutes) range.max = String(data.limits.maxMinutes);
        }
      })
      .catch(function () { /* API fora do ar: segue com a UI local */ });
  }

  /* ---------------------------------------------------------------- INIT -- */
  function init() {
    initTheme();
    initForm();
    initResultActions();
    updateFavCount();

    Array.prototype.forEach.call(document.querySelectorAll('.app-nav a[data-view]'), function (a) {
      a.addEventListener('click', function (event) {
        event.preventDefault();
        showView(a.getAttribute('data-view'));
      });
    });

    // última receita gerada neste navegador (reaparece ao recarregar)
    try {
      var last = JSON.parse(localStorage.getItem(LS.last));
      if (last && last.title) {
        state.recipe = last;
        state.meta = null;
        state.baseServings = last.servings || 4;
        state.servings = state.baseServings;
        renderRecipe(last, state.meta);
      }
    } catch (e) {}

    loadQuota();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
