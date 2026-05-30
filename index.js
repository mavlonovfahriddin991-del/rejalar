const { Telegraf, Markup } = require('telegraf');
const { DateTime } = require('luxon');
require('dotenv').config();

const db = require('./database');
const { startScheduler } = require('./scheduler');

// Verify token
if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
  console.error('\x1b[31m%s\x1b[0m', '==================================================');
  console.error('\x1b[31m%s\x1b[0m', 'XATOLIK: BOT_TOKEN o\'rnatilmagan!');
  console.error('\x1b[31m%s\x1b[0m', 'Iltimos, .env faylini ochib, BOT_TOKEN qismiga');
  console.error('\x1b[31m%s\x1b[0m', 'Telegram bot tokeningizni yozing.');
  console.error('\x1b[31m%s\x1b[0m', '==================================================');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Simple in-memory session store
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { state: 'NONE', data: {} });
  }
  return sessions.get(chatId);
}
function clearSession(chatId) {
  sessions.set(chatId, { state: 'NONE', data: {} });
}

// User Timezone Helper
async function getUserTimezone(chatId) {
  const user = await db.getUser(chatId);
  return user ? user.timezone : 'Asia/Tashkent';
}

// Main Menu Keyboard Generator
function getMainMenu() {
  return Markup.keyboard([
    ['➕ Yangi reja qo\'shish', '📅 Rejalar ro\'yxati'],
    ['🌐 Soat mintaqasi', 'ℹ️ Yordam']
  ]).resize();
}

// Predefined Offset Options
const BIRTHDAY_OFFSETS = [
  { key: '7d', label: '1 hafta oldin' },
  { key: '2d', label: '2 kun oldin' },
  { key: '1d', label: '1 kun oldin' },
  { key: '0d', label: 'Tug\'ilgan kun kuni' }
];

const EXAM_OFFSETS = [
  { key: '2d', label: '2 kun oldin' },
  { key: '1d', label: '1 kun oldin' },
  { key: '2h', label: '2 soat oldin' },
  { key: '0d', label: 'Imtihon vaqtida' }
];

const CUSTOM_OFFSETS = [
  { key: '1d', label: '1 kun oldin' },
  { key: '2h', label: '2 soat oldin' },
  { key: '30m', label: '30 daqiqa oldin' },
  { key: '0d', label: 'Rejalashtirilgan vaqtda' }
];

function getOffsetsForType(type) {
  if (type === 'birthday') return BIRTHDAY_OFFSETS;
  if (type === 'exam') return EXAM_OFFSETS;
  return CUSTOM_OFFSETS;
}

// Generate Offset Selection Keyboard
function getOffsetsKeyboard(type, selectedOffsets) {
  const options = getOffsetsForType(type);
  const buttons = options.map(opt => {
    const isSelected = selectedOffsets.includes(opt.key);
    const emoji = isSelected ? '✅' : '⬜';
    return [Markup.button.callback(`${emoji} ${opt.label}`, `toggle_offset:${opt.key}`)];
  });
  
  // Add action buttons
  buttons.push([
    Markup.button.callback('❌ Bekor qilish', 'cancel_reminder'),
    Markup.button.callback('💾 Tasdiqlash', 'confirm_offsets')
  ]);
  
  return Markup.inlineKeyboard(buttons);
}

// Initialize application
async function run() {
  await db.initDb();

  // Debugging middleware
  bot.use((ctx, next) => {
    console.log(`[DEBUG] Update: type=${ctx.updateType}, chat=${ctx.chat?.id || 'N/A'}, text="${ctx.message?.text || ''}"`);
    return next();
  });

  // Command handlers
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    await db.saveUser(chatId);
    clearSession(chatId);
    
    await ctx.reply(
      `👋 *Assalomu alaykum!*\n\nMen sizga rejalaringizni, imtihonlarni va tug'ilgan kunlarni o'z vaqtida eslatib turuvchi botman.\n\n` +
      `Sizga qulay bo'lishi uchun standart soat mintaqangiz *Asia/Tashkent (UTC+5)* qilib olingan. Uni istalgan vaqtda menu orqali o'zgartirishingiz mumkin.`,
      { parse_mode: 'Markdown', ...getMainMenu() }
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      `📖 *Botdan foydalanish bo'yicha yo'riqnoma:*\n\n` +
      `1. *➕ Yangi reja qo'shish* - tugmasini bosing yoki /yangi buyrug'ini yuboring. Reja turi, nomi, sanasi, vaqti va eslatish oralig'ini kiriting.\n` +
      `2. *📅 Rejalar ro'yxati* - faol rejalaringizni ko'rish, keraksizlarini o'chirish.\n` +
      `3. *🌐 Soat mintaqasi* - xabarlar o'z vaqtida kelishi uchun soat mintaqasini to'g'rilash (masalan, Toshkent, Seul, Moskva va b.).\n\n` +
      `Savollar yoki muammolar yuzaga kelsa, barcha rejalaringiz saqlanib qoladi.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle Main Menu buttons
  bot.hears('➕ Yangi reja qo\'shish', (ctx) => startAddReminder(ctx));
  bot.hears('📅 Rejalar ro\'yxati', (ctx) => listReminders(ctx));
  bot.hears('🌐 Soat mintaqasi', (ctx) => showTimezoneSettings(ctx));
  bot.hears('ℹ️ Yordam', (ctx) => ctx.reply(`Yo'riqnoma uchun /help buyrug'ini bosing.`));

  bot.command('yangi', (ctx) => startAddReminder(ctx));
  bot.command('list', (ctx) => listReminders(ctx));
  bot.command('timezone', (ctx) => showTimezoneSettings(ctx));

  // Timezone Settings
  async function showTimezoneSettings(ctx) {
    const chatId = ctx.chat.id;
    const tz = await getUserTimezone(chatId);
    
    const tzButtons = [
      [Markup.button.callback('🇺🇿 Toshkent (UTC+5)', 'set_tz:Asia/Tashkent')],
      [Markup.button.callback('🇰🇷 Seul (UTC+9)', 'set_tz:Asia/Seoul')],
      [Markup.button.callback('🇷🇺 Moskva (UTC+3)', 'set_tz:Europe/Moscow')],
      [Markup.button.callback('🇬🇧 London (UTC+1)', 'set_tz:Europe/London')],
      [Markup.button.callback('🇺🇸 Nyu-York (UTC-4)', 'set_tz:America/New_York')],
      [Markup.button.callback('🌐 Boshqa mintaqani yozish', 'custom_tz_input')]
    ];
    
    await ctx.reply(
      `🌐 Hozirgi soat mintaqangiz: *${tz}*\n\n` +
      `Rejalaringiz o'z vaqtida eslatilishi uchun mintaqangizni tanlang yoki yozing:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(tzButtons)
      }
    );
  }

  // Start adding a reminder
  async function startAddReminder(ctx) {
    const chatId = ctx.chat.id;
    clearSession(chatId);
    
    const session = getSession(chatId);
    session.state = 'WAITING_TYPE';

    const typeButtons = [
      [Markup.button.callback('🎂 Tug\'ilgan kun', 'select_type:birthday')],
      [Markup.button.callback('📚 Imtihon', 'select_type:exam')],
      [Markup.button.callback('🔔 Boshqa eslatma', 'select_type:custom')]
    ];

    await ctx.reply(
      `Qanday turdagi reja qo'shmoqchisiz? Quyidagilardan birini tanlang:`,
      Markup.inlineKeyboard(typeButtons)
    );
  }

  // List all reminders
  async function listReminders(ctx) {
    const chatId = ctx.chat.id;
    const reminders = await db.getReminders(chatId);
    
    if (reminders.length === 0) {
      return await ctx.reply(
        `Sizda hozircha faol rejalar yo'q. Yangi reja qo'shish uchun *➕ Yangi reja qo'shish* tugmasini bosing.`,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.reply(`📅 *Sizning faol rejalaringiz ro'yxati:*`, { parse_mode: 'Markdown' });

    for (const r of reminders) {
      let details = '';
      if (r.event_type === 'birthday') {
        details = `🎂 Tug'ilgan kun: *${r.event_date}* (har yili) | Eslatma vaqti: *${r.notify_time}*`;
      } else if (r.event_type === 'exam') {
        details = `📚 Imtihon vaqti: *${r.event_date}*`;
      } else {
        details = `🔔 Eslatma vaqti: *${r.event_date}*`;
      }

      const info = `📌 *${r.title}*\n${details}\nEslatmalar: \`${r.notify_offsets}\``;
      
      await ctx.reply(
        info,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('🗑 O\'chirish', `delete_reminder:${r.id}`)
          ])
        }
      );
    }
  }

  // Inline Queries & Callbacks
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat.id;
    const session = getSession(chatId);

    try {
      if (data.startsWith('select_type:')) {
        const type = data.split(':')[1];
        session.data.type = type;
        session.state = 'WAITING_TITLE';
        
        let promptText = '';
        if (type === 'birthday') {
          promptText = `🎉 *Ajoyib tanlov!* Keling, tug'ilgan kun egasini ro'yxatga olamiz.\n\n` +
                       `Tug'ilgan kun kimniki? Iltimos, uning ismini yoki sizga qulay nomni yozing.\n` +
                       `_(Masalan: Ukam Shaxzod, Onajonim, Do'stim Davron)_`;
        } else if (type === 'exam') {
          promptText = `📚 *Imtihonlarni rejalashtirish bo'limi!*\n\n` +
                       `Qaysi fan yoki qanday imtihoningiz borligini yozing.\n` +
                       `_(Masalan: Matematika imtihoni, IELTS Speaking, Dasturlashdan yakuniy nazorat)_`;
        } else {
          promptText = `🔔 *Yangi shaxsiy eslatma yaratish!*\n\n` +
                       `Sizga nimanidir eslatib turishimni xohlaysiz. Nima rejangiz bor? Qisqacha nomini yozing.\n` +
                       `_(Masalan: Shifokor ko'rigi, Mashinani yuvish, Muhim uchrashuv)_`;
        }

        await ctx.answerCbQuery();
        await ctx.reply(promptText, { parse_mode: 'Markdown', ...Markup.forceReply() });
      }
      
      else if (data === 'custom_tz_input') {
        session.state = 'WAITING_TZ';
        await ctx.answerCbQuery();
        await ctx.reply(
          `Mintaqani kiriting. Masalan: \`Asia/Tashkent\`, \`Asia/Seoul\`, \`Europe/Moscow\` yoki \`UTC\`.\n` +
          `Dunyo mintaqalari nomlarini kiritishingiz kerak.`,
          { parse_mode: 'Markdown', ...Markup.forceReply() }
        );
      }
      
      else if (data.startsWith('set_tz:')) {
        const tz = data.split(':')[1];
        await db.updateUserTimezone(chatId, tz);
        await ctx.answerCbQuery();
        await ctx.reply(`✅ Soat mintaqasi muvaffaqiyatli o'zgartirildi: *${tz}*`, { parse_mode: 'Markdown' });
      }

      else if (data.startsWith('set_date:')) {
        const when = data.split(':')[1];
        const tz = await getUserTimezone(chatId);
        let dateStr = '';
        const now = DateTime.now().setZone(tz);
        
        if (when === 'today') {
          dateStr = now.toFormat('dd.MM.yyyy');
        } else if (when === 'tomorrow') {
          dateStr = now.plus({ days: 1 }).toFormat('dd.MM.yyyy');
        }

        session.data.date = dateStr;
        session.state = 'WAITING_TIME';
        
        await ctx.answerCbQuery();
        let promptText = '';
        if (session.data.type === 'exam') {
          promptText = `⏰ *Sana qabul qilindi!* Endi imtihon boshlanish vaqtini kiriting.\n\n` +
                       `Imtihon soat nechada boshlanadi?\n` +
                       `Format: *SOAT:DAQIQA* (24 soatlik tizimda, masalan: \`09:00\` yoki \`15:30\`):`;
        } else {
          promptText = `⏰ *Yaxshi!* Ushbu rejangiz/eslatmangiz soat nechada bo'ladi?\n\n` +
                       `Format: *SOAT:DAQIQA* (24 soatlik tizimda, masalan: \`12:00\` yoki \`18:45\`):`;
        }

        await ctx.reply(
          `Tanlangan sana: *${dateStr}*\n\n${promptText}`,
          { parse_mode: 'Markdown', ...Markup.forceReply() }
        );
      }
      
      else if (data.startsWith('toggle_offset:')) {
        const offset = data.split(':')[1];
        if (!session.data.offsets) {
          session.data.offsets = [];
        }
        
        const idx = session.data.offsets.indexOf(offset);
        if (idx > -1) {
          session.data.offsets.splice(idx, 1);
        } else {
          session.data.offsets.push(offset);
        }
        
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(
          getOffsetsKeyboard(session.data.type, session.data.offsets).reply_markup
        );
      }
      
      else if (data === 'cancel_reminder') {
        clearSession(chatId);
        await ctx.answerCbQuery('Reja qo\'shish bekor qilindi.');
        await ctx.reply('❌ Reja qo\'shish bekor qilindi.', getMainMenu());
      }
      
      else if (data === 'confirm_offsets') {
        await ctx.answerCbQuery();
        const offsets = session.data.offsets || [];
        if (offsets.length === 0) {
          return await ctx.reply(
            `⚠️ Iltimos, kamida bitta eslatish vaqtini tanlang!`,
            getOffsetsKeyboard(session.data.type, [])
          );
        }

        // Save reminder to database
        const { type, title, date, time } = session.data;
        let eventDateFormatted = '';
        let notifyTime = '09:00';

        if (type === 'birthday') {
          // date is MM-DD
          eventDateFormatted = date; // Already converted to MM-DD in date input phase
          notifyTime = time; // Time to notify on birthday
        } else {
          // date is YYYY-MM-DD, time is HH:MM
          eventDateFormatted = `${date} ${time}`;
        }

        const reminderId = await db.addReminder({
          chatId,
          title,
          eventType: type,
          eventDate: eventDateFormatted,
          notifyOffsets: offsets.join(','),
          notifyTime
        });

        clearSession(chatId);

        // Show confirmation details
        let confirmMsg = `✅ *Reja muvaffaqiyatli saqlandi!*\n\n` +
          `📌 *Nomi:* ${title}\n` +
          `📅 *Sana:* ${type === 'birthday' ? date + ' (Har yili)' : date}\n` +
          `⏰ *Vaqt:* ${time}\n` +
          `🔔 *Eslatma vaqtlari:* ${offsets.map(o => {
            const list = getOffsetsForType(type);
            const found = list.find(l => l.key === o);
            return found ? found.label : o;
          }).join(', ')}`;

        await ctx.reply(confirmMsg, { parse_mode: 'Markdown', ...getMainMenu() });
      }
      
      else if (data.startsWith('delete_reminder:')) {
        const id = parseInt(data.split(':')[1], 10);
        await db.deleteReminder(id, chatId);
        await ctx.answerCbQuery('O\'chirildi!');
        await ctx.reply('🗑 Reja o\'chirib tashlandi.', getMainMenu());
      }

    } catch (err) {
      console.error('Error handling callback query:', err);
      await ctx.answerCbQuery('Xatolik yuz berdi.');
    }
  });

  // Handle incoming text messages for states
  bot.on('message', async (ctx) => {
    // If not text, ignore
    if (!ctx.message || !ctx.message.text) return;

    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    const session = getSession(chatId);
    const tz = await getUserTimezone(chatId);

    // If text matches main menu command, ignore state processing and let button commands handle it
    if (['➕ Yangi reja qo\'shish', '📅 Rejalar ro\'yxati', '🌐 Soat mintaqasi', 'ℹ️ Yordam'].includes(text)) {
      clearSession(chatId);
      return;
    }

    try {
      if (session.state === 'WAITING_TZ') {
        const validTz = DateTime.now().setZone(text).isValid;
        if (!validTz) {
          return await ctx.reply(
            `❌ Kiritilgan soat mintaqasi noto'g'ri. Iltimos, ma'lumotlar omboridagi to'g'ri mintaqani kiriting (masalan, \`Asia/Tashkent\` yoki \`UTC\`):`,
            { parse_mode: 'Markdown', ...Markup.forceReply() }
          );
        }
        await db.updateUserTimezone(chatId, text);
        clearSession(chatId);
        await ctx.reply(`✅ Soat mintaqasi muvaffaqiyatli o'zgartirildi: *${text}*`, { parse_mode: 'Markdown', ...getMainMenu() });
      }
      
      else if (session.state === 'WAITING_TITLE') {
        if (text.length < 2) {
          return await ctx.reply(
            `❌ Nomi juda qisqa. Kamida 2 ta harfdan iborat nom kiriting:`,
            Markup.forceReply()
          );
        }
        session.data.title = text;
        session.state = 'WAITING_DATE';

        if (session.data.type === 'birthday') {
          await ctx.reply(
            `🎂 *Tashakkur!* Endi *${session.data.title}* uchun tug'ilgan kun sanasini kiriting.\n\n` +
            `Sana formatini *KUN.OY* ko'rinishida yozing (yilni kiritish shart emas, chunki bot har yili eslatadi).\n` +
            `_(Masalan: Agar 15-iyun bo'lsa \`15.06\` deb, agar 5-dekabr bo'lsa \`05.12\` deb yozing):_`,
            { parse_mode: 'Markdown', ...Markup.forceReply() }
          );
        } else {
          // For exams and custom events, suggest today and tomorrow
          let datePrompt = '';
          if (session.data.type === 'exam') {
            datePrompt = `📅 *Tushunarli!* Demak, imtihoningiz nomi: *${session.data.title}*.\n\n` +
                         `Endi imtihon qaysi kuni bo'lishini kiriting.\n` +
                         `Format: *KUN.OY.YIL* (masalan: \`31.05.2026\`).\n\n` +
                         `_Yoki pastdagi tugmalardan birini tezkor tanlashingiz mumkin:_`;
          } else {
            datePrompt = `📅 *Qabul qilindi!* Reja nomi: *${session.data.title}*.\n\n` +
                         `Ushbu rejangiz qaysi kuni bo'ladi?\n` +
                         `Format: *KUN.OY.YIL* (masalan: \`31.05.2026\`).\n\n` +
                         `_Yoki pastdagi tugmalardan foydalaning:_`;
          }
          
          await ctx.reply(
            datePrompt,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('📅 Bugun', 'set_date:today'), Markup.button.callback('📅 Ertaga', 'set_date:tomorrow')]
              ]),
              ...Markup.forceReply()
            }
          );
        }
      }
      
      else if (session.state === 'WAITING_DATE') {
        if (session.data.type === 'birthday') {
          // Birthday date format: DD.MM or DD-MM
          const regex = /^\s*(0?[1-9]|[12][0-9]|3[01])[\.\-/](0?[1-9]|1[0-2])\s*$/;
          const match = text.match(regex);
          if (!match) {
            return await ctx.reply(
              `❌ Tug'ilgan kun formati noto'g'ri. Iltimos, formatga amal qiling: *KUN.OY* (masalan: \`15.06\`):`,
              { parse_mode: 'Markdown', ...Markup.forceReply() }
            );
          }
          const day = match[1].padStart(2, '0');
          const month = match[2].padStart(2, '0');
          
          session.data.date = `${month}-${day}`; // Save as MM-DD for birthday DB
          session.state = 'WAITING_TIME';
          await ctx.reply(
            `⏰ *Ajoyib!* Tug'ilgan kunni eslatish vaqtini belgilang.\n\n` +
            `Shu kuni soat nechada sizga xabar yuboraylik? (Mahalliy vaqtingiz bo'yicha).\n` +
            `Format: *SOAT:DAQIQA* (24 soatlik tizimda, masalan: \`09:00\` yoki \`20:00\`):`,
            { parse_mode: 'Markdown', ...Markup.forceReply() }
          );
        } else {
          // Exam/Custom date format: DD.MM.YYYY
          const regex = /^\s*(0?[1-9]|[12][0-9]|3[01])[\.\-/](0?[1-9]|1[0-2])[\.\-/](\d{4})\s*$/;
          const match = text.match(regex);
          if (!match) {
            return await ctx.reply(
              `❌ Sana formati noto'g'ri. Iltimos, formatga amal qiling: *KUN.OY.YIL* (masalan: \`31.05.2026\`):`,
              { parse_mode: 'Markdown', ...Markup.forceReply() }
            );
          }
          const day = match[1].padStart(2, '0');
          const month = match[2].padStart(2, '0');
          const year = match[3];

          const inputDate = DateTime.fromFormat(`${year}-${month}-${day}`, 'yyyy-MM-dd', { zone: tz });
          if (!inputDate.isValid) {
            return await ctx.reply(
              `❌ Sana noto'g'ri kiritildi. Kalendarda mavjud bo'lgan sanani kiriting:`,
              Markup.forceReply()
            );
          }
          
          session.data.date = `${year}-${month}-${day}`; // Save as YYYY-MM-DD
          session.state = 'WAITING_TIME';
          
          const timePrompt = session.data.type === 'exam'
            ? `⏰ *Sana qabul qilindi!* Endi imtihon boshlanish vaqtini kiriting.\n\n` +
              `Imtihon soat nechada boshlanadi?\n` +
              `Format: *SOAT:DAQIQA* (24 soatlik tizimda, masalan: \`09:00\` yoki \`15:30\`):`
            : `⏰ *Yaxshi!* Ushbu rejangiz/eslatmangiz soat nechada bo'ladi?\n\n` +
              `Format: *SOAT:DAQIQA* (24 soatlik tizimda, masalan: \`12:00\` yoki \`18:45\`):`;

          await ctx.reply(timePrompt, { parse_mode: 'Markdown', ...Markup.forceReply() });
        }
      }
      
      else if (session.state === 'WAITING_TIME') {
        const regex = /^\s*(0?[0-9]|1[0-9]|2[0-3])[\.:]([0-5][0-9])\s*$/;
        const match = text.match(regex);
        if (!match) {
          return await ctx.reply(
            `❌ Vaqt formati noto'g'ri. Iltimos, formatga amal qiling: *SOAT:DAQIQA* (masalan: \`09:00\`):`,
            { parse_mode: 'Markdown', ...Markup.forceReply() }
          );
        }
        const hour = match[1].padStart(2, '0');
        const minute = match[2].padStart(2, '0');
        const timeStr = `${hour}:${minute}`;

        // Validate that full date-time is in the future for one-off events
        if (session.data.type !== 'birthday') {
          const eventDateTime = DateTime.fromFormat(`${session.data.date} ${timeStr}`, 'yyyy-MM-dd HH:mm', { zone: tz });
          const localNow = DateTime.now().setZone(tz);
          if (eventDateTime <= localNow) {
            return await ctx.reply(
              `❌ Kiritilgan vaqt o'tib ketgan! Kelajakdagi vaqtni kiriting (hozirgi vaqtingiz: ${localNow.toFormat('HH:mm')}):`,
              Markup.forceReply()
            );
          }
        }

        session.data.time = timeStr;
        session.state = 'WAITING_OFFSETS';
        
        // Pre-select defaults
        if (session.data.type === 'birthday') {
          session.data.offsets = ['7d', '2d', '0d'];
        } else if (session.data.type === 'exam') {
          session.data.offsets = ['1d', '0d'];
        } else {
          session.data.offsets = ['1d', '2h', '0d'];
        }

        let typeWord = session.data.type === 'birthday' ? 'tug\'ilgan kun' : (session.data.type === 'exam' ? 'imtihon' : 'reja');
        await ctx.reply(
          `🔔 *So'nggi qadam!* Eslatma qachon yuborilishi kerak?\n\n` +
          `Sizga ushbu ${typeWord}dan qancha vaqt oldin xabar yuborishimiz kerakligini tanlang.\n` +
          `Bir nechta variantni belgilashingiz mumkin. Tanlab bo'lgach, pastdagi *💾 Tasdiqlash* tugmasini bosing:`,
          {
            parse_mode: 'Markdown',
            ...getOffsetsKeyboard(session.data.type, session.data.offsets)
          }
        );
      } else {
        // State is NONE. Parse natural text!
        const lowerText = text.toLowerCase();
        
        if (lowerText.includes('salom') || lowerText.includes('hello') || lowerText === '/start') {
          return await ctx.reply(
            `👋 *Assalomu alaykum!*\n\nYangi reja qo'shish uchun shunchaki rejangiz nomini yozib yuboring (masalan: *Ukamning tug'ilgan kuni* yoki *Matematika imtihoni*).`,
            { parse_mode: 'Markdown', ...getMainMenu() }
          );
        }

        // Keywords detection
        if (lowerText.includes('tug\'ilgan kun') || lowerText.includes('tugilgan kun') || lowerText.includes('tavallud')) {
          session.data.type = 'birthday';
          session.data.title = text;
          session.state = 'WAITING_DATE';
          return await ctx.reply(
            `🎂 *Tug'ilgan kun eslatmasini yaratishni boshladik!*\n\n` +
            `Nomini mana bunday belgiladim: *${text}*.\n\n` +
            `Endi tug'ilgan kun sanasini kiriting (format: *KUN.OY*, masalan: \`15.06\`):`,
            { parse_mode: 'Markdown', ...Markup.forceReply() }
          );
        } 
        
        if (lowerText.includes('imtihon') || lowerText.includes('exam') || lowerText.includes('nazorat')) {
          session.data.type = 'exam';
          session.data.title = text;
          session.state = 'WAITING_DATE';
          return await ctx.reply(
            `📚 *Imtihon eslatmasini yaratishni boshladik!*\n\n` +
            `Nomini mana bunday belgiladim: *${text}*.\n\n` +
            `Endi imtihon qaysi kuni bo'lishini kiriting (format: *KUN.OY.YIL*, masalan: \`31.05.2026\`):\n\n` +
            `_Yoki pastdagi tugmalardan foydalaning:_`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [Markup.button.callback('📅 Bugun', 'set_date:today'), Markup.button.callback('📅 Ertaga', 'set_date:tomorrow')]
              ]),
              ...Markup.forceReply()
            }
          );
        }

        // Default: treat as custom reminder
        session.data.type = 'custom';
        session.data.title = text;
        session.state = 'WAITING_DATE';
        return await ctx.reply(
          `🔔 *Yangi shaxsiy eslatma yaratishni boshladik!*\n\n` +
          `Rejangiz nomi: *${text}*.\n\n` +
          `Ushbu rejangiz qaysi kuni bo'ladi?\n` +
          `Format: *KUN.OY.YIL* (masalan: \`31.05.2026\`):\n\n` +
          `_Yoki pastdagi tugmalardan foydalaning:_`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📅 Bugun', 'set_date:today'), Markup.button.callback('📅 Ertaga', 'set_date:tomorrow')]
            ]),
            ...Markup.forceReply()
          }
        );
      }
    } catch (err) {
      console.error('Error in text message handler:', err);
      clearSession(chatId);
      await ctx.reply('⚠️ Xatolik yuz berdi. Reja yaratish bekor qilindi. Boshidan urinib ko\'ring.', getMainMenu());
    }
  });

  // Start the scheduler and Telegram polling
  startScheduler(bot);
  bot.launch();
  console.log('Telegram Bot successfully launched.');

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

run().catch(err => {
  console.error('Failed to start application:', err.message);
});
