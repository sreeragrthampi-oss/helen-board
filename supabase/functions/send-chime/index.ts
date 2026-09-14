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


Deno.serve(async (req) => {
  const provided = req.headers.get("X-Cron-Secret");
  if (provided !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const currentBlock = await getCurrentBlock();
  const blockLine = currentBlock ? `▶️ Next up: ${currentBlock.title}\n\n` : "";
  const motivationLine = await getMotivationLine();
  const fullMessage = `${blockLine}💭 ${motivationLine}\n\n💧 Log your water in the dashboard`;

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
  "Preparation: working hard before pressure forces you to, preparing beyond what's required, practicing until skills become automatic rather than something you have to think about under stress.",
  "Deliberate weakness practice: most people practice what already makes them feel competent; real improvement comes from scheduling dedicated time for the skill you keep avoiding.",
  "Raising the bar after wins: success is dangerous when it convinces you current effort is enough — after something goes well, ask what would make the next version noticeably better.",
  "Resilience: it's not about how hard life hits, it's about how much you can take and keep moving forward.",
  "Life built around chosen values: some people build their life around one thing by default; a deliberate life is built around what you actually choose — spirituality, learning, teaching, helping others, relationships.",
  "Living fully / not fearing time passing: the risk isn't getting older, it's not having lived. You never know what's coming, at any age.",
  "Self-respect through order: an organized, clean environment reflects and reinforces internal discipline.",
];

async function getMotivationLine(): Promise<string> {
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const format = Math.random() < 0.5 ? "quote" : "question";
  const formatInstruction = format === "quote"
    ? "Write it as a short punchy statement (1-2 sentences)."
    : "Write it as a short pointed question that makes the reader honestly check in with themselves for a moment.";
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
            content: `Generate an original line in the spirit of this theme — treat the description only as a tone/register reference, never reuse its phrasing verbatim:\n\nTheme: ${theme}\n\n${formatInstruction}\n\nOutput only the line itself, no preamble, no quotation marks.`,
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