const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');
require('dotenv').config();

const dbPath = process.env.DB_PATH || './reminders.db';

// Ensure the directory for the database exists
const dbDir = path.dirname(path.resolve(dbPath));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('Connected to the SQLite database at:', dbPath);
  }
});

// Wrap sqlite3 methods in Promises for async/await
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this); // 'this' contains lastID and changes
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Initialize the database tables
async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      timezone TEXT DEFAULT 'Asia/Tashkent',
      language TEXT DEFAULT 'uz'
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      title TEXT NOT NULL,
      event_type TEXT NOT NULL, -- 'exam', 'birthday', 'custom'
      event_date TEXT NOT NULL, -- 'YYYY-MM-DD HH:mm' or 'MM-DD'
      notify_offsets TEXT NOT NULL, -- comma-separated e.g. '7d,2d,0d'
      notify_time TEXT DEFAULT '09:00', -- for day-only events (birthdays)
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (chat_id) REFERENCES users(chat_id)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS notification_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER,
      chat_id INTEGER,
      send_at TEXT NOT NULL, -- UTC ISO String e.g. '2026-06-08T04:00:00.000Z'
      message TEXT NOT NULL,
      offset_label TEXT NOT NULL, -- e.g. '7 kun oldin', 'bugun'
      sent INTEGER DEFAULT 0,
      FOREIGN KEY (reminder_id) REFERENCES reminders(id) ON DELETE CASCADE
    )
  `);

  console.log('Database tables initialized.');
}

// User helper functions
async function saveUser(chatId, timezone = 'Asia/Tashkent', language = 'uz') {
  return await dbRun(
    `INSERT INTO users (chat_id, timezone, language) 
     VALUES (?, ?, ?) 
     ON CONFLICT(chat_id) DO UPDATE SET 
       timezone = COALESCE(timezone, excluded.timezone), 
       language = COALESCE(language, excluded.language)`,
    [chatId, timezone, language]
  );
}

async function getUser(chatId) {
  return await dbGet(`SELECT * FROM users WHERE chat_id = ?`, [chatId]);
}

async function updateUserTimezone(chatId, timezone) {
  await saveUser(chatId); // Ensure user exists
  return await dbRun(`UPDATE users SET timezone = ? WHERE chat_id = ?`, [timezone, chatId]);
}

async function updateUserLanguage(chatId, language) {
  await saveUser(chatId); // Ensure user exists
  return await dbRun(`UPDATE users SET language = ? WHERE chat_id = ?`, [language, chatId]);
}

// Helper: Calculate notification times for a reminder
function calculateNotificationTimes(reminder, timezone) {
  const localNow = DateTime.now().setZone(timezone);
  let eventDateTime;

  if (reminder.event_type === 'birthday') {
    // Event date is 'MM-DD'. Calculate next occurrence.
    const year = localNow.year;
    // Format: 'YYYY-MM-DD HH:mm'
    eventDateTime = DateTime.fromFormat(
      `${year}-${reminder.event_date} ${reminder.notify_time}`,
      'yyyy-MM-dd HH:mm',
      { zone: timezone }
    );

    // If the event (at notify_time) is in the past, schedule for next year
    if (eventDateTime < localNow) {
      eventDateTime = eventDateTime.plus({ years: 1 });
    }
  } else {
    // For 'exam' or 'custom', event_date is 'YYYY-MM-DD HH:mm'
    eventDateTime = DateTime.fromFormat(reminder.event_date, 'yyyy-MM-dd HH:mm', { zone: timezone });
  }

  if (!eventDateTime.isValid) {
    console.error('Invalid event date calculated:', reminder.event_date, eventDateTime.invalidReason);
    return [];
  }

  const offsets = reminder.notify_offsets.split(',').map(s => s.trim()).filter(Boolean);
  const queueItems = [];

  for (const offset of offsets) {
    let notifyDateTime = eventDateTime;
    let labelUz = '';

    if (offset.endsWith('d')) {
      const days = parseInt(offset.slice(0, -1), 10);
      notifyDateTime = eventDateTime.minus({ days });
      labelUz = days === 0 ? 'bugun' : `${days} kun oldin`;
    } else if (offset.endsWith('h')) {
      const hours = parseInt(offset.slice(0, -1), 10);
      notifyDateTime = eventDateTime.minus({ hours });
      labelUz = hours === 0 ? 'hozir' : `${hours} soat oldin`;
    } else if (offset.endsWith('m')) {
      const minutes = parseInt(offset.slice(0, -1), 10);
      notifyDateTime = eventDateTime.minus({ minutes });
      labelUz = minutes === 0 ? 'hozir' : `${minutes} daqiqa oldin`;
    } else if (offset === '1w') { // 1 week shortcut
      notifyDateTime = eventDateTime.minus({ weeks: 1 });
      labelUz = '1 hafta oldin';
    } else {
      continue;
    }

    // Only queue notifications that are in the future
    if (notifyDateTime > localNow) {
      let message = '';
      if (reminder.event_type === 'birthday') {
        message = `🎉 Eslatma: Bugun ${reminder.title}ning tug'ilgan kuni!`;
        if (offset !== '0d') {
          message = `🎉 Eslatma: ${labelUz} (${eventDateTime.toFormat('dd.MM')}) ${reminder.title}ning tug'ilgan kuni!`;
        }
      } else if (reminder.event_type === 'exam') {
        message = `📚 Eslatma: Bugun sizda imtihon bor: ${reminder.title} (${eventDateTime.toFormat('HH:mm')})`;
        if (offset !== '0d') {
          message = `📚 Eslatma: ${labelUz} (${eventDateTime.toFormat('dd.MM.yyyy HH:mm')}) sizda imtihon bor: ${reminder.title}`;
        }
      } else {
        message = `🔔 Eslatma: ${reminder.title}`;
        if (offset !== '0d') {
          message = `🔔 Eslatma: ${labelUz} (${eventDateTime.toFormat('dd.MM.yyyy HH:mm')}) rejangiz bor: ${reminder.title}`;
        }
      }

      queueItems.push({
        send_at: notifyDateTime.toUTC().toISO(),
        message,
        offset_label: labelUz
      });
    }
  }

  return queueItems;
}

// Queue all pending notifications for a reminder
async function queueNotifications(reminderId) {
  const reminder = await dbGet(`SELECT * FROM reminders WHERE id = ?`, [reminderId]);
  if (!reminder || !reminder.is_active) return;

  const user = await getUser(reminder.chat_id);
  const timezone = user ? user.timezone : 'Asia/Tashkent';

  // First, clear any unsent notifications in the queue for this reminder
  await dbRun(`DELETE FROM notification_queue WHERE reminder_id = ? AND sent = 0`, [reminderId]);

  const queueItems = calculateNotificationTimes(reminder, timezone);
  for (const item of queueItems) {
    await dbRun(
      `INSERT INTO notification_queue (reminder_id, chat_id, send_at, message, offset_label) 
       VALUES (?, ?, ?, ?, ?)`,
      [reminderId, reminder.chat_id, item.send_at, item.message, item.offset_label]
    );
  }
}

// CRUD operations for reminders
async function addReminder({ chatId, title, eventType, eventDate, notifyOffsets, notifyTime = '09:00' }) {
  await saveUser(chatId); // Ensure user exists
  const result = await dbRun(
    `INSERT INTO reminders (chat_id, title, event_type, event_date, notify_offsets, notify_time) 
     VALUES (?, ?, ?, ?, ?, ?)`,
    [chatId, title, eventType, eventDate, notifyOffsets, notifyTime]
  );
  
  const reminderId = result.lastID;
  await queueNotifications(reminderId);
  return reminderId;
}

async function getReminders(chatId) {
  return await dbAll(`SELECT * FROM reminders WHERE chat_id = ? AND is_active = 1`, [chatId]);
}

async function getReminder(id) {
  return await dbGet(`SELECT * FROM reminders WHERE id = ?`, [id]);
}

async function deleteReminder(id, chatId) {
  // Delete notifications first
  await dbRun(`DELETE FROM notification_queue WHERE reminder_id = ? AND chat_id = ?`, [id, chatId]);
  // Then delete the reminder
  return await dbRun(`DELETE FROM reminders WHERE id = ? AND chat_id = ?`, [id, chatId]);
}

module.exports = {
  initDb,
  saveUser,
  getUser,
  updateUserTimezone,
  updateUserLanguage,
  addReminder,
  getReminders,
  getReminder,
  deleteReminder,
  queueNotifications,
  dbRun,
  dbGet,
  dbAll
};
