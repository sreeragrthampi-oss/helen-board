// populate-recurring-blocks
// Runs once daily via cron. For each active recurring routine, ensures a
// real block exists in `blocks` for every matching day from today through
// the next 6 days — so /blocks, the Week view, and linked reminders all
// pick it up automatically without the user saying anything each morning.

import { createClient } from "npm:@supabase/supabase-js@2";

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  const provided = req.headers.get("X-Cron-Secret");
  if (provided !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const results = { checked: 0, created: 0 };

  const { data: routines, error: routinesError } = await supabase
    .from("recurring_blocks")
    .select("*")
    .eq("active", true);

  if (routinesError) {
    console.error("Error fetching recurring_blocks:", routinesError);
    return new Response(JSON.stringify({ error: routinesError.message }), { status: 500 });
  }

  const todayIST = getTodayIST();
  const dateRange: string[] = [];
  for (let i = 0; i < 7; i++) {
    dateRange.push(addDays(todayIST, i));
  }

  for (const routine of routines ?? []) {
    for (const dateStr of dateRange) {
      results.checked++;

      const dow = dayOfWeek(dateStr);
      if (!routine.days_of_week.includes(dow)) continue;
      if ((routine.excluded_dates ?? []).includes(dateStr)) continue;

      // Skip if this occurrence already exists (avoids duplicates on reruns)
      const { data: existing } = await supabase
        .from("blocks")
        .select("id")
        .eq("title", routine.title)
        .eq("block_date", dateStr)
        .eq("scheduled_time", routine.scheduled_time)
        .limit(1);

      if (existing && existing.length > 0) continue;

      const { data: existingPos } = await supabase
        .from("blocks")
        .select("position")
        .eq("block_date", dateStr)
        .order("position", { ascending: false })
        .limit(1);
      const nextPosition = existingPos && existingPos.length > 0 ? existingPos[0].position + 1 : 0;

      const { data: currentBlocks } = await supabase
        .from("blocks")
        .select("id")
        .eq("block_date", dateStr)
        .eq("status", "current");
      const status = !currentBlocks || currentBlocks.length === 0 ? "current" : "pending";

      const { error: insertError } = await supabase.from("blocks").insert({
        title: routine.title,
        position: nextPosition,
        status,
        block_date: dateStr,
        scheduled_time: routine.scheduled_time,
        end_time: routine.end_time,
      });

      if (insertError) {
        console.error(`Error inserting block for ${routine.title} on ${dateStr}:`, insertError);
        continue;
      }

      results.created++;
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

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function dayOfWeek(dateStr: string): number {
  // Sunday = 0 ... Saturday = 6, matching how days_of_week is stored
  const d = new Date(dateStr + "T00:00:00");
  return d.getDay();
}
