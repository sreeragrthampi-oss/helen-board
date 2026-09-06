// evening-digest
// Runs once daily at 9pm IST via cron. Purely deterministic — no AI writing,
// since this is meant for accurate data you'll paste straight into Obsidian.

import { createClient } from "npm:@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_TELEGRAM_ID = Deno.env.get("OWNER_TELEGRAM_ID")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  const provided = req.headers.get("X-Cron-Secret");
  if (provided !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const todayIST = getTodayIST();
  const tomorrowIST = getTomorrowIST();

  const blocksSection = await getBlocksRecap(todayIST);
  const tomorrowSection = await getTomorrowPreview(tomorrowIST);
  const journalSection = await getJournalForObsidian(todayIST);

  const checkins = `Did you check helen-board today?\nAre you working on this week's goals?`;
  const message = `🌙 Evening wrap-up — ${todayIST}\n\n${blocksSection}\n\n${tomorrowSection}\n\n${journalSection}\n\n${checkins}`;

  await sendTelegramMessage(message);

  return new Response("evening digest sent", { status: 200 });
});

async function getBlocksRecap(todayIST: string): Promise<string> {
  const { data } = await supabase
    .from("blocks")
    .select("title, status")
    .eq("block_date", todayIST)
    .order("position", { ascending: true });

  if (!data || data.length === 0) return "### Today's Blocks\nNone set today.";

  const icons: Record<string, string> = { done: "✅", current: "▶️", skipped: "⏭️", pending: "⬜" };
  const lines = data.map((b) => `${icons[b.status] ?? "⬜"} ${b.title}`).join("\n");
  return `### Today's Blocks\n${lines}`;
}

async function getTomorrowPreview(tomorrowIST: string): Promise<string> {
  const { data: reminders } = await supabase
    .from("reminders")
    .select("text, remind_at")
    .gte("remind_at", `${tomorrowIST}T00:00:00+05:30`)
    .lt("remind_at", `${addDays(tomorrowIST, 1)}T00:00:00+05:30`)
    .order("remind_at", { ascending: true });

  const { data: allEvents } = await supabase.from("events").select("*");
  const eventsTomorrow = (allEvents ?? []).filter((e) => {
    if (e.event_date === tomorrowIST) return true;
    const eventDate = new Date(e.event_date + "T00:00:00");
    const offsets = [30, 14, 7, 2, 1, 0];
    return offsets.some((o) => {
      const d = new Date(eventDate);
      d.setDate(d.getDate() - o);
      return d.toISOString().split("T")[0] === tomorrowIST;
    });
  });

  const reminderLines = (reminders ?? [])
    .map((r) => `- ${r.text} at ${formatTimeIST(r.remind_at)}`)
    .join("\n") || "None.";

  const eventLines = eventsTomorrow
    .map((e) => `- ${e.title}${e.notes ? ` (${e.notes})` : ""}`)
    .join("\n") || "None.";

  return `### Tomorrow (${tomorrowIST})\nReminders:\n${reminderLines}\n\nEvents:\n${eventLines}`;
}

async function getJournalForObsidian(todayIST: string): Promise<string> {
  const { data: entries } = await supabase
    .from("journal_entries")
    .select("entry_type, content")
    .eq("entry_date", todayIST)
    .order("created_at", { ascending: true });

  if (!entries || entries.length === 0) return `### Journal — ${todayIST}\nNothing logged today.`;

  const journalLines = entries.filter((e) => e.entry_type === "journal").map((e) => `- ${e.content}`).join("\n");
  const fleetingLines = entries.filter((e) => e.entry_type === "fleeting_note").map((e) => `- ${e.content}`).join("\n");

  let out = `### Journal — ${todayIST} (paste into Obsidian)\n`;
  if (journalLines) out += `\n**Journal**\n${journalLines}\n`;
  if (fleetingLines) out += `\n**Fleeting Notes**\n${fleetingLines}\n`;
  return out.trim();
}

function getTodayIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().split("T")[0];
}

function getTomorrowIST(): string {
  return addDays(getTodayIST(), 1);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
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
