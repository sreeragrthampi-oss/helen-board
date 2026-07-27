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
