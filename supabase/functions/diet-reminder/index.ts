// diet-reminder
// Plain diet-tracking nudge, 3x/day.
// Schedule (pg_cron): 30 5,9,15 * * * UTC = 11:00 / 15:00 / 21:00 IST

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_TELEGRAM_ID  = Deno.env.get("OWNER_TELEGRAM_ID")!;
const CRON_SECRET        = Deno.env.get("CRON_SECRET")!;

const NUDGES = [
  "🍽️ Morning check — meals tracked so far? Log diet in the dashboard.",
  "🍽️ Afternoon check — lunch tracked? Log diet in the dashboard.",
  "🍽️ Evening check — tracked everything today? Log diet before you wind down.",
];

Deno.serve(async (req) => {
  if (req.headers.get("X-Cron-Secret") !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const istHour = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
  const nudge = istHour < 13 ? NUDGES[0] : istHour < 18 ? NUDGES[1] : NUDGES[2];

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(OWNER_TELEGRAM_ID), text: nudge }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Telegram send failed:", err);
    return new Response(err, { status: 500 });
  }

  return new Response("diet reminder sent", { status: 200 });
});
