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

  // ---------- Инициализация Firebase ----------
  let stateRef = null;
  try {
    if (typeof firebase !== 'undefined') {
      firebase.initializeApp(firebaseConfig);
      stateRef = firebase.database().ref('accounting_state');
    } else {
      console.warn('[app] Firebase SDK не загружен — работаем локально');
    }
  } catch (e) {
    console.warn('[app] Ошибка Firebase:', e);
    stateRef = null;
  }

  // ---------- Сброс в 06:00 МСК ----------
  const MSK_OFFSET_MIN = 3 * 60;        // UTC+3
  const RESET_HOUR_MSK = 6;             // ← было 5
  const RESET_MSK_MINUTES = RESET_HOUR_MSK * 60;
  // Сдвиг = (UTC+3) − 06:00 = −3 часа
  const SHIFT_MS = (MSK_OFFSET_MIN - RESET_MSK_MINUTES) * 60 * 1000;

  let state = defaultState();

  // ---------- Нормализация ----------
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
      if (Array.isArray(src.items)) {
        out[kind].items = src.items;
      } else if (src.items && typeof src.items === 'object') {
        out[kind].items = Object.values(src.items);
      }
      if (src.lastReset) out[kind].lastReset = src.lastReset;
    });

    if (raw.expenses && typeof raw.expenses.total === 'number') {
      out.expenses.total = raw.expenses.total;
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
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
    return target.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
  }

  function nextDailyResetUTC() {
    const now = Date.now();
    const s = new Date(now + SHIFT_MS);
    return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 1) - SHIFT_MS;
  }

  function nextWeeklyResetUTC() {
    const now = Date.now();
    const s = new Date(now + SHIFT_MS);
    const dayNr = (s.getUTCDay() + 6) % 7;
    let daysToMonday = (7 - dayNr) % 7;
    if (daysToMonday === 0) daysToMonday = 7;
    return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + daysToMonday) - SHIFT_MS;
  }

  function fmtMsk(utcMs) {
    const d = new Date(utcMs + 3 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + ' ' +
           pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' МСК';
  }

  // ---------- Синхронизация ----------
  let isSyncing = false;
  let pendingSave = false;
  let lastServerJson = '';

  function loadFromServer() {
    if (!stateRef) return Promise.resolve();
    return stateRef.once('value').then(snap => {
      const data = snap.val();
      if (data) {
        state = normalizeState(data);
        lastServerJson = JSON.stringify(data);
        renderAll();
      }
    }).catch(e => console.warn('[app] load:', e));
  }

  function saveToServer() {
    if (!stateRef) return;
    if (isSyncing) { pendingSave = true; return; }
    isSyncing = true;
    stateRef.set(state)
      .then(() => { lastServerJson = JSON.stringify(state); })
      .catch(e => console.warn('[app] save:', e))
      .finally(() => {
        isSyncing = false;
        if (pendingSave) { pendingSave = false; saveToServer(); }
      });
  }

  function save() {
    try { localStorage.setItem('accounting_app_v1', JSON.stringify(state)); } catch (e) {}
    saveToServer();
  }

  // ---------- Автосброс ----------
  function autoReset() {
    const t = accountingDateKey();
    const w = accountingWeekKey();
    let changed = false;

    if (state.daily.lastReset !== t) {
      state.daily.items = state.daily.items.map(i => ({ ...i, checked: false }));
      state.daily.lastReset = t;
      changed = true;
    }
    if (state.weekly.lastReset !== w) {
      state.weekly.items = state.weekly.items.map(i => ({ ...i, checked: false }));
      state.weekly.lastReset = w;
      changed = true;
    }
    if (changed) save();
  }

  // ---------- Рендер ----------
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
        cb.addEventListener('change', () => { item.checked = cb.checked; save(); });

        const label = document.createElement('label');
        label.htmlFor = cb.id;
        label.textContent = item.text;

        const btn = document.createElement('button');
        btn.className = 'remove-btn';
        btn.textContent = '×';
        btn.title = 'Удалить';
        btn.addEventListener('click', () => {
          state[kind].items = state[kind].items.filter(i => i.id !== item.id);
          save(); renderChecklist(kind);
        });

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

  // ---------- Действия ----------
  function addItem(kind, inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    if (!Array.isArray(state[kind].items)) state[kind].items = [];
    state[kind].items.push({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text, checked: false
    });
    input.value = '';
    save();
    renderChecklist(kind);
  }

  function addExpense() {
    const input = document.getElementById('expense-input');
    if (!input) return;
    const val = parseFloat(input.value);
    if (isNaN(val) || val <= 0) { input.focus(); return; }
    state.expenses.total = (Number(state.expenses.total) || 0) + val;
    input.value = '';
    save(); renderTotal();
  }

  function resetDebt() {
    if (confirm('Обнулить долг? Это действие нельзя отменить.')) {
      state.expenses.total = 0;
      save(); renderTotal();
    }
  }

  // ---------- Планировщик сброса ----------
  let resetTimer = null;
  function scheduleReset() {
    if (resetTimer) clearTimeout(resetTimer);
    let delay = nextDailyResetUTC() - Date.now();
    if (delay < 0) delay = 1000;
    resetTimer = setTimeout(() => {
      autoReset(); renderAll(); scheduleReset();
    }, delay + 500);
  }

  // ---------- Обработчики ----------
  function attachListeners() {
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };
    bind('daily-add', () => addItem('daily', 'daily-input'));
    bind('weekly-add', () => addItem('weekly', 'weekly-input'));
    bind('expense-add', addExpense);
    bind('reset-debt', resetDebt);

    const d = document.getElementById('daily-input');
    if (d) d.addEventListener('keydown', e => { if (e.key === 'Enter') addItem('daily', 'daily-input'); });
    const w = document.getElementById('weekly-input');
    if (w) w.addEventListener('keydown', e => { if (e.key === 'Enter') addItem('weekly', 'weekly-input'); });
    const ex = document.getElementById('expense-input');
    if (ex) ex.addEventListener('keydown', e => { if (e.key === 'Enter') addExpense(); });
  }

  // ---------- Инициализация ----------
  function init() {
    try {
      const raw = localStorage.getItem('accounting_app_v1');
      if (raw) state = normalizeState(JSON.parse(raw));
    } catch (e) {}
    autoReset();
    renderAll();

    attachListeners();

    if (stateRef) {
      loadFromServer().then(() => { autoReset(); renderAll(); });

      stateRef.on('value', snap => {
        const data = snap.val();
        if (!data) return;
        const serverJson = JSON.stringify(data);
        if (serverJson !== lastServerJson) {
          state = normalizeState(data);
          lastServerJson = serverJson;
          autoReset();
          renderAll();
        }
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (stateRef) loadFromServer().then(() => { autoReset(); renderAll(); });
        else { autoReset(); renderAll(); }
      }
    });

    setInterval(() => { renderChecklist('daily'); renderChecklist('weekly'); }, 60 * 1000);
    scheduleReset();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();