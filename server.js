'use strict';

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { Telegraf, Markup } = require('telegraf');
const fs         = require('fs');
const path       = require('path');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const BOT_TOKEN   = '8741536202:AAEtCUR6sgFcnFucx9pCDc4dDycdeUjR4ZA';
const SUPER_ADMIN = 7108575486;
const PORT        = process.env.PORT || 3000;
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 часа
const DATA_FILE   = path.join(__dirname, 'data.json');

// ─────────────────────────────────────────────
// ШИФРОВАНИЕ (XOR + ключ "Апликатор")
// ─────────────────────────────────────────────
const CIPHER_KEY = 'Апликатор';
function xorCipher(text) {
  const keyBuf  = Buffer.from(CIPHER_KEY, 'utf8');
  const textBuf = Buffer.from(text, 'utf8');
  const out     = Buffer.alloc(textBuf.length);
  for (let i = 0; i < textBuf.length; i++)
    out[i] = textBuf[i] ^ keyBuf[i % keyBuf.length];
  return out.toString('hex');
}
const encryptPass = xorCipher;
const decryptPass = xorCipher;

// ─────────────────────────────────────────────
// DATA
// ─────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return { staffCredentials: [], orderCounter: 1 };
}
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch {}
}

let appData = loadData();
if (!appData.staffCredentials.length) {
  appData.staffCredentials = [{ login: 'Fortoona', passEnc: encryptPass('Logistik'), label: 'Курьер 1' }];
  saveData(appData);
}

function checkPass(cred, input) {
  if (cred.pass !== undefined) return cred.pass === input; // обратная совместимость
  return decryptPass(cred.passEnc) === input;
}

// ─────────────────────────────────────────────
// RUNTIME STATE
// ─────────────────────────────────────────────
const authorizedStaff = new Map(); // id → { expiresAt, firstName, username, login }
const pendingLogin    = new Map(); // id → { step: 'login'|'pass', login? }
const pendingAction   = new Map(); // id → { action: 'add_login'|'add_pass'|'add_label'|'broadcast', data: {} }
const activeOrders    = new Map(); // orderId → entry

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function isAuthorized(id) {
  if (id === SUPER_ADMIN) return true;
  const s = authorizedStaff.get(id);
  if (!s) return false;
  if (Date.now() > s.expiresAt) { authorizedStaff.delete(id); return false; }
  return true;
}
function getStaffName(id) {
  if (id === SUPER_ADMIN) return '👑 Супер-Админ';
  const s = authorizedStaff.get(id);
  if (!s) return `Сотрудник (${id})`;
  return s.username ? `@${s.username}` : s.firstName || `Сотрудник (${id})`;
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmt(n) { return Number(n).toLocaleString('uk-UA') + ' грн'; }

// ─────────────────────────────────────────────
// KEYBOARDS
// ─────────────────────────────────────────────

// Постоянная клавиатура внизу для СУПЕР-АДМИНА
const adminMainKeyboard = Markup.keyboard([
  ['📋 Заказы',    '📊 Статистика'],
  ['👥 Сотрудники','📢 Рассылка'],
]).resize();

// Постоянная клавиатура для СОТРУДНИКА (авторизован)
const staffKeyboard = Markup.keyboard([
  ['📋 Мои смены', '🚪 Выйти со смены'],
]).resize();

// Инлайн-кнопки главного меню СОТРУДНИКОВ (список в панели управления)
function staffManageKeyboard() {
  const d = loadData();
  const rows = d.staffCredentials.map(s =>
    [Markup.button.callback(
      `👤 ${s.label || s.login}`,
      `staff_view:${s.login}`
    )]
  );
  rows.push([Markup.button.callback('➕ Добавить сотрудника', 'staff_add')]);
  rows.push([Markup.button.callback('🔙 Назад', 'admin_back')]);
  return Markup.inlineKeyboard(rows);
}

// Инлайн-кнопки карточки конкретного сотрудника
function staffCardKeyboard(login) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Удалить', `staff_del:${login}`),
     Markup.button.callback('🔓 Пароль', `staff_pass:${login}`)],
    [Markup.button.callback('🔙 Назад к списку', 'staff_list')],
  ]);
}

// Инлайн-кнопки заказа
function orderKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Принять',   `accept:${orderId}`),
     Markup.button.callback('🚚 В пути',    `transit:${orderId}`)],
    [Markup.button.callback('🏁 Выполнен',  `done:${orderId}`),
     Markup.button.callback('❌ Отмена',    `cancel:${orderId}`)],
  ]);
}

// ─────────────────────────────────────────────
// ORDER HELPERS
// ─────────────────────────────────────────────
function formatOrder(order, orderNum, acceptedBy, status) {
  const { client, items, total } = order;
  const dateStr = new Date(order.createdAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const statusMap = { new:'🆕 Новый', accepted:'✅ Принят', transit:'🚚 В пути', done:'🏁 Выполнен', cancelled:'❌ Отменён' };

  const itemLines = items.map(it =>
    `  • ${esc(it.name)}${it.extra ? ` <i>(${esc(it.extra)})</i>` : ''} × ${it.qty} — <b>${fmt(it.total)}</b>`
  ).join('\n');

  return [
    `🌿 <b>FORTOONA — Заказ #${orderNum}</b>`,
    `🕐 ${dateStr} | ${statusMap[status] || status}\n`,
    `👤 <b>Клиент:</b> ${esc(client.name)}`,
    `📞 <b>Телефон:</b> ${esc(client.phone)}`,
    client.username ? `💬 <b>Telegram:</b> ${esc(client.username)}` : null,
    `📍 <b>Адрес:</b> ${esc(client.address)}`,
    `🕐 <b>Время:</b> ${esc(client.time)}`,
    client.comment ? `💬 <b>Коммент:</b> ${esc(client.comment)}` : null,
    `\n🛒 <b>Состав:</b>\n${itemLines}\n`,
    `💰 <b>Итого: ${fmt(total)}</b>`,
    acceptedBy ? `\n👤 <b>Принял:</b> ${esc(acceptedBy)}` : null,
  ].filter(Boolean).join('\n');
}

async function broadcastOrderUpdate(orderId) {
  const entry = activeOrders.get(orderId);
  if (!entry) return;
  const text     = formatOrder(entry.order, entry.orderNum, entry.acceptedBy, entry.status);
  const isClosed = entry.status === 'done' || entry.status === 'cancelled';
  const markup   = isClosed ? { inline_keyboard: [] } : orderKeyboard(orderId).reply_markup;

  const edits = [...entry.messageIds.entries()].map(([chatId, msgId]) =>
    bot.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'HTML', reply_markup: markup }).catch(() => {})
  );
  await Promise.allSettled(edits);
}

// ─────────────────────────────────────────────
// EXPRESS API
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/order', async (req, res) => {
  try {
    const order    = req.body;
    const orderId  = `ORD-${Date.now()}`;
    appData        = loadData();
    const orderNum = appData.orderCounter++;
    order.createdAt = order.createdAt || new Date().toISOString();
    saveData(appData);

    const text = formatOrder(order, orderNum, null, 'new');
    activeOrders.set(orderId, { order, orderNum, status: 'new', acceptedBy: null, messageIds: new Map(), createdAt: Date.now() });

    const recipients = new Set([SUPER_ADMIN]);
    for (const [id, s] of authorizedStaff)
      if (Date.now() < s.expiresAt) recipients.add(id);

    await Promise.allSettled([...recipients].map(async chatId => {
      try {
        const msg = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...orderKeyboard(orderId) });
        activeOrders.get(orderId).messageIds.set(chatId, msg.message_id);
      } catch (e) { console.error(`Send failed ${chatId}:`, e.message); }
    }));

    return res.json({ ok: true, orderId, orderNum });
  } catch (e) { console.error(e); return res.status(500).json({ ok: false }); }
});

// ─────────────────────────────────────────────
// BOT
// ─────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ── /start ───────────────────────────────────
bot.start(async (ctx) => {
  const id = ctx.from.id;
  pendingLogin.delete(id);
  pendingAction.delete(id);

  if (id === SUPER_ADMIN) {
    return ctx.replyWithHTML(
      `👑 <b>Добро пожаловать, Супер-Админ!</b>\n\nВыберите действие:`,
      adminMainKeyboard
    );
  }

  if (isAuthorized(id)) {
    return ctx.replyWithHTML(
      `✅ <b>Вы на смене.</b> Ожидайте заказы.`,
      staffKeyboard
    );
  }

  pendingLogin.set(id, { step: 'login' });
  return ctx.replyWithHTML(
    `🌿 <b>FORTOONA</b>\n\nВведите ваш <b>логин</b>:`,
    Markup.removeKeyboard()
  );
});

// ─────────────────────────────────────────────
// REPLY-KEYBOARD КНОПКИ (нижние) — ADMIN
// ─────────────────────────────────────────────
bot.hears('📋 Заказы', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return;
  const active = [...activeOrders.values()].filter(e => e.status !== 'done' && e.status !== 'cancelled');
  if (!active.length) {
    return ctx.replyWithHTML('🟢 <b>Активных заказов нет</b>', adminMainKeyboard);
  }
  const lines = active.map(e => {
    const statusMap = { new:'🆕', accepted:'✅', transit:'🚚', done:'🏁', cancelled:'❌' };
    return `${statusMap[e.status] || ''} <b>#${e.orderNum}</b> — ${esc(e.order.client.name)} — ${fmt(e.order.total)}`;
  });
  return ctx.replyWithHTML(
    `📋 <b>Активные заказы (${active.length}):</b>\n\n` + lines.join('\n'),
    adminMainKeyboard
  );
});

bot.hears('📊 Статистика', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  let done = 0, revenue = 0, active = 0;
  for (const e of activeOrders.values()) {
    if (e.status === 'done' && e.createdAt >= todayStart.getTime()) { done++; revenue += e.order.total; }
    if (e.status !== 'done' && e.status !== 'cancelled') active++;
  }
  return ctx.replyWithHTML(
    `📊 <b>Статистика за сегодня</b>\n\n` +
    `✅ Выполнено: <b>${done}</b>\n` +
    `💰 Выручка: <b>${fmt(revenue)}</b>\n` +
    `🔄 В работе: <b>${active}</b>\n` +
    `👥 На смене: <b>${authorizedStaff.size}</b>`,
    adminMainKeyboard
  );
});

bot.hears('👥 Сотрудники', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return;
  const d = loadData();
  const onShift = [...authorizedStaff.keys()];
  return ctx.replyWithHTML(
    `👥 <b>Управление сотрудниками</b>\n\nВсего учёток: <b>${d.staffCredentials.length}</b> | На смене: <b>${onShift.length}</b>\n\nВыберите сотрудника или добавьте нового:`,
    staffManageKeyboard()
  );
});

bot.hears('📢 Рассылка', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return;
  if (authorizedStaff.size === 0) {
    return ctx.reply('👥 Нет сотрудников на смене.', adminMainKeyboard);
  }
  pendingAction.set(ctx.from.id, { action: 'broadcast' });
  return ctx.replyWithHTML(
    `📢 <b>Рассылка</b>\n\nНапишите сообщение, которое получат все сотрудники на смене (${authorizedStaff.size} чел.):`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_back')]])
  );
});

// ─────────────────────────────────────────────
// REPLY-KEYBOARD КНОПКИ — STAFF
// ─────────────────────────────────────────────
bot.hears('📋 Мои смены', async (ctx) => {
  const id = ctx.from.id;
  if (!isAuthorized(id)) return;
  const s = authorizedStaff.get(id);
  if (!s) return;
  const exp = new Date(s.expiresAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  return ctx.replyWithHTML(
    `✅ <b>Вы на смене</b>\n\n👤 ${s.firstName}\nЛогин: <code>${s.login}</code>\nДействует до: ${exp}`,
    staffKeyboard
  );
});

bot.hears('🚪 Выйти со смены', async (ctx) => {
  const id = ctx.from.id;
  if (!authorizedStaff.has(id)) {
    return ctx.reply('Вы не авторизованы.', Markup.removeKeyboard());
  }
  authorizedStaff.delete(id);
  try {
    await bot.telegram.sendMessage(SUPER_ADMIN,
      `🔴 Сотрудник <b>${ctx.from.first_name || '?'}</b> вышел со смены.`, { parse_mode: 'HTML' }
    );
  } catch {}
  return ctx.replyWithHTML('👋 <b>Вы вышли со смены.</b>\n\nДо свидания!', Markup.removeKeyboard());
});

// ─────────────────────────────────────────────
// INLINE CALLBACKS
// ─────────────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  const data   = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  // ── Кнопки заказа ───────────────────────────
  if (/^(accept|transit|done|cancel):/.test(data)) {
    if (!isAuthorized(userId))
      return ctx.answerCbQuery('⛔ Сначала авторизуйтесь.', { show_alert: true });

    const [action, orderId] = data.split(':');
    const entry = activeOrders.get(orderId);
    if (!entry) return ctx.answerCbQuery('❓ Заказ не найден.', { show_alert: true });

    const staffName = getStaffName(userId);
    if (action === 'accept')  { entry.status = 'accepted'; entry.acceptedBy = staffName; }
    if (action === 'transit') { entry.status = 'transit';  if (!entry.acceptedBy) entry.acceptedBy = staffName; }
    if (action === 'done')    { entry.status = 'done';     if (!entry.acceptedBy) entry.acceptedBy = staffName; }
    if (action === 'cancel')  { entry.status = 'cancelled'; }

    await broadcastOrderUpdate(orderId);
    return ctx.answerCbQuery('✅ Статус обновлён!');
  }

  // ── Только для супер-админа ──────────────────
  if (userId !== SUPER_ADMIN) return ctx.answerCbQuery('⛔ Нет доступа.', { show_alert: true });

  // Назад в главное меню
  if (data === 'admin_back') {
    pendingAction.delete(userId);
    await ctx.editMessageText('Выберите действие:', adminMainKeyboard);
    return ctx.answerCbQuery();
  }

  // Список сотрудников
  if (data === 'staff_list') {
    const d = loadData();
    await ctx.editMessageText(
      `👥 <b>Управление сотрудниками</b>\nВсего: <b>${d.staffCredentials.length}</b>`,
      { parse_mode: 'HTML', ...staffManageKeyboard() }
    );
    return ctx.answerCbQuery();
  }

  // Карточка сотрудника
  if (data.startsWith('staff_view:')) {
    const login = data.split(':')[1];
    const d     = loadData();
    const cred  = d.staffCredentials.find(s => s.login === login);
    if (!cred) { await ctx.answerCbQuery('Не найден', { show_alert: true }); return; }
    const onShift = [...authorizedStaff.values()].some(s => s.login === login);
    await ctx.editMessageText(
      `👤 <b>${cred.label || cred.login}</b>\n\nЛогин: <code>${cred.login}</code>\nСтатус: ${onShift ? '🟢 На смене' : '⚫ Не в сети'}`,
      { parse_mode: 'HTML', ...staffCardKeyboard(login) }
    );
    return ctx.answerCbQuery();
  }

  // Показать пароль сотрудника
  if (data.startsWith('staff_pass:')) {
    const login = data.split(':')[1];
    const d     = loadData();
    const cred  = d.staffCredentials.find(s => s.login === login);
    if (!cred) return ctx.answerCbQuery('Не найден', { show_alert: true });
    const plain = cred.passEnc ? decryptPass(cred.passEnc) : (cred.pass || '???');
    await ctx.answerCbQuery(`🔓 Пароль: ${plain}`, { show_alert: true });
    return;
  }

  // Удалить сотрудника — запрос подтверждения
  if (data.startsWith('staff_del:')) {
    const login = data.split(':')[1];
    await ctx.editMessageText(
      `❓ <b>Удалить сотрудника "${login}"?</b>\n\nЭто действие нельзя отменить.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Да, удалить', `staff_del_confirm:${login}`)],
          [Markup.button.callback('❌ Отмена', `staff_view:${login}`)],
        ])
      }
    );
    return ctx.answerCbQuery();
  }

  // Удалить — подтверждено
  if (data.startsWith('staff_del_confirm:')) {
    const login = data.split(':')[1];
    const d = loadData();
    d.staffCredentials = d.staffCredentials.filter(s => s.login !== login);
    saveData(d);
    for (const [id, s] of authorizedStaff)
      if (s.login === login) {
        authorizedStaff.delete(id);
        bot.telegram.sendMessage(id, '⛔ Ваш аккаунт был удалён администратором.').catch(() => {});
      }
    await ctx.editMessageText(
      `✅ <b>Сотрудник "${login}" удалён.</b>`,
      { parse_mode: 'HTML', ...staffManageKeyboard() }
    );
    return ctx.answerCbQuery('Удалено');
  }

  // Начать добавление сотрудника
  if (data === 'staff_add') {
    pendingAction.set(userId, { action: 'add_login', data: {} });
    await ctx.editMessageText(
      `➕ <b>Новый сотрудник</b>\n\nШаг 1 из 3\nВведите <b>логин</b> (латиница, без пробелов):`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'staff_list')]]) }
    );
    return ctx.answerCbQuery();
  }

  return ctx.answerCbQuery();
});

// ─────────────────────────────────────────────
// ТЕКСТОВЫЕ СООБЩЕНИЯ
// ─────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text   = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  // ── СУПЕР-АДМИН: ввод данных нового сотрудника или рассылка ──────
  if (userId === SUPER_ADMIN) {
    const pending = pendingAction.get(userId);
    if (!pending) return;

    // Рассылка
    if (pending.action === 'broadcast') {
      pendingAction.delete(userId);
      if (authorizedStaff.size === 0) {
        return ctx.replyWithHTML('👥 Нет сотрудников на смене.', adminMainKeyboard);
      }
      let sent = 0;
      for (const [id] of authorizedStaff) {
        try {
          await bot.telegram.sendMessage(id,
            `📢 <b>Сообщение от администратора:</b>\n\n${esc(text)}`, { parse_mode: 'HTML' });
          sent++;
        } catch {}
      }
      return ctx.replyWithHTML(`✅ <b>Отправлено ${sent} сотрудникам.</b>`, adminMainKeyboard);
    }

    // Добавление сотрудника — шаг 1: логин
    if (pending.action === 'add_login') {
      if (!/^[a-zA-Z0-9_]{2,30}$/.test(text)) {
        return ctx.replyWithHTML(
          `⚠️ Логин должен содержать только латиницу, цифры или _, от 2 до 30 символов.\n\nПопробуйте снова:`,
          Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'staff_list')]])
        );
      }
      const d = loadData();
      if (d.staffCredentials.find(s => s.login === text)) {
        return ctx.replyWithHTML(
          `⚠️ Логин <code>${text}</code> уже занят. Введите другой:`,
          Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'staff_list')]])
        );
      }
      pending.action = 'add_pass';
      pending.data.login = text;
      return ctx.replyWithHTML(
        `➕ <b>Новый сотрудник</b>\n\nШаг 2 из 3\nЛогин: <code>${text}</code>\n\nВведите <b>пароль</b>:`,
        Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'staff_list')]])
      );
    }

    // Добавление сотрудника — шаг 2: пароль
    if (pending.action === 'add_pass') {
      if (text.length < 3) {
        return ctx.reply(
          'Пароль слишком короткий (минимум 3 символа). Попробуйте снова:',
          Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'staff_list')]])
        );
      }
      pending.action = 'add_label';
      pending.data.pass = text;
      return ctx.replyWithHTML(
        `➕ <b>Новый сотрудник</b>\n\nШаг 3 из 3\nЛогин: <code>${pending.data.login}</code>\nПароль: <code>${text}</code>\n\nВведите <b>имя / метку</b> (например: "Курьер Андрей"):`,
        Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'staff_list')]])
      );
    }

    // Добавление сотрудника — шаг 3: метка
    if (pending.action === 'add_label') {
      const { login, pass } = pending.data;
      pendingAction.delete(userId);
      const d = loadData();
      d.staffCredentials.push({ login, passEnc: encryptPass(pass), label: text });
      saveData(d);

      return ctx.replyWithHTML(
        `✅ <b>Сотрудник добавлен!</b>\n\n` +
        `👤 Имя: <b>${esc(text)}</b>\n` +
        `🔑 Логин: <code>${login}</code>\n` +
        `🔐 Пароль: <code>${pass}</code>`,
        { ...staffManageKeyboard() }
      );
    }
    return;
  }

  // ── СОТРУДНИК: логин/пароль ──────────────────────────────────────
  if (isAuthorized(userId)) {
    return ctx.reply('✅ Вы на смене. Ожидайте заказы.', staffKeyboard);
  }

  const pending = pendingLogin.get(userId);

  // Шаг 1 — логин
  if (!pending || pending.step === 'login') {
    const d = loadData();
    const found = d.staffCredentials.find(s => s.login === text);
    if (found) {
      pendingLogin.set(userId, { step: 'pass', login: text });
      return ctx.replyWithHTML(`✅ Логин принят!\n\nВведите <b>пароль</b>:`);
    } else {
      pendingLogin.set(userId, { step: 'login' });
      return ctx.reply('❌ Логин не найден. Попробуйте ещё раз:');
    }
  }

  // Шаг 2 — пароль
  if (pending.step === 'pass') {
    const d    = loadData();
    const cred = d.staffCredentials.find(s => s.login === pending.login);
    pendingLogin.delete(userId);

    if (cred && checkPass(cred, text)) {
      authorizedStaff.set(userId, {
        expiresAt: Date.now() + SESSION_TTL,
        firstName: ctx.from.first_name || 'Сотрудник',
        username:  ctx.from.username || null,
        login:     pending.login,
      });
      try {
        await bot.telegram.sendMessage(SUPER_ADMIN,
          `🟢 <b>${esc(ctx.from.first_name || '?')}</b> (@${esc(ctx.from.username || '—')}) вышел на смену\nЛогин: <code>${pending.login}</code>`,
          { parse_mode: 'HTML' });
      } catch {}
      return ctx.replyWithHTML(
        `✅ <b>Смена открыта!</b>\n\nДобро пожаловать, ${esc(ctx.from.first_name || 'друг')}!\nВы будете получать все новые заказы.`,
        staffKeyboard
      );
    } else {
      return ctx.reply('❌ Неверный пароль. Введите логин заново:', Markup.removeKeyboard());
    }
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ API запущен на порту ${PORT}`));
bot.launch({ dropPendingUpdates: true }).then(() => console.log('✅ Бот запущен'));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
