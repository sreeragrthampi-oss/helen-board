// helen-board (API version)
// Returns Progress + Lists data as JSON. The actual dashboard UI is a static
// HTML file hosted on GitHub Pages, which fetches this endpoint client-side.
// Supabase Edge Functions don't serve HTML directly (content-type gets
// rewritten to text/plain), so the API/UI split lives here instead.

import { createClient } from "npm:@supabase/supabase-js@2";
import { markListItemDoneById, markBlockDoneById, deleteListItemById, createListItem, deleteCategory } from "../_shared/db.ts";

const PROGRESS_ACCESS_TOKEN = Deno.env.get("PROGRESS_ACCESS_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (token !== PROGRESS_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  if (req.method === "POST") {
    try {
      const body = await req.json();
      const { action, id, category, title } = body;

      if (!action) {
        return new Response(JSON.stringify({ error: "missing action" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (action === "list_item_done") {
        const item = await markListItemDoneById(supabase, id);
        if (!item) {
          return new Response(JSON.stringify({ error: "item not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        }
        return new Response(JSON.stringify({ ok: true, title: item.title, category: item.category }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (action === "block_done") {
        const result = await markBlockDoneById(supabase, id);
        return new Response(JSON.stringify({ ok: true, ...result }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (action === "delete_item") {
        await deleteListItemById(supabase, id);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (action === "add_list_item") {
        if (!category || !title) {
          return new Response(JSON.stringify({ error: "missing category or title" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        }
        const item = await createListItem(supabase, category.trim(), title.trim());
        return new Response(JSON.stringify({ ok: true, id: item.id, title: item.title, category: item.category }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (action === "add_right_now") {
        if (!title) {
          return new Response(JSON.stringify({ error: "missing title" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        }
        const item = await createListItem(supabase, "Right Now", title.trim());
        return new Response(JSON.stringify({ ok: true, id: item.id, title: item.title, category: item.category }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      if (action === "delete_category") {
        if (!category) {
          return new Response(JSON.stringify({ error: "missing category" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          });
        }
        await deleteCategory(supabase, category);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }

      return new Response(JSON.stringify({ error: "unknown action" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    } catch (err) {
      console.error("POST error:", err);
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
  }

  try {
    const [progress, lists, reminders, events, blocks, weekBlocks] = await Promise.all([
      getProgressData(),
      getListData(),
      getRemindersData(),
      getEventsData(),
      getBlocksData(),
      getWeekBlocksData(),
    ]);
    return new Response(JSON.stringify({ progress, lists, reminders, events, blocks, weekBlocks }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    console.error("Error building dashboard data:", err);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
});

type ProgressEntry = { entry_date: string; value: number; unit: string | null };
type ProgressByCategory = Record<string, Record<string, ProgressEntry[]>>;

async function getProgressData(): Promise<ProgressByCategory> {
  const { data, error } = await supabase
    .from("progress_entries")
    .select("category, metric_name, value, unit, entry_date")
    .order("entry_date", { ascending: true });

  if (error) throw error;

  const grouped: ProgressByCategory = {};
  for (const row of data ?? []) {
    if (!grouped[row.category]) grouped[row.category] = {};
    if (!grouped[row.category][row.metric_name]) grouped[row.category][row.metric_name] = [];
    grouped[row.category][row.metric_name].push({
      entry_date: row.entry_date,
      value: row.value,
      unit: row.unit,
    });
  }
  return grouped;
}

async function getListData(): Promise<Record<string, { id: string; title: string; status: string }[]>> {
  const { data, error } = await supabase
    .from("list_items")
    .select("id, category, title, status")
    .order("category", { ascending: true })
    .order("position", { ascending: true });

  if (error) throw error;

  const grouped: Record<string, { id: string; title: string; status: string }[]> = {};
  for (const row of data ?? []) {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push({ id: row.id, title: row.title, status: row.status });
  }
  return grouped;
}

async function getRemindersData(): Promise<{ text: string; remind_at: string }[]> {
  const { data, error } = await supabase
    .from("reminders")
    .select("text, remind_at")
    .eq("delivered", false)
    .order("remind_at", { ascending: true })
    .limit(15);

  if (error) throw error;
  return (data ?? []).map((r) => ({ text: r.text, remind_at: r.remind_at }));
}

async function getEventsData(): Promise<{ title: string; event_date: string; notes: string | null }[]> {
  const todayIST = getTodayIST();
  const { data, error } = await supabase
    .from("events")
    .select("title, event_date, notes")
    .gte("event_date", todayIST)
    .order("event_date", { ascending: true })
    .limit(15);

  if (error) throw error;
  return (data ?? []).map((e) => ({ title: e.title, event_date: e.event_date, notes: e.notes }));
}

async function getBlocksData(): Promise<{ id: string; title: string; status: string }[]> {
  const todayIST = getTodayIST();
  const { data, error } = await supabase
    .from("blocks")
    .select("id, title, status")
    .eq("block_date", todayIST)
    .order("position", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((b) => ({ id: b.id, title: b.title, status: b.status }));
}

type WeekBlock = {
  title: string;
  status: string;
  scheduled_time: string | null;
  end_time: string | null;
  position: number;
};
type WeekBlocksByDate = Record<string, WeekBlock[]>;

async function getWeekBlocksData(): Promise<WeekBlocksByDate> {
  const todayIST = getTodayIST();
  const endDate = addDaysIST(todayIST, 6);

  const { data, error } = await supabase
    .from("blocks")
    .select("title, status, block_date, scheduled_time, end_time, position")
    .gte("block_date", todayIST)
    .lte("block_date", endDate)
    .order("block_date", { ascending: true })
    .order("position", { ascending: true });

  if (error) throw error;

  const grouped: WeekBlocksByDate = {};
  for (const row of data ?? []) {
    if (!grouped[row.block_date]) grouped[row.block_date] = [];
    grouped[row.block_date].push({
      title: row.title,
      status: row.status,
      scheduled_time: row.scheduled_time,
      end_time: row.end_time,
      position: row.position,
    });
  }
  return grouped;
}

function addDaysIST(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function getTodayIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().split("T")[0];
}
