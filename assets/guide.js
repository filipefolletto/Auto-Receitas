/* ==========================================================================
   Style Guide — Gerador de Receitas
   Comportamentos do guia (copiar, tema, tabs, scrollspy, demos)
   ========================================================================== */
(function () {
  'use strict';

  var root = document.documentElement;

  /* ---------------------------------------------------------------- TEMA -- */
  var themeToggle = document.getElementById('theme-toggle');

  function applyTheme(theme) {
    // desliga transições durante a troca para o snap de cor ser instantâneo
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem('sg-theme', theme); } catch (e) {}
    if (themeToggle) {
      themeToggle.setAttribute('title', theme === 'dark' ? 'Tema claro' : 'Tema escuro');
      themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro');
    }
    // força reflow e remove a classe assim que o navegador paintar o novo tema
    void root.offsetHeight;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        root.classList.remove('theme-switching');
      });
    });
    // rede de segurança para ambientes que não paintam (headless, aba oculta)
    setTimeout(function () {
      root.classList.remove('theme-switching');
    }, 250);
  }

  var saved = null;
  try { saved = localStorage.getItem('sg-theme'); } catch (e) {}
  if (!saved) {
    saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(saved);

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
  }

  /* --------------------------------------------------------------- TOAST -- */
  var toastEl = document.getElementById('toast');
  var toastTimer;

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 1800);
  }

  /* ------------------------------------------------------------- COPIAR -- */
  function legacyCopy(text) {
    // fallback para navegadores sem Clipboard API ou sem permissão
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error('copy-failed'));
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function copyAndToast(text, message) {
    copyText(text).then(
      function () { toast(message); },
      function () { toast('Não foi possível copiar — selecione e copie manualmente'); }
    );
  }

  document.addEventListener('click', function (event) {
    var swatch = event.target.closest('[data-copy]');
    if (swatch) {
      copyAndToast(swatch.getAttribute('data-copy'), 'Copiado: ' + swatch.getAttribute('data-copy'));
      return;
    }

    var btn = event.target.closest('[data-copy-target]');
    if (btn) {
      var target = document.querySelector(btn.getAttribute('data-copy-target'));
      if (!target) return;
      copyAndToast(target.innerText, 'Código copiado');
    }
  });

  /* ---------------------------------------------------------------- TABS -- */
  function initTabs(scope) {
    var tabs = scope.querySelectorAll('[role="tab"]');
    if (!tabs.length) return;
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        var list = tab.closest('[role="tablist"]');
        Array.prototype.forEach.call(list.querySelectorAll('[role="tab"]'), function (t) {
          t.setAttribute('aria-selected', String(t === tab));
        });
      });
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.sg-tabs, .tabs'), initTabs);

  /* ------------------------------------------------------------ SCROLLSPY -- */
  var links = Array.prototype.slice.call(document.querySelectorAll('.sg-nav a'));
  var sections = links
    .map(function (link) {
      return document.querySelector(link.getAttribute('href'));
    })
    .filter(Boolean);

  function setActive(id) {
    links.forEach(function (link) {
      link.classList.toggle('is-active', link.getAttribute('href') === '#' + id);
    });
  }

  function spyUpdate() {
    var offset = 96;
    var current = sections[0];
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop - offset <= window.scrollY) current = sections[i];
    }
    if (current) setActive(current.id);
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    spyUpdate();
    // segunda passada no próximo frame
    requestAnimationFrame(function () {
      spyUpdate();
      ticking = false;
    });
    setTimeout(function () {
      ticking = false;
    }, 120);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  // fallback: alguns ambientes (headless, aba oculta) não despacham scroll
  setInterval(spyUpdate, 300);
  spyUpdate();

  /* ---------------------------------------------------------- FAVORITAR -- */
  document.addEventListener('click', function (event) {
    var fav = event.target.closest('.recipe-fav');
    if (!fav) return;
    var on = fav.classList.toggle('is-on');
    fav.setAttribute('aria-pressed', String(on));
    fav.setAttribute('aria-label', on ? 'Remover dos favoritos' : 'Favoritar');
    var use = fav.querySelector('use');
    if (use) use.setAttribute('href', on ? '#i-heart-fill' : '#i-heart');
    toast(on ? 'Adicionada aos favoritos' : 'Removida dos favoritos');
  });

  /* ------------------------------------------------------------ STEPPER -- */
  document.addEventListener('click', function (event) {
    var btn = event.target.closest('.stepper button');
    if (!btn) return;
    var out = btn.parentNode.querySelector('output');
    if (!out) return;
    var current = parseFloat(out.textContent);
    if (isNaN(current)) current = 0;
    var delta = btn.querySelector('use') &&
      btn.querySelector('use').getAttribute('href') === '#i-plus' ? 1 : -1;
    var next = Math.max(1, current + delta);
    out.textContent = String(next);
  });

  /* --------------------------------------------------------- RANGE LABELS -- */
  document.addEventListener('input', function (event) {
    var range = event.target;
    if (!range.classList || !range.classList.contains('range')) return;
    var label = range.closest('.field') && range.closest('.field').querySelector('.field-label strong');
    if (label) label.textContent = range.value + ' min';
  });

  /* --------------------------------------------------------- MISC DEMOS -- */
  document.addEventListener('click', function (event) {
    var chip = event.target.closest('.chip[aria-pressed]');
    if (chip) {
      var pressed = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', String(!pressed));
    }

    var alertClose = event.target.closest('.alert-close');
    if (alertClose) {
      var alert = alertClose.closest('.alert');
      if (alert) alert.remove();
    }
  });
})();
