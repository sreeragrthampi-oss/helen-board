// send-chime
// Sends the hourly reset checklist, plus today's current Lego block if set.
// Triggered by pg_cron.

import { createClient } from "npm:@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_TELEGRAM_ID = Deno.env.get("OWNER_TELEGRAM_ID")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CHECKLIST = `🔔 Reset check:
1. Check helen-board
2. Mute/unmute phone as needed
3. Drink water
4. Pray a little
5. Charge gadgets — phone, earbuds, scooter
6. Clean the room a little
7. Blocks check, tick
8. Check Google Tasks
9. Journal the last hour in a few words, thriller, revise it
10. Any fleeting notes? stories? Capture them now
11. Momentum, small wins
12. 90 days, sacrifices
13. Slow

Keep the momentum. Move with urgency. Stay fluid. Win the next hour — small wins matter.`;

Deno.serve(async (req) => {
  const provided = req.headers.get("X-Cron-Secret");
  if (provided !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const currentBlock = await getCurrentBlock();
  const blockLine = currentBlock ? `\n\n▶️ Next up: ${currentBlock.title}` : "";
  const motivationLine = await getMotivationLine();
  const fullMessage = CHECKLIST + blockLine + `\n\n💭 ${motivationLine}`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(OWNER_TELEGRAM_ID),
      text: fullMessage,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Telegram send failed:", errText);
    return new Response(errText, { status: 500 });
  }

  return new Response("chime sent", { status: 200 });
});

const THEMES = [
  "Football underdog spirit: a small team playing without fear of bigger opponents, enjoying the game itself, momentum and small wins mattering more than big glory, urgency, fluidity, and team chemistry through hard work.",
  "Savoring the ordinary: living this day as if given a second chance to notice the small things most people rush past.",
  "Gamifying the grind: staying playful and smiling even during hard work, loving deadlines, finding thrill in small wins and just making it to the end of the day with realistic goals — live to fight another day.",
  "The only real failure is quitting or restarting a streak entirely. The goal isn't a perfect streak — it's someone who, months from now, never fully stopped. Drifted, returned, drifted, returned, and kept going. No fresh start needed. Just the next clean action, ball in hand.",
  "The real miracle isn't something dramatic — it's a single parent working two jobs who still makes it to their kid's practice, or someone working a day job while studying at night. Ordinary persistence under real constraints is the actual miracle.",
  "An identity statement: 'I am someone who shows up for this, even on bad days, even if it's just 10 minutes.' Small, quiet, consistent identity over intensity.",
];

async function getMotivationLine(): Promise<string> {
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: `Write ONE short, original motivational message (2-3 sentences max) capturing this spirit, in your own words — do not quote or reference any specific movie, book, or song by name, just channel the underlying idea:\n\n${theme}\n\nOutput only the message itself, no preamble, no quotation marks.`,
          },
        ],
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text?.trim() ?? "Small wins, right now. Keep going.";
  } catch (err) {
    console.error("Error generating motivation line:", err);
    return "Small wins, right now. Keep going.";
  }
}

async function getCurrentBlock(): Promise<{ title: string } | null> {
  const todayIST = getTodayIST();
  const { data, error } = await supabase
    .from("blocks")
    .select("title")
    .eq("block_date", todayIST)
    .eq("status", "current")
    .limit(1);

  if (error) {
    console.error("Error fetching current block:", error);
    return null;
  }
  return data && data.length > 0 ? data[0] : null;
}

function getTodayIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().split("T")[0];
}