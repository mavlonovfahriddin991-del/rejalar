const cron = require('node-cron');
const { DateTime } = require('luxon');
const db = require('./database');

function startScheduler(bot) {
  console.log('Scheduler started...');

  // 1. Every minute: check and send pending notifications
  cron.schedule('* * * * *', async () => {
    try {
      const nowUtc = DateTime.utc().toISO();
      
      // Get all unsent notifications that are due
      const pendingNotifications = await db.dbAll(
        `SELECT nq.*, r.title, r.event_type 
         FROM notification_queue nq
         JOIN reminders r ON nq.reminder_id = r.id
         WHERE nq.sent = 0 AND nq.send_at <= ? AND r.is_active = 1`,
        [nowUtc]
      );

      for (const notification of pendingNotifications) {
        try {
          // Send message to user
          await bot.telegram.sendMessage(notification.chat_id, notification.message);
          
          // Mark as sent
          await db.dbRun(
            `UPDATE notification_queue SET sent = 1 WHERE id = ?`,
            [notification.id]
          );
          
          console.log(`Notification sent to ${notification.chat_id}: ${notification.message}`);
        } catch (err) {
          console.error(`Failed to send notification ${notification.id} to ${notification.chat_id}:`, err.message);
          // If the bot was blocked by the user or chat not found, we can deactivate the reminder or just log it
          if (err.code === 403 || err.code === 400) {
            console.log(`Deactivating reminders for blocked user: ${notification.chat_id}`);
            await db.dbRun(`UPDATE reminders SET is_active = 0 WHERE chat_id = ?`, [notification.chat_id]);
          }
        }
      }
    } catch (err) {
      console.error('Error in minute scheduler:', err.message);
    }
  });

  // 2. Every hour: Rollover birthday reminders for the next year if they have passed and have no unsent notifications
  cron.schedule('0 * * * *', async () => {
    await rolloverBirthdays();
  });

  // Also run rollover once on startup
  rolloverBirthdays();
}

async function rolloverBirthdays() {
  try {
    // Get all active birthday reminders
    const birthdayReminders = await db.dbAll(
      `SELECT r.*, u.timezone 
       FROM reminders r
       JOIN users u ON r.chat_id = u.chat_id
       WHERE r.event_type = 'birthday' AND r.is_active = 1`
    );

    for (const reminder of birthdayReminders) {
      const timezone = reminder.timezone || 'Asia/Tashkent';
      const localNow = DateTime.now().setZone(timezone);
      
      // Calculate this year's event date/time
      const currentYear = localNow.year;
      const eventDateTimeThisYear = DateTime.fromFormat(
        `${currentYear}-${reminder.event_date} ${reminder.notify_time}`,
        'yyyy-MM-dd HH:mm',
        { zone: timezone }
      );

      // If the birthday for the current year is in the past
      if (eventDateTimeThisYear.isValid && eventDateTimeThisYear < localNow) {
        // Check if there are any unsent notifications for this reminder
        const unsent = await db.dbGet(
          `SELECT COUNT(*) as count FROM notification_queue 
           WHERE reminder_id = ? AND sent = 0`,
          [reminder.id]
        );

        if (unsent.count === 0) {
          console.log(`Rolling over birthday reminder ${reminder.id} ("${reminder.title}") to next year.`);
          await db.queueNotifications(reminder.id);
        }
      }
    }
  } catch (err) {
    console.error('Error rolling over birthdays:', err.message);
  }
}

module.exports = { startScheduler, rolloverBirthdays };
