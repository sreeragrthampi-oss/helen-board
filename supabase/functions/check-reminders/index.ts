// check-reminders
// Runs every 5 minutes via cron. Finds due one-off reminders, periodic
// advance-notice checkpoints for upcoming reminders, and un-sent event
// milestones (1mo/2wk/1wk/2d/1d/same-day), delivers them via Telegram,
// and marks them so each fires exactly once.

import { createClient } from "npm:@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_TELEGRAM_ID = Deno.env.get("OWNER_TELEGRAM_ID")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Reminder checkpoints, expressed in minutes before remind_at.
const REMINDER_CHECKPOINTS: { key: string; offsetMinutes: number; label: string }[] = [
  { key: "reminded_30days", offsetMinutes: 30 * 24 * 60, label: "in 30 days" },
  { key: "reminded_14days", offsetMinutes: 14 * 24 * 60, label: "in 14 days" },
  { key: "reminded_7days", offsetMinutes: 7 * 24 * 60, label: "in 7 days" },
  { key: "reminded_2days", offsetMinutes: 2 * 24 * 60, label: "in 2 days" },
  { key: "reminded_1day", offsetMinutes: 1 * 24 * 60, label: "tomorrow" },
  { key: "reminded_2hours", offsetMinutes: 2 * 60, label: "in 2 hours" },
  { key: "reminded_30min", offsetMinutes: 30, label: "in 30 minutes" },
];

// Event milestones, expressed in days before event_date.
const EVENT_MILESTONES: { key: string; offsetDays: number; label: string }[] = [
  { key: "reminded_1month", offsetDays: 30, label: "in 1 month" },
  { key: "reminded_2weeks", offsetDays: 14, label: "in 2 weeks" },
  { key: "reminded_1week", offsetDays: 7, label: "in 1 week" },
  { key: "reminded_2days", offsetDays: 2, label: "in 2 days" },
  { key: "reminded_1day", offsetDays: 1, label: "tomorrow" },
  { key: "reminded_sameday", offsetDays: 0, label: "today" },
];

Deno.serve(async (req) => {
  const provided = req.headers.get("X-Cron-Secret");
  if (provided !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const results = { reminders: 0, reminderCheckpoints: 0, milestones: 0 };
  const now = new Date();

  // --- One-off reminders: exact-time delivery ---
  const { data: dueReminders, error: remError } = await supabase
    .from("reminders")
    .select("*")
    .eq("delivered", false)
    .lte("remind_at", now.toISOString());

  if (remError) {
    console.error("Error fetching reminders:", remError);
  } else {
    for (const r of dueReminders ?? []) {
      await sendTelegramMessage(`⏰ Reminder: ${r.text}`);
      await supabase.from("reminders").update({ delivered: true }).eq("id", r.id);
      results.reminders++;
    }
  }

  // --- One-off reminders: periodic advance-notice checkpoints ---
  const { data: pendingReminders, error: pendingError } = await supabase
    .from("reminders")
    .select("*")
    .eq("delivered", false);

  if (pendingError) {
    console.error("Error fetching pending reminders:", pendingError);
  } else {
    for (const r of pendingReminders ?? []) {
      const remindAt = new Date(r.remind_at);
      const createdAt = new Date(r.created_at);

      for (const cp of REMINDER_CHECKPOINTS) {
        if (r[cp.key]) continue; // already sent

        const threshold = new Date(remindAt.getTime() - cp.offsetMinutes * 60 * 1000);

        // Only fire if the checkpoint moment has arrived AND it falls after
        // the reminder was created — otherwise a reminder set for "tomorrow"
        // would immediately fire its (already-past) 30-day/14-day checkpoints.
        if (threshold >= createdAt && threshold <= now) {
          await sendTelegramMessage(`🔔 Heads up — "${r.text}" is ${cp.label}`);
          await supabase.from("reminders").update({ [cp.key]: true }).eq("id", r.id);
          results.reminderCheckpoints++;
        }
      }
    }
  }

  // --- Event milestones ---
  const todayIST = getTodayIST();
  const { data: events, error: evError } = await supabase.from("events").select("*");

  if (evError) {
    console.error("Error fetching events:", evError);
  } else {
    for (const e of events ?? []) {
      const eventDate = new Date(e.event_date + "T00:00:00");

      for (const m of EVENT_MILESTONES) {
        if (e[m.key]) continue; // already sent

        const milestoneDate = new Date(eventDate);
        milestoneDate.setDate(milestoneDate.getDate() - m.offsetDays);
        const milestoneDateStr = milestoneDate.toISOString().split("T")[0];

        if (milestoneDateStr === todayIST) {
          const notesPart = e.notes ? ` (${e.notes})` : "";
          await sendTelegramMessage(`📅 "${e.title}" is ${m.label}${notesPart}`);
          await supabase.from("events").update({ [m.key]: true }).eq("id", e.id);
          results.milestones++;
        }
      }
    }
  }

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

function getTodayIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().split("T")[0];
}

async function sendTelegramMessage(text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(OWNER_TELEGRAM_ID), text }),
  });
}
