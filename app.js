(function() {
  'use strict';

  // ---------- Конфигурация Firebase ----------
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

  // Инициализация Firebase
  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();
  const stateRef = db.ref('accounting_state');

  // Сброс ровно в 05:00 МСК (UTC+3)
  const MSK_OFFSET_MIN = 3 * 60;
  const RESET_HOUR_MSK = 5;
  const RESET_MSK_MINUTES = RESET_HOUR_MSK * 60;
  const SHIFT_MS = (MSK_OFFSET_MIN - RESET_MSK_MINUTES) * 60 * 1000; // = -2ч

  let state = {
    daily: { items: [], lastReset: null },
    weekly: { items: [], lastReset: null },
    expenses: { total: 0 }
  };

  // ---------- Время (05:00 МСК) ----------
  function shiftedNow() {
    return new Date(Date.now() + SHIFT_MS);
  }

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
    const diff = target - firstThursday;
    const week = 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
    return target.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
  }

  function nextDailyResetUTC() {
    const now = Date.now();
    const nowShifted = new Date(now + SHIFT_MS);
    const nextMidnightShifted = Date.UTC(
      nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate() + 1, 0, 0, 0, 0
    );
    return nextMidnightShifted - SHIFT_MS;
  }

  function nextWeeklyResetUTC() {
    const now = Date.now();
    const nowShifted = new Date(now + SHIFT_MS);
    const dayNr = (nowShifted.getUTCDay() + 6) % 7;
    let daysToMonday = (7 - dayNr) % 7;
    if (daysToMonday === 0) daysToMonday = 7;
    const nextMonShifted = Date.UTC(
      nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate() + daysToMonday,
      0, 0, 0, 0
    );
    return nextMonShifted - SHIFT_MS;
  }

  function fmtMsk(utcMs) {
    const d = new Date(utcMs + 3 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + ' ' +
           pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' МСК';
  }

  // ---------- Синхронизация с Firebase ----------
  let isSyncing = false;
  let pendingSave = false;
  let lastServerJson = ''; // для отслеживания реальных изменений

  function loadFromServer() {
    return stateRef.once('value').then(snapshot => {
      const data = snapshot.val();
      if (data) {
        state = Object.assign(state, data);
        lastServerJson = JSON.stringify(state);
        renderAll();
      }
    }).catch(e => console.warn('Ошибка загрузки с Firebase:', e));
  }

  function saveToServer() {
    if (isSyncing) { pendingSave = true; return; }
    isSyncing = true;
    stateRef.set(state)
      .then(() => { lastServerJson = JSON.stringify(state); })
      .catch(e => console.warn('Ошибка сохранения в Firebase:', e))
      .finally(() => {
        isSyncing = false;
        if (pendingSave) { pendingSave = false; saveToServer(); }
      });
  }

  function save() {
    // Локальный кеш — мгновенно
    try { localStorage.setItem('accounting_app_v1', JSON.stringify(state)); } catch (e) {}
    // Отправка в Firebase — асинхронно
    saveToServer();
  }

  // ---------- Автосброс чек-листов ----------
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
    listEl.innerHTML = '';

    if (data.items.length === 0) {
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
          state[kind].items = data.items.filter(i => i.id !== item.id);
          save(); renderChecklist(kind);
        });

        li.appendChild(cb); li.appendChild(label); li.appendChild(btn);
        listEl.appendChild(li);
      });
    }

    if (kind === 'daily') {
      infoEl.textContent = 'сброс: ' + fmtMsk(nextDailyResetUTC());
    } else {
      infoEl.textContent = 'сброс: ' + fmtMsk(nextWeeklyResetUTC());
    }
  }

  function renderTotal() {
    const total = Number(state.expenses.total) || 0;
    document.getElementById('total-value').textContent =
      total.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }

  function renderAll() { renderChecklist('daily'); renderChecklist('weekly'); renderTotal(); }

  // ---------- Действия ----------
  function addItem(kind, inputId) {
    const input = document.getElementById(inputId);
    const text = input.value.trim();
    if (!text) return;
    state[kind].items.push({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text, checked: false
    });
    input.value = ''; save(); renderChecklist(kind);
  }

  function addExpense() {
    const input = document.getElementById('expense-input');
    const val = parseFloat(input.value);
    if (isNaN(val) || val <= 0) { input.focus(); return; }
    state.expenses.total = (Number(state.expenses.total) || 0) + val;
    input.value = ''; save(); renderTotal();
  }

  function resetDebt() {
    if (confirm('Обнулить долг? Это действие нельзя отменить.')) {
      state.expenses.total = 0; save(); renderTotal();
    }
  }

  // ---------- Планировщик сброса на 05:00 МСК ----------
  let resetTimer = null;

  function scheduleReset() {
    if (resetTimer) clearTimeout(resetTimer);
    let delay = nextDailyResetUTC() - Date.now();
    if (delay < 0) delay = 1000;
    resetTimer = setTimeout(() => {
      autoReset();
      renderAll();
      scheduleReset();
    }, delay + 500);
  }

  // ---------- Инициализация ----------
  async function init() {
    // Сначала локальный кеш (мгновенный отклик)
    try {
      const raw = localStorage.getItem('accounting_app_v1');
      if (raw) state = Object.assign(state, JSON.parse(raw));
    } catch (e) {}
    autoReset();
    renderAll();

    // Затем — свежие данные с Firebase
    await loadFromServer();
    autoReset();
    renderAll();

    document.getElementById('daily-add').addEventListener('click', () => addItem('daily', 'daily-input'));
    document.getElementById('weekly-add').addEventListener('click', () => addItem('weekly', 'weekly-input'));
    document.getElementById('daily-input').addEventListener('keydown', e => { if (e.key === 'Enter') addItem('daily', 'daily-input'); });
    document.getElementById('weekly-input').addEventListener('keydown', e => { if (e.key === 'Enter') addItem('weekly', 'weekly-input'); });
    document.getElementById('expense-add').addEventListener('click', addExpense);
    document.getElementById('expense-input').addEventListener('keydown', e => { if (e.key === 'Enter') addExpense(); });
    document.getElementById('reset-debt').addEventListener('click', resetDebt);

    // Синхронизация в реальном времени: любые изменения в Firebase
    // (от других пользователей или этого же) применяются к state
    stateRef.on('value', snapshot => {
      const data = snapshot.val();
      if (!data) return;
      const serverJson = JSON.stringify(data);
      // Если пришло изменение, которое мы ещё не применили
      if (serverJson !== lastServerJson) {
        state = Object.assign(state, data);
        lastServerJson = serverJson;
        autoReset();
        renderAll();
      }
    });

    // При возвращении на вкладку — подтягиваем свежие данные
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        loadFromServer().then(() => { autoReset(); renderAll(); });
      }
    });

    // Раз в минуту — обновление подписей о времени сброса
    setInterval(() => {
      renderChecklist('daily');
      renderChecklist('weekly');
    }, 60 * 1000);

    scheduleReset();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();