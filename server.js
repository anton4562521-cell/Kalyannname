'use strict';

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const { Telegraf, Markup } = require('telegraf');
const fs         = require('fs');
const path       = require('path');

// =====================================================================
// CONFIG
// =====================================================================
const BOT_TOKEN   = '8741536202:AAEtCUR6sgFcnFucx9pCDc4dDycdeUjR4ZA';
const SUPER_ADMIN = 7108575486;        // Твой Telegram ID
const PORT        = process.env.PORT || 3000;
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 часа

// Путь для хранения данных (работает на Render/Railway/Fly — но данные
// сбрасываются при рестарте. Для persistence нужна база данных.)
const DATA_FILE = path.join(__dirname, 'data.json');

// =====================================================================
// ШИФРОВАНИЕ ПАРОЛЕЙ (XOR + ключ "Апликатор")
// =====================================================================
const CIPHER_KEY = 'Апликатор';

// Шифрует / дешифрует строку XOR-ом по ключу → возвращает hex-строку
function xorCipher(text) {
  const keyBuf  = Buffer.from(CIPHER_KEY, 'utf8');
  const textBuf = Buffer.from(text, 'utf8');
  const out     = Buffer.alloc(textBuf.length);
  for (let i = 0; i < textBuf.length; i++) {
    out[i] = textBuf[i] ^ keyBuf[i % keyBuf.length];
  }
  return out.toString('hex');
}

// XOR симметричен: encrypt === decrypt
const encryptPass = xorCipher;
const decryptPass = xorCipher;

// =====================================================================
// PERSISTENT DATA HELPERS
// =====================================================================
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return { staffCredentials: [], orderCounter: 1 };
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// Загружаем учётки сотрудников из файла при старте
let { staffCredentials: _rawCreds, orderCounter: savedCounter } = loadData();

// Дефолтный сотрудник если файл пустой — пароль сразу шифруется
if (!_rawCreds || !_rawCreds.length) {
  _rawCreds = [{ login: 'Fortoona', passEnc: encryptPass('Logistik'), label: 'Курьер 1' }];
  saveData({ staffCredentials: _rawCreds, orderCounter: 1 });
}

// staffCredentials в памяти: { login, passEnc (hex), label }
let staffCredentials = _rawCreds;

// Утилиты для работы с учётками
function findCred(login) {
  return staffCredentials.find(s => s.login === login) || null;
}
function checkPass(cred, inputPass) {
  // Поддержка старых записей без шифрования (pass вместо passEnc)
  if (cred.pass !== undefined) return cred.pass === inputPass;
  return decryptPass(cred.passEnc) === inputPass;
}

// Runtime state (сессии, заказы — в памяти)
const authorizedStaff = new Map();   // telegramId → { expiresAt, firstName, username, login }
const pendingLogin    = new Map();   // telegramId → { step: 'login'|'pass', login? }
let   orderCounter    = savedCounter || 1;
const activeOrders    = new Map();   // orderId → { order, orderNum, status, acceptedBy, messageIds, createdAt }

// Статистика (в памяти, сбрасывается при рестарте)
const cashRegister = { total: 0, count: 0 };

// =====================================================================
// HELPERS
// =====================================================================
function isAuthorized(telegramId) {
  if (telegramId === SUPER_ADMIN) return true;
  const s = authorizedStaff.get(telegramId);
  if (!s) return false;
  if (Date.now() > s.expiresAt) { authorizedStaff.delete(telegramId); return false; }
  return true;
}

function getStaffName(telegramId) {
  if (telegramId === SUPER_ADMIN) return '👑 Супер-Админ';
  const s = authorizedStaff.get(telegramId);
  if (!s) return `Сотрудник (${telegramId})`;
  return s.username ? `@${s.username}` : s.firstName || `Сотрудник (${telegramId})`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n) { return Number(n).toLocaleString('uk-UA') + ' грн'; }

function formatOrder(order, orderNum, acceptedBy, status) {
  const { client, items, total } = order;
  const dateStr = new Date(order.createdAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const statusMap = { new:'🆕 Новый', accepted:'✅ Принят', transit:'🚚 В пути', done:'🏁 Выполнен', cancelled:'❌ Отменён' };
  const statusLabel = statusMap[status] || status;

  const itemLines = items.map(it =>
    `  • ${esc(it.name)}${it.extra ? ` <i>(${esc(it.extra)})</i>` : ''} × ${it.qty} — <b>${fmt(it.total)}</b>`
  ).join('\n');

  return [
    `🌿 <b>FORTOONA — Заказ #${orderNum}</b>`,
    `🕐 ${dateStr} | Статус: <b>${statusLabel}</b>\n`,
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

function orderKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('✅ Принять', `accept:${orderId}`), Markup.button.callback('🚚 В пути', `transit:${orderId}`) ],
    [ Markup.button.callback('🏁 Выполнен', `done:${orderId}`),  Markup.button.callback('❌ Отмена', `cancel:${orderId}`) ],
  ]);
}

async function broadcastOrderUpdate(orderId) {
  const entry = activeOrders.get(orderId);
  if (!entry) return;
  const newText = formatOrder(entry.order, entry.orderNum, entry.acceptedBy, entry.status);
  const isClosed = entry.status === 'done' || entry.status === 'cancelled';
  const markup = isClosed ? { inline_keyboard: [] } : orderKeyboard(orderId).reply_markup;

  if (isClosed && entry.status === 'done') {
    cashRegister.total += entry.order.total;
    cashRegister.count++;
  }

  const edits = [...entry.messageIds.entries()].map(([chatId, msgId]) =>
    bot.telegram.editMessageText(chatId, msgId, undefined, newText, { parse_mode: 'HTML', reply_markup: markup })
      .catch(() => {})
  );
  await Promise.allSettled(edits);
}

// =====================================================================
// EXPRESS (API для фронтенда, если есть бэкенд-деплой)
// =====================================================================
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

// Статика — если index.html лежит рядом
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/order', async (req, res) => {
  try {
    const order = req.body;
    const orderId   = `ORD-${Date.now()}`;
    const orderNum  = orderCounter++;
    order.createdAt = order.createdAt || new Date().toISOString();

    // Сохраняем счётчик
    const d = loadData(); d.orderCounter = orderCounter; saveData(d);

    const text = formatOrder(order, orderNum, null, 'new');
    activeOrders.set(orderId, { order, orderNum, status: 'new', acceptedBy: null, messageIds: new Map(), createdAt: Date.now() });

    const recipients = new Set([SUPER_ADMIN]);
    for (const [id, s] of authorizedStaff) {
      if (Date.now() < s.expiresAt) recipients.add(id);
    }

    await Promise.allSettled([...recipients].map(async chatId => {
      try {
        const msg = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...orderKeyboard(orderId) });
        activeOrders.get(orderId).messageIds.set(chatId, msg.message_id);
      } catch (e) { console.error(`Send failed to ${chatId}:`, e.message); }
    }));

    return res.json({ ok: true, orderId, orderNum });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
});

// =====================================================================
// BOT
// =====================================================================
const bot = new Telegraf(BOT_TOKEN);

// ── Логирование ──────────────────────────────────────────────────────
bot.use((ctx, next) => {
  if (ctx.message?.text) {
    console.log(`[TG] ${ctx.from.id} (@${ctx.from.username || '?'}): ${ctx.message.text}`);
  }
  return next();
});

// ── /start ───────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  if (ctx.from.id === SUPER_ADMIN) {
    return ctx.replyWithHTML(
      `👑 <b>Добро пожаловать, Супер-Админ!</b>\n\n` +
      `<b>Команды:</b>\n` +
      `/staff — сотрудники на смене\n` +
      `/addstaff — добавить сотрудника\n` +
      `/delstaff — удалить сотрудника\n` +
      `/liststaff — все учётки\n` +
      `/stats — статистика кассы\n` +
      `/orders — активные заказы\n` +
      `/broadcast — рассылка сотрудникам`
    );
  }
  pendingLogin.delete(ctx.from.id);
  return ctx.replyWithHTML(`🌿 <b>FORTOONA</b>\nВведите ваш <b>логин</b>:`);
});

// ── /staff — кто сейчас на смене ─────────────────────────────────────
bot.command('staff', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');
  if (authorizedStaff.size === 0) return ctx.reply('👥 Сотрудников на смене нет.');
  const lines = ['👥 <b>Сотрудники на смене:</b>\n'];
  for (const [id, s] of authorizedStaff) {
    const exp = new Date(s.expiresAt).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv' });
    lines.push(`• ${s.firstName || 'N/A'} (${s.login || id}) — до ${exp}`);
  }
  return ctx.replyWithHTML(lines.join('\n'));
});

// ── /liststaff — все зарегистрированные учётки ───────────────────────
bot.command('liststaff', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');
  const d = loadData();
  if (!d.staffCredentials || !d.staffCredentials.length) return ctx.reply('Учёток нет.');
  const lines = ['📋 <b>Все учётки сотрудников:</b>\n'];
  d.staffCredentials.forEach((s, i) => {
    // Поддержка старых незашифрованных записей
    const plainPass = s.passEnc !== undefined ? decryptPass(s.passEnc) : (s.pass || '???');
    lines.push(`${i+1}. <b>${s.label || s.login}</b>\n   Логин: <code>${s.login}</code>\n   Пароль: <code>${plainPass}</code>`);
  });
  return ctx.replyWithHTML(lines.join('\n\n'));
});

// ── /addstaff ─────────────────────────────────────────────────────────
// Использование: /addstaff Логин Пароль Метка
bot.command('addstaff', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');
  const parts = ctx.message.text.split(' ').slice(1);
  if (parts.length < 2) {
    return ctx.replyWithHTML(
      '📝 <b>Формат:</b>\n' +
      '<code>/addstaff Логин Пароль Метка</code>\n\n' +
      'Пример:\n<code>/addstaff Kuryer1 pass123 Курьер Андрей</code>'
    );
  }
  const login = parts[0];
  const pass  = parts[1];
  const label = parts.slice(2).join(' ') || login;

  const d = loadData();
  if (d.staffCredentials.find(s => s.login === login)) {
    return ctx.reply(`⚠️ Сотрудник с логином <b>${login}</b> уже существует.`, { parse_mode:'HTML' });
  }
  d.staffCredentials.push({ login, passEnc: encryptPass(pass), label });
  saveData(d);
  staffCredentials = d.staffCredentials;

  return ctx.replyWithHTML(
    `✅ <b>Сотрудник добавлен!</b>\n\n` +
    `👤 Метка: <b>${label}</b>\n` +
    `🔑 Логин: <code>${login}</code>\n` +
    `🔐 Пароль: <code>${pass}</code>`
  );
});

// ── /delstaff ─────────────────────────────────────────────────────────
// Использование: /delstaff Логин
bot.command('delstaff', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');
  const login = ctx.message.text.split(' ')[1];
  if (!login) {
    return ctx.replyWithHTML(
      '📝 <b>Формат:</b> <code>/delstaff Логин</code>\n\n' +
      'Узнать все логины: /liststaff'
    );
  }
  const d = loadData();
  const before = d.staffCredentials.length;
  d.staffCredentials = d.staffCredentials.filter(s => s.login !== login);
  if (d.staffCredentials.length === before) return ctx.reply(`❓ Логин ${login} не найден.`);
  saveData(d);
  staffCredentials = d.staffCredentials;

  // Разлогиниваем если на смене
  for (const [id, s] of authorizedStaff) {
    if (s.login === login) authorizedStaff.delete(id);
  }

  return ctx.reply(`✅ Сотрудник <b>${login}</b> удалён и разлогинен.`, { parse_mode:'HTML' });
});

// ── /stats ────────────────────────────────────────────────────────────
bot.command('stats', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');

  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  let todayDone = 0, todayRevenue = 0;
  let activeCnt = 0;

  for (const [, entry] of activeOrders) {
    if (entry.status === 'done' && entry.createdAt >= todayStart.getTime()) {
      todayDone++;
      todayRevenue += entry.order.total;
    }
    if (entry.status !== 'done' && entry.status !== 'cancelled') activeCnt++;
  }

  return ctx.replyWithHTML(
    `📊 <b>Статистика за сегодня</b>\n\n` +
    `✅ Выполнено заказов: <b>${todayDone}</b>\n` +
    `💰 Выручка: <b>${todayRevenue.toLocaleString('uk-UA')} грн</b>\n` +
    `🔄 В работе сейчас: <b>${activeCnt}</b>\n` +
    `👥 На смене: <b>${authorizedStaff.size}</b>`
  );
});

// ── /orders — список активных заказов ────────────────────────────────
bot.command('orders', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');
  const active = [...activeOrders.values()].filter(e => e.status !== 'done' && e.status !== 'cancelled');
  if (!active.length) return ctx.reply('🟢 Активных заказов нет.');
  const lines = active.map(e =>
    `#${e.orderNum} — ${e.order.client.name} — <b>${e.status}</b> — ${e.order.total.toLocaleString('uk-UA')} грн`
  );
  return ctx.replyWithHTML('📋 <b>Активные заказы:</b>\n\n' + lines.join('\n'));
});

// ── /broadcast — рассылка всем сотрудникам ───────────────────────────
bot.command('broadcast', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('📢 Использование: /broadcast Ваше сообщение');
  if (authorizedStaff.size === 0) return ctx.reply('👥 Нет активных сотрудников.');
  let sent = 0;
  for (const [id] of authorizedStaff) {
    try { await bot.telegram.sendMessage(id, `📢 <b>Сообщение от администратора:</b>\n\n${text}`, { parse_mode:'HTML' }); sent++; }
    catch {}
  }
  return ctx.reply(`✅ Отправлено ${sent} сотрудникам.`);
});

// ── /kick — выгнать сотрудника по Telegram ID ────────────────────────
bot.command('kick', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('Использование: /kick <telegramId>');
  if (authorizedStaff.has(id)) {
    authorizedStaff.delete(id);
    try { await bot.telegram.sendMessage(id, '⛔ Вы были отключены от смены администратором.'); } catch {}
    return ctx.reply(`✅ Сотрудник ${id} выгнан со смены.`);
  }
  return ctx.reply(`❓ ID ${id} не найден на смене.`);
});

// ── /decrypt — расшифровать любую hex-строку вручную ─────────────────
bot.command('decrypt', async (ctx) => {
  if (ctx.from.id !== SUPER_ADMIN) return ctx.reply('⛔ Нет доступа.');
  const hex = ctx.message.text.split(' ')[1];
  if (!hex) {
    return ctx.replyWithHTML(
      '🔓 <b>Расшифровать пароль:</b>\n' +
      '<code>/decrypt hex-строка</code>\n\n' +
      'hex-строку можно взять из <code>data.json</code>, поле <code>passEnc</code>'
    );
  }
  try {
    const plain = decryptPass(hex);
    return ctx.replyWithHTML(`🔓 Расшифровано: <code>${plain}</code>`);
  } catch {
    return ctx.reply('❌ Неверная hex-строка.');
  }
});


bot.command('help', async (ctx) => {
  if (ctx.from.id === SUPER_ADMIN) {
    return ctx.replyWithHTML(
      `👑 <b>Команды Супер-Админа:</b>\n\n` +
      `/staff — кто на смене\n` +
      `/liststaff — все учётки (пароли расшифрованы)\n` +
      `/addstaff Логин Пароль Метка — добавить\n` +
      `/delstaff Логин — удалить\n` +
      `/kick ID — выгнать со смены\n` +
      `/broadcast Текст — рассылка\n` +
      `/orders — активные заказы\n` +
      `/stats — статистика\n` +
      `/decrypt hex — расшифровать пароль из data.json`
    );
  }
  return ctx.reply('Доступные команды:\n/start — авторизация');
});

// ── Текстовые сообщения (логин/пароль) ───────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text   = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  if (userId === SUPER_ADMIN) return; // Супер-админ — только команды

  if (isAuthorized(userId)) {
    return ctx.reply('✅ Вы уже авторизованы. Ожидайте заказы.\n\nДля выхода нажмите /start');
  }

  const pending = pendingLogin.get(userId);

  if (!pending) {
    // Ожидаем логин
    const d = loadData();
    const found = d.staffCredentials.find(s => s.login === text);
    if (found) {
      pendingLogin.set(userId, { step: 'pass', login: text });
      return ctx.replyWithHTML(`✅ Логин принят. Введите <b>пароль</b>:`);
    } else {
      return ctx.reply('❌ Неверный логин. Попробуйте ещё раз:');
    }
  }

  if (pending.step === 'pass') {
    const d = loadData();
    const cred = d.staffCredentials.find(s => s.login === pending.login);
    pendingLogin.delete(userId);
    if (cred && checkPass(cred, text)) {
      authorizedStaff.set(userId, {
        expiresAt: Date.now() + SESSION_TTL,
        firstName: ctx.from.first_name || 'Сотрудник',
        username: ctx.from.username || null,
        login: pending.login,
      });

      // Уведомляем супер-админа
      try {
        await bot.telegram.sendMessage(SUPER_ADMIN,
          `🟢 Сотрудник <b>${ctx.from.first_name || '?'}</b> (@${ctx.from.username || 'без username'}) вошёл на смену.\nЛогин: <code>${pending.login}</code>`,
          { parse_mode:'HTML' }
        );
      } catch {}

      return ctx.replyWithHTML(`✅ <b>Смена открыта!</b>\nДобро пожаловать, ${ctx.from.first_name || 'друг'}!\n\nВы будете получать все новые заказы.`);
    } else {
      return ctx.reply('❌ Неверный пароль. Начните заново — введите логин:');
    }
  }
});

// ── Callback query (кнопки у заказа) ─────────────────────────────────
bot.on('callback_query', async (ctx) => {
  const data   = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return ctx.answerCbQuery('⛔ Авторизуйтесь сначала.', { show_alert: true });

  const [action, orderId] = data.split(':');
  const entry = activeOrders.get(orderId);
  if (!entry) return ctx.answerCbQuery('❓ Заказ не найден или уже закрыт.');

  const staffName = getStaffName(userId);

  if (action === 'accept') {
    entry.status = 'accepted';
    entry.acceptedBy = staffName;
  } else if (action === 'transit') {
    entry.status = 'transit';
    if (!entry.acceptedBy) entry.acceptedBy = staffName;
  } else if (action === 'done') {
    entry.status = 'done';
    if (!entry.acceptedBy) entry.acceptedBy = staffName;
  } else if (action === 'cancel') {
    entry.status = 'cancelled';
  }

  await broadcastOrderUpdate(orderId);
  return ctx.answerCbQuery('✅ Обновлено!');
});

// =====================================================================
// START
// =====================================================================
app.listen(PORT, () => console.log(`✅ API-сервер запущен на порту ${PORT}`));

bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('✅ Telegram бот запущен'));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
