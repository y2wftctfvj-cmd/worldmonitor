/**
 * QStash Setup Script — one-time setup to create a 5-minute schedule.
 *
 * Run this once to configure Upstash QStash to hit the monitor-check
 * endpoint every 5 minutes. QStash free tier: 500 msgs/day (288 needed).
 *
 * Usage:
 *   QSTASH_TOKEN=xxx node api/setup-qstash.js
 *
 * This replaces Vercel's cron (which only does 1x/day on Hobby).
 * The monitor-check endpoint accepts both Vercel cron auth AND QStash signatures.
 */

const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const DESTINATION = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}/api/monitor-check`
  : 'https://worldmonitor-two-kappa.vercel.app/api/monitor-check';
const SCHEDULE = '*/5 * * * *'; // Every 5 minutes

async function setupQStashSchedule() {
  if (!QSTASH_TOKEN) {
    console.error('Error: QSTASH_TOKEN environment variable is required.');
    console.error('Get it from: https://console.upstash.com/qstash');
    process.exit(1);
  }

  if (!CRON_SECRET) {
    console.error('Warning: CRON_SECRET not set. QStash will call without auth header.');
    console.error('Set CRON_SECRET in your environment to enable auth forwarding.');
  }

  console.log('Creating QStash schedule...');
  console.log(`  Destination: ${DESTINATION}`);
  console.log(`  Schedule: ${SCHEDULE}`);

  try {
    const headers = {
      Authorization: `Bearer ${QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'Upstash-Cron': SCHEDULE,
    };

    // Forward the CRON_SECRET as an Authorization header so monitor-check
    // can authenticate the request the same way it authenticates Vercel cron
    if (CRON_SECRET) {
      headers['Upstash-Forward-Authorization'] = `Bearer ${CRON_SECRET}`;
    }

    const resp = await fetch(`https://qstash.upstash.io/v2/schedules/${DESTINATION}`, {
      method: 'POST',
      headers,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error(`QStash API error ${resp.status}:`, errBody);
      process.exit(1);
    }

    const result = await resp.json();
    console.log('Schedule created successfully!');
    console.log('  Schedule ID:', result.scheduleId);
    console.log('\nTo verify: curl -H "Authorization: Bearer $QSTASH_TOKEN" https://qstash.upstash.io/v2/schedules');
    console.log('To delete: curl -X DELETE -H "Authorization: Bearer $QSTASH_TOKEN" https://qstash.upstash.io/v2/schedules/' + result.scheduleId);
  } catch (err) {
    console.error('Failed to create schedule:', err.message);
    process.exit(1);
  }
}

setupQStashSchedule();
