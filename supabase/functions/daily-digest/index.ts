// daily-digest
// Runs once daily at 5am IST via cron. Gathers today's reminders and events,
// asks Sonnet to write a warm morning summary, sends it via Telegram.

import { createClient } from "npm:@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_TELEGRAM_ID = Deno.env.get("OWNER_TELEGRAM_ID")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const LONG_TERM_GOALS = [
  "Building an army of Nirvana Yoga teachers",
  "Finishing a Master's in Yoga",
  "Publishing 20 books",
  "Doing regular sadhana",
  "Learning Spanish",
  "Learning Romanian",
  "Learning Hindi",
  "Learning anatomy and physiology",
  "Publishing on YouTube",
  "Writing newsletters",
  "Working on the CRM tool",
  "Working on the PWA",
  "Learning survival skills and practical know-how",
  "Cooking",
  "Farming",
];

Deno.serve(async (req) => {
  const provided = req.headers.get("X-Cron-Secret");
  if (provided !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const todayIST = getTodayIST();
  const tomorrowIST = getTomorrowIST();

  // Today's one-off reminders
  const { data: reminders } = await supabase
    .from("reminders")
    .select("text, remind_at")
    .gte("remind_at", `${todayIST}T00:00:00+05:30`)
    .lt("remind_at", `${tomorrowIST}T00:00:00+05:30`)
    .order("remind_at", { ascending: true });

  // Events happening today, or with any milestone landing today
  const { data: allEvents } = await supabase.from("events").select("*");
  const eventsToday = (allEvents ?? []).filter((e) => {
    if (e.event_date === todayIST) return true;
    const eventDate = new Date(e.event_date + "T00:00:00");
    const offsets = [30, 14, 7, 2, 1, 0];
    return offsets.some((o) => {
      const d = new Date(eventDate);
      d.setDate(d.getDate() - o);
      return d.toISOString().split("T")[0] === todayIST;
    });
  });

  const summaryText = await writeDigestWithSonnet(reminders ?? [], eventsToday, todayIST);
  const dayOfWeek = new Date(todayIST + "T00:00:00").getDay(); // 1=Mon
  const isMonday = dayOfWeek === 1;
  const goalLine = isMonday
    ? `\n🎯 Long-term focus: ${LONG_TERM_GOALS[getDayOfYear(todayIST) % LONG_TERM_GOALS.length]}`
    : "";
  const fullMessage = `${summaryText}\n\nHave you done today's goal writing — declarations, gratitude, habit focus?${goalLine}`;
  await sendTelegramMessage(fullMessage);

  return new Response("digest sent", { status: 200 });
});

async function writeDigestWithSonnet(
  reminders: { text: string; remind_at: string }[],
  events: any[],
  todayIST: string,
): Promise<string> {
  const reminderLines = reminders
    .map((r) => `- ${r.text} at ${formatTimeIST(r.remind_at)}`)
    .join("\n") || "None today.";

  const eventLines = events
    .map((e) => `- ${e.title} on ${e.event_date}${e.notes ? ` (${e.notes})` : ""}`)
    .join("\n") || "None today.";

  const prompt = `Write a short, warm good-morning message for a personal assistant called Helen to send to her user. Today's date is ${todayIST}. Keep it to 3-5 sentences, natural and encouraging, not robotic or listy — but do clearly mention the specific items below so nothing gets missed. If there's nothing scheduled, just wish them a good day with light encouragement.

Today's reminders:
${reminderLines}

Today's events/milestones:
${eventLines}

Output ONLY the message text, nothing else — no preamble, no markdown formatting.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  return data.content?.[0]?.text?.trim() ?? "Good morning! Have a great day.";
}

function getDayOfYear(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00");
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
}

function getTodayIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().split("T")[0];
}

function getTomorrowIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  istDate.setDate(istDate.getDate() + 1);
  return istDate.toISOString().split("T")[0];
}

function formatTimeIST(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", timeStyle: "short" });
}

async function sendTelegramMessage(text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(OWNER_TELEGRAM_ID), text }),
  });
}
