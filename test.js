const db = require('./database');
const { rolloverBirthdays } = require('./scheduler');
const { DateTime } = require('luxon');

async function runTests() {
  console.log('--- STARTING TELEGRAM REMINDER BOT TESTS ---');
  
  // 1. Initialize DB
  await db.initDb();

  const testChatId = 123456789;
  const timezone = 'Asia/Tashkent';

  // Cleanup old test data
  await db.dbRun(`DELETE FROM notification_queue WHERE chat_id = ?`, [testChatId]);
  await db.dbRun(`DELETE FROM reminders WHERE chat_id = ?`, [testChatId]);
  await db.dbRun(`DELETE FROM users WHERE chat_id = ?`, [testChatId]);

  console.log('\n1. Saving test user...');
  await db.saveUser(testChatId, timezone, 'uz');
  const user = await db.getUser(testChatId);
  console.log('Saved user:', user);

  // Get current date/time in Tashkent timezone
  const nowTashkent = DateTime.now().setZone(timezone);
  console.log(`Current Tashkent local time: ${nowTashkent.toFormat('yyyy-MM-dd HH:mm:ss')}`);

  // 2. Add an exam reminder (e.g., 2 days from now at 10:00 AM)
  console.log('\n2. Adding exam reminder...');
  const examDate = nowTashkent.plus({ days: 2 }).set({ hour: 10, minute: 0 });
  const examDateStr = examDate.toFormat('yyyy-MM-dd HH:mm');
  console.log(`Exam scheduled for local time: ${examDateStr}`);

  const examId = await db.addReminder({
    chatId: testChatId,
    title: 'Matematika Imtihoni',
    eventType: 'exam',
    eventDate: examDateStr,
    notifyOffsets: '2d,1d,2h,0d'
  });
  console.log(`Exam reminder added with ID: ${examId}`);

  // 3. Add a birthday reminder (e.g., birthday on June 15)
  console.log('\n3. Adding birthday reminder...');
  // Let's set a birthday for a month from now to verify calculation
  const bday = nowTashkent.plus({ months: 1 });
  const bdayDateStr = bday.toFormat('MM-dd');
  console.log(`Birthday scheduled for: ${bday.toFormat('dd.MM')} (Stored as ${bdayDateStr})`);

  const bdayId = await db.addReminder({
    chatId: testChatId,
    title: 'Ukam Shaxzod',
    eventType: 'birthday',
    eventDate: bdayDateStr,
    notifyOffsets: '7d,2d,0d',
    notifyTime: '09:00'
  });
  console.log(`Birthday reminder added with ID: ${bdayId}`);

  // 4. Query and print reminders
  console.log('\n4. Listing active reminders in DB:');
  const reminders = await db.getReminders(testChatId);
  console.table(reminders);

  // 5. Query and print notification queue
  console.log('\n5. Listing scheduled notification queue (UTC):');
  const queue = await db.dbAll(
    `SELECT nq.*, r.title, r.event_type 
     FROM notification_queue nq
     JOIN reminders r ON nq.reminder_id = r.id
     WHERE nq.chat_id = ?`,
    [testChatId]
  );
  
  // Format dates for readable display in console table
  const formattedQueue = queue.map(q => ({
    id: q.id,
    reminder: q.title,
    type: q.event_type,
    label: q.offset_label,
    send_at_utc: q.send_at,
    send_at_local: DateTime.fromISO(q.send_at).setZone(timezone).toFormat('yyyy-MM-dd HH:mm:ss')
  }));
  console.table(formattedQueue);

  // 6. Test Birthday Rollover
  console.log('\n6. Testing birthday rollover...');
  // Let's simulate that Ukam Shaxzod's birthday was yesterday
  const yesterday = nowTashkent.minus({ days: 1 });
  const yesterdayBdayStr = yesterday.toFormat('MM-dd');
  
  console.log(`Updating Shaxzod's birthday to yesterday: ${yesterday.toFormat('dd.MM')} (${yesterdayBdayStr})`);
  await db.dbRun(
    `UPDATE reminders SET event_date = ? WHERE id = ?`,
    [yesterdayBdayStr, bdayId]
  );

  // Clear unsent notifications for Shaxzod (simulate they were already sent or cleaned up)
  await db.dbRun(`DELETE FROM notification_queue WHERE reminder_id = ? AND sent = 0`, [bdayId]);

  console.log('Running rolloverBirthdays scheduler task...');
  await rolloverBirthdays();

  console.log('Listing updated notification queue for Shaxzod:');
  const updatedQueue = await db.dbAll(
    `SELECT nq.*, r.title, r.event_type 
     FROM notification_queue nq
     JOIN reminders r ON nq.reminder_id = r.id
     WHERE nq.reminder_id = ?`,
    [bdayId]
  );

  const formattedUpdatedQueue = updatedQueue.map(q => ({
    id: q.id,
    reminder: q.title,
    label: q.offset_label,
    send_at_utc: q.send_at,
    send_at_local: DateTime.fromISO(q.send_at).setZone(timezone).toFormat('yyyy-MM-dd HH:mm:ss')
  }));
  console.table(formattedUpdatedQueue);

  // Verify that the new queue items are scheduled for next year
  const nextYear = nowTashkent.year + 1;
  const isRolledOver = formattedUpdatedQueue.every(q => q.send_at_local.startsWith(nextYear.toString()));
  if (isRolledOver && formattedUpdatedQueue.length > 0) {
    console.log('\x1b[32m%s\x1b[0m', '✅ SUCCESS: Birthday rollover correctly scheduled notifications for next year!');
  } else {
    console.log('\x1b[31m%s\x1b[0m', '❌ FAILURE: Birthday rollover did not correctly schedule notifications for next year.');
  }

  // Cleanup test data to keep database clean for user
  await db.dbRun(`DELETE FROM notification_queue WHERE chat_id = ?`, [testChatId]);
  await db.dbRun(`DELETE FROM reminders WHERE chat_id = ?`, [testChatId]);
  await db.dbRun(`DELETE FROM users WHERE chat_id = ?`, [testChatId]);
  console.log('\n--- TESTS COMPLETED. CLEANUP DONE. ---');
}

runTests().catch(err => console.error('Test run failed:', err));
