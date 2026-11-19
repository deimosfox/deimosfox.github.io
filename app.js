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

  // ---------- State ----------
  let state = defaultState();

  function defaultState() {
    return {
      daily: { items: [], lastReset: null },
      weekly: { items: [], lastReset: null },
      expenses: { total: 0 }
    };
  }

  function normalizeState(raw) {
    const out = defaultState();
    if (!raw || typeof raw !== 'object') return out;
    ['daily', 'weekly'].forEach(kind => {
      const src = raw[kind];
      if (!src) return;
      if (Array.isArray(src.items)) out[kind].items = src.items;
      else if (src.items && typeof src.items === 'object')
        out[kind].items = Object.values(src.items);
      if (src.lastReset) out[kind].lastReset = src.lastReset;
    });
    if (raw.expenses && typeof raw.expenses.total === 'number')
      out.expenses.total = raw.expenses.total;
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

  // ============================================================
  //  WRITE QUEUE — все операции идут последовательно
  // ============================================================
  const writeQueue = [];
  let isProcessingQueue = false;

  function enqueueWrite(fn, description) {
    writeQueue.push({ fn, description, createdAt: Date.now() });
    if (!isProcessingQueue) processQueue();
  }

  async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    try {
      while (writeQueue.length > 0) {
        const item = writeQueue[0];
        let succeeded = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            await item.fn();
            succeeded = true;
            break;
          } catch (e) {
            console.warn('[app] Write attempt ' + attempt + ' failed:',
              item.description, e);
            if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 800));
          }
        }
        if (!succeeded) console.error('[app] Giving up on:', item.description);
        writeQueue.shift();
      }
    } finally {
      isProcessingQueue = false;
      // Финальная синхронизация: забираем актуальные данные с сервера.
      // Нужно потому, что во время обработки очереди мы пропускали
      // события realtime-листенера, чтобы не затирать локальные оптимистичные изменения.
      if (stateRef) {
        try {
          const snap = await stateRef.once('value');
          if (snap && snap.val()) applyServerData(snap.val());
        } catch (e) { console.warn('[app] Final sync:', e); }
      }
    }
  }

  // ============================================================
  //  REALTIME SYNC (Firebase → локальный state)
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
      // Пока идут локальные записи — не трогаем state,
      // иначе затрём оптимистичные изменения пользователя.
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
  //  АВТОСБРОС (06:00 МСК) — через transaction
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
    enqueueWrite(async () => {
      await stateRef.child(kind).transaction(data => {
        // Если на сервере уже новый ключ — ничего не делаем
        if (data && data.lastReset === newKey) return; // undefined = отмена
        const items = (data && data.items) || {};
        Object.keys(items).forEach(id => {
          if (items[id] && typeof items[id] === 'object') {
            items[id].checked = false;
          }
        });
        return { items, lastReset: newKey };
      });
    }, 'autoReset ' + kind);
  }

  // ============================================================
  //  РЕНДЕР
  // ============================================================
  function renderChecklist(kind) {
    const data = state[kind];
    const listEl = document.getElementById(kind + '-list');
    const infoEl = document.getElementById(kind + '-reset-info');
    if (!listEl || !infoEl) return;
    listEl.innerHTML = '';

    if (!data.items || data.items.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-msg';
      li.textContent = 'Пунктов пока нет';
      listEl.appendChild(li);
    } else {
      data.items.forEach(item => {
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

  function renderTotal() {
    const total = Number(state.expenses.total) || 0;
    const el = document.getElementById('total-value');
    if (el) el.textContent = total.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }

  function renderAll() { renderChecklist('daily'); renderChecklist('weekly'); renderTotal(); }

  // ============================================================
  //  ДЕЙСТВИЯ — каждая операция = только точечный путь в Firebase
  // ============================================================
  function addItem(kind, text) {
    if (!text) return;
    const item = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text, checked: false
    };
    // 1) Оптимистично обновляем UI
    if (!Array.isArray(state[kind].items)) state[kind].items = [];
    state[kind].items.push(item);
    renderChecklist(kind);
    // 2) Ставим в очередь точечную запись (никакой перезаписи всего дерева)
    if (stateRef) {
      enqueueWrite(
        () => stateRef.child(kind + '/items/' + item.id).set(item),
        'addItem ' + kind + '/' + item.id
      );
    }
  }

  function toggleItem(kind, id, checked) {
    const item = state[kind].items.find(i => i.id === id);
    if (item) item.checked = checked;
    if (stateRef) {
      enqueueWrite(
        () => stateRef.child(kind + '/items/' + id + '/checked').set(checked),
        'toggleItem ' + kind + '/' + id
      );
    }
  }

  function removeItem(kind, id) {
    state[kind].items = state[kind].items.filter(i => i.id !== id);
    renderChecklist(kind);
    if (stateRef) {
      enqueueWrite(
        () => stateRef.child(kind + '/items/' + id).remove(),
        'removeItem ' + kind + '/' + id
      );
    }
  }

  function addExpense(amount) {
    // Оптимистично
    state.expenses.total = (Number(state.expenses.total) || 0) + amount;
    renderTotal();
    // Атомарное прибавление через transaction —
    // два одновременных addExpense от разных пользователей НЕ потеряются
    if (stateRef) {
      enqueueWrite(
        () => stateRef.child('expenses/total').transaction(v => (Number(v) || 0) + amount),
        'addExpense +' + amount
      );
    }
  }

  function resetDebt() {
    if (!confirm('Обнулить долг? Это действие нельзя отменить.')) return;
    state.expenses.total = 0;
    renderTotal();
    if (stateRef) {
      enqueueWrite(
        () => stateRef.child('expenses/total').set(0),
        'resetDebt'
      );
    }
  }

  // ============================================================
  //  ТАЙМЕР АВТОСБРОСА
  // ============================================================
  let resetTimer = null;
  function scheduleReset() {
    if (resetTimer) clearTimeout(resetTimer);
    let delay = nextDailyResetUTC() - Date.now();
    if (delay < 0) delay = 1000;
    resetTimer = setTimeout(() => {
      autoReset();
      scheduleReset();
    }, delay + 500);
  }

  // ============================================================
  //  ОБРАБОТЧИКИ И ИНИЦИАЛИЗАЦИЯ
  // ============================================================
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
      if (!isNaN(v) && v > 0) { addExpense(v); inp.value = ''; }
      else inp.focus();
    });
    bind('reset-debt', resetDebt);

    const d = document.getElementById('daily-input');
    if (d) d.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const t = d.value.trim();
        if (t) { addItem('daily', t); d.value = ''; }
      }
    });
    const w = document.getElementById('weekly-input');
    if (w) w.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const t = w.value.trim();
        if (t) { addItem('weekly', t); w.value = ''; }
      }
    });
    const ex = document.getElementById('expense-input');
    if (ex) ex.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = parseFloat(ex.value);
        if (!isNaN(v) && v > 0) { addExpense(v); ex.value = ''; }
      }
    });
  }

  async function init() {
    // 1) локальный кеш — мгновенный отклик
    try {
      const raw = localStorage.getItem('accounting_app_v1');
      if (raw) state = normalizeState(JSON.parse(raw));
    } catch (e) {}
    renderAll();

    // 2) сразу привязываем кнопки
    attachListeners();

    // 3) синхронизация с сервером
    if (stateRef) {
      await loadFromServer();
      attachServerListener();
    }

    // 4) проверка автосброса — ПОСЛЕ получения актуального lastReset
    autoReset();

    // 5) периодические проверки
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && stateRef) {
        loadFromServer().then(autoReset);
      }
    });
    setInterval(() => {
      renderChecklist('daily');
      renderChecklist('weekly');
    }, 60 * 1000);
    setInterval(autoReset, 60 * 1000);

    scheduleReset();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();