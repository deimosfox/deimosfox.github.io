(function() {
  'use strict';

  const firebaseConfig = {
    apiKey: "AIzaSyBa9iQuchwluGrEMdhPPkyS3_iU6wE8E1A",
    authDomain: "sinovodstvo.firebaseapp.com",
    databaseURL: "https://sinovodstvo-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "sinovodstvo",
    storageBucket: "sinovodstvo.firebasestorage.app",
    messagingSenderId: "121507966660",
    appId: "1:121507966660:web:dfa3f27a3783722a30e391",
    measurementId: "G-4ETB2HXY4Z"
  };

  const PARTICIPANTS = ['ArhonDD', 'eMachines', 'Asta'];
  const PERSON_KEY = 'expense_person_v1';

  // ---------- Firebase ----------
  let stateRef = null;
  try {
    if (typeof firebase !== 'undefined') {
      firebase.initializeApp(firebaseConfig);
      stateRef = firebase.database().ref('accounting_state');
    }
  } catch (e) { console.warn('[app] Firebase:', e); }

  // ---------- Сброс в 06:00 МСК ----------
  const MSK_OFFSET_MIN = 3 * 60;
  const RESET_HOUR_MSK = 6;
  const SHIFT_MS = (MSK_OFFSET_MIN - RESET_HOUR_MSK * 60) * 60 * 1000;

  let state = defaultState();

  function defaultState() {
    return {
      daily: { items: [], lastReset: null },
      weekly: { items: [], lastReset: null },
      expenses: {
        total: 0,
        contributions: { ArhonDD: 0, eMachines: 0, Asta: 0 }
      }
    };
  }

  // ---------- Нормализация ----------
  function migrateItems(raw) {
    if (!raw) return {};
    const entries = Array.isArray(raw)
      ? raw.map((v, i) => [String(i), v])
      : Object.entries(raw);
    const out = {};
    for (const [key, val] of entries) {
      if (!val || typeof val !== 'object') continue;
      let id = val.id;
      if (!id) { if (!/^\d+$/.test(key)) id = key; }
      if (!id) continue;
      if (!val.text || typeof val.text !== 'string') continue;
      out[id] = {
        id: id, text: val.text, checked: !!val.checked,
        ...(typeof val.createdAt === 'number' ? { createdAt: val.createdAt } : {})
      };
    }
    return out;
  }

  function itemOrder(item) {
    if (typeof item.createdAt === 'number') return item.createdAt;
    const n = parseInt(String(item.id).split('_')[0], 10);
    return isNaN(n) ? Infinity : n;
  }

  function itemsToSortedArray(obj) {
    const arr = Object.values(obj);
    arr.sort((a, b) => {
      if (a.checked !== b.checked) return a.checked ? 1 : -1;
      return itemOrder(a) - itemOrder(b);
    });
    return arr;
  }

  function normalizeState(raw) {
    const out = defaultState();
    if (!raw || typeof raw !== 'object') return out;
    ['daily', 'weekly'].forEach(kind => {
      const src = raw[kind];
      if (!src) return;
      out[kind].items = itemsToSortedArray(migrateItems(src.items));
      if (src.lastReset) out[kind].lastReset = src.lastReset;
    });
    if (raw.expenses && typeof raw.expenses === 'object') {
      if (typeof raw.expenses.total === 'number') out.expenses.total = raw.expenses.total;
      if (raw.expenses.contributions && typeof raw.expenses.contributions === 'object') {
        for (const p of PARTICIPANTS) {
          const v = raw.expenses.contributions[p];
          if (typeof v === 'number' && isFinite(v)) out.expenses.contributions[p] = v;
        }
      }
    }
    return out;
  }

  // ---------- Время (06:00 МСК) ----------
  function shiftedNow() { return new Date(Date.now() + SHIFT_MS); }
  function accountingDateKey() {
    const d = shiftedNow();
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }
  function accountingWeekKey() {
    const d = shiftedNow();
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNr = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - dayNr + 3);
    const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round((t - firstThu) / (7 * 24 * 3600 * 1000));
    return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
  }
  function nextDailyResetUTC() {
    const s = shiftedNow();
    return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 1) - SHIFT_MS;
  }
  function nextWeeklyResetUTC() {
    const s = shiftedNow();
    const dayNr = (s.getUTCDay() + 6) % 7;
    let d = (7 - dayNr) % 7; if (d === 0) d = 7;
    return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + d) - SHIFT_MS;
  }
  function fmtMsk(utcMs) {
    const d = new Date(utcMs + 3 * 60 * 60 * 1000);
    const p = n => String(n).padStart(2, '0');
    return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + ' ' +
           p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' МСК';
  }

  function fmtMoney(n) {
    const v = Number(n) || 0;
    if (Number.isInteger(v)) return v.toLocaleString('ru-RU');
    return v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }

  // ============================================================
  //  WRITE QUEUE
  // ============================================================
  const writeQueue = [];
  let isProcessingQueue = false;
  const OP_TIMEOUT_MS = 15000;

  function enqueueWrite(fn, description) {
    writeQueue.push({ fn, description });
    if (!isProcessingQueue) processQueue();
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout ' + ms + 'ms')), ms))
    ]);
  }

  async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    try {
      while (writeQueue.length > 0) {
        const item = writeQueue[0];
        let ok = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await withTimeout(item.fn(), OP_TIMEOUT_MS);
            ok = true;
            console.log('[app] OK:', item.description);
            break;
          } catch (e) {
            console.warn('[app] attempt', attempt, 'failed:', item.description, e && e.message);
            if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 500));
          }
        }
        if (!ok) console.error('[app] GIVE UP:', item.description);
        writeQueue.shift();
      }
    } finally {
      isProcessingQueue = false;
      if (stateRef) {
        try {
          const snap = await stateRef.once('value');
          if (snap && snap.val()) applyServerData(snap.val());
        } catch (e) { console.warn('[app] final sync:', e); }
      }
    }
  }

  // ============================================================
  //  SYNC
  // ============================================================
  let lastAppliedJson = '';
  function applyServerData(data) {
    const json = JSON.stringify(data);
    if (json === lastAppliedJson) return;
    state = normalizeState(data);
    lastAppliedJson = json;
    renderAll();
  }
  function attachServerListener() {
    if (!stateRef) return;
    stateRef.on('value', snap => {
      if (isProcessingQueue || writeQueue.length > 0) return;
      const data = snap.val();
      if (!data) return;
      applyServerData(data);
    });
  }
  function loadFromServer() {
    if (!stateRef) return Promise.resolve();
    return stateRef.once('value').then(snap => {
      const data = snap.val();
      if (data) applyServerData(data);
    }).catch(e => console.warn('[app] load:', e));
  }

  // ============================================================
  //  ГАРАНТИРОВАННАЯ МИГРАЦИЯ expenses
  //  Создаёт contributions на сервере, если их нет
  // ============================================================
  async function ensureExpensesStructure() {
    if (!stateRef) return;
    try {
      const snap = await stateRef.child('expenses').once('value');
      const curr = snap.val();

      if (curr === null) {
        await stateRef.child('expenses').set({
          total: 0,
          contributions: { ArhonDD: 0, eMachines: 0, Asta: 0 }
        });
        console.log('[app] ensureExpenses: created fresh structure');
        return;
      }

      // Скаляр (число/строка) — старая структура
      if (typeof curr !== 'object') {
        await stateRef.child('expenses').set({
          total: Number(curr) || 0,
          contributions: { ArhonDD: 0, eMachines: 0, Asta: 0 }
        });
        console.log('[app] ensureExpenses: fixed scalar total');
        return;
      }

      // Есть total, но нет contributions
      if (!curr.contributions) {
        await stateRef.child('expenses/contributions').set({
          ArhonDD: 0, eMachines: 0, Asta: 0
        });
        console.log('[app] ensureExpenses: created contributions');
        return;
      }

      // contributions есть, но не у всех участников — дополняем
      const updates = {};
      let needs = false;
      for (const p of PARTICIPANTS) {
        if (typeof curr.contributions[p] !== 'number') {
          updates['expenses/contributions/' + p] = 0;
          needs = true;
        }
      }
      if (needs) {
        await stateRef.update(updates);
        console.log('[app] ensureExpenses: filled missing participants');
      }
    } catch (e) {
      console.warn('[app] ensureExpenses:', e);
    }
  }

  // ============================================================
  //  ТРАНЗАКЦИИ на узел daily / weekly
  // ============================================================
  function txKind(kind, mutator) {
    if (!stateRef) return Promise.resolve();
    return stateRef.child(kind).transaction(curr => {
      const base = (curr && typeof curr === 'object') ? curr : null;
      const cleanItems = migrateItems(base ? base.items : null);
      const result = mutator(base, cleanItems);
      if (result === undefined) return;
      const next = { items: result.items };
      if (base && base.lastReset) next.lastReset = base.lastReset;
      if (result.lastReset) next.lastReset = result.lastReset;
      return next;
    });
  }

  // ============================================================
  //  АВТОСБРОС 06:00 МСК
  // ============================================================
  function autoReset() {
    const d = accountingDateKey();
    const w = accountingWeekKey();
    if (state.daily.lastReset !== d) {
      state.daily.items = state.daily.items.map(i => ({ ...i, checked: false }));
      state.daily.lastReset = d;
      renderChecklist('daily');
      enqueueAutoReset('daily', d);
    }
    if (state.weekly.lastReset !== w) {
      state.weekly.items = state.weekly.items.map(i => ({ ...i, checked: false }));
      state.weekly.lastReset = w;
      renderChecklist('weekly');
      enqueueAutoReset('weekly', w);
    }
  }
  function enqueueAutoReset(kind, newKey) {
    if (!stateRef) return;
    enqueueWrite(() => txKind(kind, (base, items) => {
      if (base && base.lastReset === newKey) return;
      Object.keys(items).forEach(id => { items[id].checked = false; });
      return { items, lastReset: newKey };
    }), 'autoReset ' + kind);
  }

  // ============================================================
  //  РЕНДЕР чек-листов
  // ============================================================
  function renderChecklist(kind) {
    const listEl = document.getElementById(kind + '-list');
    const infoEl = document.getElementById(kind + '-reset-info');
    if (!listEl || !infoEl) return;
    listEl.innerHTML = '';

    const items = (state[kind].items || []).slice().sort((a, b) => {
      if (a.checked !== b.checked) return a.checked ? 1 : -1;
      return itemOrder(a) - itemOrder(b);
    });

    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-msg';
      li.textContent = 'Пунктов пока нет';
      listEl.appendChild(li);
    } else {
      items.forEach(item => {
        const li = document.createElement('li');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!item.checked;
        cb.id = kind + '-cb-' + item.id;
        cb.addEventListener('change', () => toggleItem(kind, item.id, cb.checked));

        const label = document.createElement('label');
        label.htmlFor = cb.id;
        label.textContent = item.text;

        const btn = document.createElement('button');
        btn.className = 'remove-btn';
        btn.textContent = '×';
        btn.title = 'Удалить';
        btn.addEventListener('click', () => removeItem(kind, item.id));

        li.appendChild(cb); li.appendChild(label); li.appendChild(btn);
        listEl.appendChild(li);
      });
    }

    infoEl.textContent = kind === 'daily'
      ? 'сброс: ' + fmtMsk(nextDailyResetUTC())
      : 'сброс: ' + fmtMsk(nextWeeklyResetUTC());
  }

  // ============================================================
  //  РЕНДЕР расходов
  // ============================================================
  function renderTotal() {
    const el = document.getElementById('total-value');
    if (el) el.textContent = fmtMoney(state.expenses.total);
  }

  function computeDebts() {
    const total = Number(state.expenses.total) || 0;
    const fair = Math.ceil(total / 3);
    return PARTICIPANTS.map(name => {
      const contributed = Number(state.expenses.contributions[name]) || 0;
      const owes = Math.max(0, fair - contributed);
      return { name, contributed, owes, fair };
    });
  }

  function renderDebts() {
    const grid = document.getElementById('debts-grid');
    if (!grid) {
      console.warn('[app] #debts-grid не найден — обновите index.html');
      return;
    }
    grid.innerHTML = '';
    const debts = computeDebts();
    debts.forEach(d => {
      const block = document.createElement('div');
      block.className = 'debt-block' + (d.owes === 0 ? ' zero' : '');

      const nameEl = document.createElement('div');
      nameEl.className = 'debt-name';
      nameEl.textContent = d.name;

      const amountEl = document.createElement('div');
      amountEl.className = 'debt-amount';
      amountEl.textContent = d.owes === 0 ? '0 ₽' : fmtMoney(d.owes) + ' ₽';

      const hintEl = document.createElement('div');
      hintEl.className = 'debt-hint';
      hintEl.innerHTML = 'вложил <b>' + fmtMoney(d.contributed) + ' ₽</b><br>доля <b>' + fmtMoney(d.fair) + ' ₽</b>';

      block.appendChild(nameEl);
      block.appendChild(amountEl);
      block.appendChild(hintEl);
      grid.appendChild(block);
    });
  }

  function renderAll() {
    renderChecklist('daily');
    renderChecklist('weekly');
    renderTotal();
    renderDebts();
  }

  // ============================================================
  //  ДЕЙСТВИЯ: чек-листы
  // ============================================================
  function addItem(kind, text) {
    if (!text) return;
    const item = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text, checked: false, createdAt: Date.now()
    };
    if (!Array.isArray(state[kind].items)) state[kind].items = [];
    state[kind].items.push(item);
    renderChecklist(kind);
    if (stateRef) {
      enqueueWrite(() => txKind(kind, (base, items) => {
        items[item.id] = item;
        return { items };
      }), 'addItem ' + kind + '/' + item.id);
    }
  }

  function toggleItem(kind, id, checked) {
    const item = state[kind].items.find(i => i.id === id);
    if (!item) return;
    item.checked = checked;
    renderChecklist(kind);
    if (stateRef) {
      enqueueWrite(() => txKind(kind, (base, items) => {
        if (!items[id]) return;
        items[id].checked = checked;
        return { items };
      }), 'toggleItem ' + kind + '/' + id);
    }
  }

  function removeItem(kind, id) {
    state[kind].items = state[kind].items.filter(i => i.id !== id);
    renderChecklist(kind);
    if (stateRef) {
      enqueueWrite(() => txKind(kind, (base, items) => {
        if (!items[id]) return;
        delete items[id];
        return { items };
      }), 'removeItem ' + kind + '/' + id);
    }
  }

  // ============================================================
  //  ДЕЙСТВИЯ: расходы
  //  Сначала пробуем атомарную транзакцию на expenses.
  //  Если правило Firebase не разрешает запись в узел-родитель —
  //  падаем в fallback: две отдельные транзакции по листьям.
  // ============================================================
  function addExpense(person, amount) {
    if (!PARTICIPANTS.includes(person)) return;
    if (!(amount > 0)) return;

    // Оптимистично
    state.expenses.total = (Number(state.expenses.total) || 0) + amount;
    state.expenses.contributions[person] =
      (Number(state.expenses.contributions[person]) || 0) + amount;
    renderTotal();
    renderDebts();

    if (!stateRef) return;

    enqueueWrite(async () => {
      try {
        await stateRef.child('expenses').transaction(curr => {
          const base = (curr && typeof curr === 'object') ? curr : {};
          const total = (Number(base.total) || 0) + amount;
          const contribs = Object.assign(
            { ArhonDD: 0, eMachines: 0, Asta: 0 },
            base.contributions || {}
          );
          contribs[person] = (Number(contribs[person]) || 0) + amount;
          return { total, contributions: contribs };
        });
        console.log('[app] addExpense OK (parent tx):', person, '+', amount);
      } catch (e) {
        console.warn('[app] addExpense parent tx failed, FALLBACK:', e && e.message);
        await stateRef.child('expenses/total').transaction(v => (Number(v) || 0) + amount);
        await stateRef.child('expenses/contributions/' + person)
          .transaction(v => (Number(v) || 0) + amount);
        console.log('[app] addExpense OK (fallback):', person, '+', amount);
      }
    }, 'addExpense ' + person + ' +' + amount);
  }

  function resetDebt() {
    if (!confirm('Обнулить долг? Это действие нельзя отменить.')) return;
    state.expenses.total = 0;
    state.expenses.contributions = { ArhonDD: 0, eMachines: 0, Asta: 0 };
    renderTotal();
    renderDebts();

    if (stateRef) {
      enqueueWrite(async () => {
        try {
          // Атомарный update по конкретным путям —
          // работает даже при жёстких per-leaf правилах
          await stateRef.update({
            'expenses/total': 0,
            'expenses/contributions/ArhonDD': 0,
            'expenses/contributions/eMachines': 0,
            'expenses/contributions/Asta': 0
          });
          console.log('[app] resetDebt OK');
        } catch (e) {
          console.error('[app] resetDebt FAILED:', e && e.message);
          throw e;
        }
      }, 'resetDebt');
    }
  }

  // ============================================================
  //  ЧИСТКА фантомов
  // ============================================================
  async function cleanupPhantoms() {
    if (!stateRef) return;
    try {
      const snap = await stateRef.once('value');
      const data = snap.val();
      if (!data) return;

      for (const kind of ['daily', 'weekly']) {
        const raw = data[kind];
        if (!raw || !raw.items) continue;
        const items = raw.items;
        const entries = Array.isArray(items)
          ? items.map((v, i) => [String(i), v])
          : Object.entries(items);

        let needs = false;
        for (const [key, val] of entries) {
          if (!val || typeof val !== 'object') { needs = true; break; }
          if (/^\d+$/.test(key)) { needs = true; break; }
          if (!val.id || !val.text) { needs = true; break; }
          if (val.id !== key) { needs = true; break; }
        }
        if (!needs) continue;

        console.log('[app] cleanup needed for', kind);
        enqueueWrite(() => txKind(kind, (base, cleanItems) => {
          return { items: cleanItems };
        }), 'cleanup ' + kind);
      }
    } catch (e) { console.warn('[app] cleanup:', e); }
  }

  // ============================================================
  //  ТАЙМЕР
  // ============================================================
  let resetTimer = null;
  function scheduleReset() {
    if (resetTimer) clearTimeout(resetTimer);
    let delay = nextDailyResetUTC() - Date.now();
    if (delay < 0) delay = 1000;
    resetTimer = setTimeout(() => { autoReset(); scheduleReset(); }, delay + 500);
  }

  // ============================================================
  //  ИНИЦИАЛИЗАЦИЯ
  // ============================================================
  function getPerson() {
    const sel = document.getElementById('expense-person');
    return sel ? sel.value : 'ArhonDD';
  }

  function attachListeners() {
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };

    bind('daily-add', () => {
      const inp = document.getElementById('daily-input');
      if (!inp) return;
      const t = inp.value.trim();
      if (t) { addItem('daily', t); inp.value = ''; }
    });
    bind('weekly-add', () => {
      const inp = document.getElementById('weekly-input');
      if (!inp) return;
      const t = inp.value.trim();
      if (t) { addItem('weekly', t); inp.value = ''; }
    });
    bind('expense-add', () => {
      const inp = document.getElementById('expense-input');
      if (!inp) return;
      const v = parseFloat(inp.value);
      if (!isNaN(v) && v > 0) { addExpense(getPerson(), v); inp.value = ''; }
      else inp.focus();
    });
    bind('reset-debt', resetDebt);

    const d = document.getElementById('daily-input');
    if (d) d.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const t = d.value.trim(); if (t) { addItem('daily', t); d.value = ''; } }
    });
    const w = document.getElementById('weekly-input');
    if (w) w.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const t = w.value.trim(); if (t) { addItem('weekly', t); w.value = ''; } }
    });
    const ex = document.getElementById('expense-input');
    if (ex) ex.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = parseFloat(ex.value);
        if (!isNaN(v) && v > 0) { addExpense(getPerson(), v); ex.value = ''; }
      }
    });

    const sel = document.getElementById('expense-person');
    if (sel) {
      try {
        const saved = localStorage.getItem(PERSON_KEY);
        if (saved && PARTICIPANTS.includes(saved)) sel.value = saved;
      } catch (e) {}
      sel.addEventListener('change', () => {
        try { localStorage.setItem(PERSON_KEY, sel.value); } catch (e) {}
      });
    }
  }

  async function init() {
    try {
      const raw = localStorage.getItem('accounting_app_v1');
      if (raw) state = normalizeState(JSON.parse(raw));
    } catch (e) {}
    renderAll();
    attachListeners();

    if (stateRef) {
      await ensureExpensesStructure();
      await loadFromServer();
      attachServerListener();
      cleanupPhantoms();
    }

    autoReset();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && stateRef) loadFromServer().then(autoReset);
    });
    setInterval(() => { renderChecklist('daily'); renderChecklist('weekly'); }, 60 * 1000);
    setInterval(autoReset, 60 * 1000);

    scheduleReset();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();