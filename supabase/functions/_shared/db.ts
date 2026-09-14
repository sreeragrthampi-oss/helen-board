import { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function markListItemDoneById(
  supabase: SupabaseClient,
  itemId: string,
): Promise<{ title: string; category: string } | null> {
  const { data: item } = await supabase
    .from("list_items")
    .select("title, category")
    .eq("id", itemId)
    .single();
  if (!item) return null;
  await supabase.from("list_items").update({ status: "done" }).eq("id", itemId);
  return item;
}

export async function markBlockDoneById(
  supabase: SupabaseClient,
  blockId: string,
): Promise<{ done: string; next: string | null }> {
  const { data: block } = await supabase
    .from("blocks")
    .select("title, position, block_date")
    .eq("id", blockId)
    .single();
  if (!block) return { done: "unknown", next: null };
  await supabase.from("blocks").update({ status: "done" }).eq("id", blockId);
  const { data: nextBlocks } = await supabase
    .from("blocks")
    .select("id, title")
    .eq("block_date", block.block_date)
    .eq("status", "pending")
    .gt("position", block.position)
    .order("position", { ascending: true })
    .limit(1);
  const next = nextBlocks?.[0] ?? null;
  if (next) {
    await supabase.from("blocks").update({ status: "current" }).eq("id", next.id);
  }
  return { done: block.title, next: next?.title ?? null };
}

export async function deleteListItemById(
  supabase: SupabaseClient,
  itemId: string,
): Promise<void> {
  const { error } = await supabase
    .from("list_items")
    .delete()
    .eq("id", itemId);
  if (error) throw error;
}

export async function createListItem(
  supabase: SupabaseClient,
  category: string,
  title: string,
): Promise<{ id: string; title: string; category: string }> {
  const { data: existing } = await supabase
    .from("list_items")
    .select("position")
    .eq("category", category)
    .order("position", { ascending: false })
    .limit(1);
  const nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 0;
  const { data, error } = await supabase
    .from("list_items")
    .insert({ category, title, position: nextPosition })
    .select("id, title, category")
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCategory(
  supabase: SupabaseClient,
  category: string,
): Promise<void> {
  const { error } = await supabase
    .from("list_items")
    .delete()
    .eq("category", category);
  if (error) throw error;
}

export async function deleteBlockById(
  supabase: SupabaseClient,
  blockId: string,
): Promise<void> {
  const { error } = await supabase.from("blocks").delete().eq("id", blockId);
  if (error) throw error;
}

export async function deleteBlockRecurring(
  supabase: SupabaseClient,
  blockId: string,
): Promise<{ wasRecurring: boolean }> {
  const { data: block } = await supabase
    .from("blocks")
    .select("title, recurring_block_id")
    .eq("id", blockId)
    .single();

  if (!block) return { wasRecurring: false };

  if (!block.recurring_block_id) {
    await supabase.from("blocks").delete().eq("id", blockId);
    return { wasRecurring: false };
  }

  const recurringId = block.recurring_block_id;
  const today = getDateIST();

  await supabase.from("recurring_blocks").update({ active: false }).eq("id", recurringId);
  await supabase
    .from("blocks")
    .delete()
    .eq("recurring_block_id", recurringId)
    .gte("block_date", today);
  await supabase
    .from("reminders")
    .delete()
    .eq("text", block.title)
    .eq("delivered", false)
    .gte("remind_at", `${today}T00:00:00+05:30`);

  return { wasRecurring: true };
}

export async function addRecurringBlock(
  supabase: SupabaseClient,
  title: string,
  scheduled_time: string,
  end_time: string | null,
  days_of_week: number[],
): Promise<{ id: string }> {
  const resolvedEndTime = end_time || addOneHour(scheduled_time);

  const { data, error } = await supabase
    .from("recurring_blocks")
    .insert({ title, scheduled_time, end_time: resolvedEndTime, days_of_week })
    .select("id")
    .single();
  if (error) throw error;

  const recurringId = data.id;
  const today = getDateIST();

  for (let i = 0; i < 7; i++) {
    const dateStr = addDaysLocal(today, i);
    const dow = new Date(dateStr + "T00:00:00").getDay();
    if (!days_of_week.includes(dow)) continue;

    const { data: existing } = await supabase
      .from("blocks")
      .select("id")
      .eq("title", title)
      .eq("block_date", dateStr)
      .eq("scheduled_time", scheduled_time)
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

    await supabase.from("blocks").insert({
      title,
      position: nextPosition,
      status,
      block_date: dateStr,
      scheduled_time,
      end_time: resolvedEndTime,
      recurring_block_id: recurringId,
    });
  }

  return { id: recurringId };
}

export async function addProgressEntry(
  supabase: SupabaseClient,
  category: string,
  metric_name: string,
  value: number,
  unit: string | null,
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("progress_entries")
    .insert({ category, metric_name, value, unit, entry_date: getDateIST() })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}

export async function addBlock(
  supabase: SupabaseClient,
  title: string,
  block_date: string,
  scheduled_time: string | null,
  end_time: string | null,
): Promise<{ id: string }> {
  const { data: existing } = await supabase
    .from("blocks")
    .select("position")
    .eq("block_date", block_date)
    .order("position", { ascending: false })
    .limit(1);
  const nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 0;

  const { data: currentBlocks } = await supabase
    .from("blocks")
    .select("id")
    .eq("block_date", block_date)
    .eq("status", "current");
  const status = !currentBlocks || currentBlocks.length === 0 ? "current" : "pending";

  const { data, error } = await supabase
    .from("blocks")
    .insert({ title, block_date, scheduled_time, end_time, position: nextPosition, status })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}

function getDateIST(): string {
  const now = new Date();
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function addDaysLocal(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function addOneHour(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  const h = (parseInt(hStr, 10) + 1) % 24;
  return `${String(h).padStart(2, "0")}:${mStr}`;
}
