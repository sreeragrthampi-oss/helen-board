// telegram-webhook (phase 2)
// Receives every message. Only acts if sender is you. Sends text to Haiku for
// classification, then inserts into the right Supabase table and replies.

import { createClient } from "npm:@supabase/supabase-js@2";
import { markListItemDoneById, markBlockDoneById } from "../_shared/db.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OWNER_TELEGRAM_ID = Deno.env.get("OWNER_TELEGRAM_ID")!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

// Auto-injected by Supabase, no manual secret needed
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (TELEGRAM_WEBHOOK_SECRET) {
    const headerSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (headerSecret !== TELEGRAM_WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const senderId = String(cq.from?.id ?? "");
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;

    if (senderId !== OWNER_TELEGRAM_ID) {
      await answerCallbackQuery(cq.id);
      return new Response("ok", { status: 200 });
    }

    if (cq.data?.startsWith("done:")) {
      const itemId = cq.data.slice(5);
      const item = await markListItemDoneById(supabase, itemId);
      const reply = item ? `Marked done in ${item.category}: "${item.title}"` : `Couldn't find that item.`;
      await answerCallbackQuery(cq.id, reply);

      const { data: remaining } = await supabase
        .from("list_items")
        .select("id, title")
        .eq("category", "todo")
        .eq("status", "pending")
        .order("created_at", { ascending: true });

      if (!remaining || remaining.length === 0) {
        await editTelegramMessage(chatId, messageId, "📋 All tasks done — nice work! ✅", null);
      } else {
        const updatedText = `📋 Pending tasks:\n${remaining.map((t) => `⬜ ${t.title}`).join("\n")}`;
        const updatedKeyboard = remaining.map((t) => [{ text: `✅ ${t.title}`, callback_data: `done:${t.id}` }]);
        await editTelegramMessage(chatId, messageId, updatedText, { inline_keyboard: updatedKeyboard });
      }
    }

    return new Response("ok", { status: 200 });
  }

  const message = update.message;
  if (!message) return new Response("ok", { status: 200 });

  const senderId = String(message.from?.id ?? "");
  const chatId = message.chat?.id;

  if (senderId !== OWNER_TELEGRAM_ID) {
    console.log(`Ignored message from unauthorized sender: ${senderId}`);
    return new Response("ok", { status: 200 });
  }

  const text = message.text;
  if (!text) {
    await sendTelegramMessage(chatId, "Got a non-text message — text only for now.");
    return new Response("ok", { status: 200 });
  }

  // Handle /today command before classification — pulls today's journal
  // entries and fleeting notes as paste-ready markdown for Obsidian.
  if (text.trim() === "/today") {
    const summary = await getTodaySummary();
    await sendTelegramMessage(chatId, summary);
    return new Response("ok", { status: 200 });
  }

  if (text.trim() === "/blocks") {
    const summary = await getBlocksSummary();
    await sendTelegramMessage(chatId, summary);
    return new Response("ok", { status: 200 });
  }

  if (text.trim() === "/usage") {
    const summary = await getUsageSummary();
    await sendTelegramMessage(chatId, summary);
    return new Response("ok", { status: 200 });
  }

  if (text.trim() === "/tasks") {
    const { text: taskText, inline_keyboard } = await getTasksData();
    await sendTelegramMessage(chatId, taskText, { inline_keyboard });
    return new Response("ok", { status: 200 });
  }

  if (text.trim() === "/lists") {
    const summary = await getListsSummary();
    await sendTelegramMessage(chatId, summary);
    return new Response("ok", { status: 200 });
  }

  // "Right now" (at the very start of the message) is a hard, deterministic
  // override — it bypasses the Haiku classifier entirely so it can never
  // get misrouted to a block/reminder/journal/etc. This mirrors the
  // "explicit word wins" idea behind the "event" override, but is handled
  // here in code since it's a fixed prefix the user always types first,
  // not a word that might appear anywhere inside a longer sentence.
  //
  // The colon is optional ("Right now: X" and "Right now X" both match),
  // and the body can be multi-line (each line becomes its own item) or a
  // single line with comma-separated items.
  const rightNowMatch = text.trim().match(/^right\s+now\b\s*[:,]?\s*([\s\S]*)/i);
  if (rightNowMatch) {
    const body = rightNowMatch[1].trim();
    if (body) {
      let items = body
        .split(/\r?\n/)
        .map((line) => line.replace(/^[\s\-*•\d.)]+/, "").trim())
        .filter(Boolean);

      // Single line, no bullets — check for a comma-separated list instead
      // (e.g. "Right now contact father, contact Vinod, and contact Nishad").
      if (items.length === 1) {
        const commaSplit = items[0]
          .split(",")
          .map((s) => s.replace(/^\s*and\s+/i, "").trim())
          .filter(Boolean);
        if (commaSplit.length > 1) items = commaSplit;
      }

      await supabase.from("message_log").insert({});
      try {
        const replies: string[] = [];
        for (const title of items) {
          replies.push(
            await handleClassification({ type: "list_item", category: "Right Now", title }, text)
          );
        }
        await sendTelegramMessage(chatId, replies.join("\n"));
      } catch (err) {
        console.error("Error handling Right Now item:", err);
        await sendTelegramMessage(chatId, "Something went wrong logging that — try again?");
      }
      return new Response("ok", { status: 200 });
    }
  }

  try {
    await supabase.from("message_log").insert({});
    const nowIST = getNowIST();
    const currentBlock = await getCurrentBlock();
    const classifications = await classifyWithHaiku(text, nowIST, currentBlock?.title ?? null);
    const replies: string[] = [];
    for (const c of classifications) {
      replies.push(await handleClassification(c, text));
    }
    await sendTelegramMessage(chatId, replies.join("\n\n"));
  } catch (err) {
    console.error("Error processing message:", err);
    await sendTelegramMessage(chatId, "Something went wrong processing that — logged the error, will need a look.");
  }

  return new Response("ok", { status: 200 });
});

function getTodayIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().split("T")[0];
}

async function getTodaySummary(): Promise<string> {
  const todayIST = getTodayIST();

  const { data: entries, error } = await supabase
    .from("journal_entries")
    .select("entry_type, content, created_at")
    .eq("entry_date", todayIST)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching today's entries:", error);
    return "Couldn't pull today's entries — something went wrong on my end.";
  }

  if (!entries || entries.length === 0) {
    return `No fleeting notes or journal entries logged for ${todayIST} yet.`;
  }

  const journalLines = entries
    .filter((e) => e.entry_type === "journal")
    .map((e) => `- ${e.content}`)
    .join("\n");

  const fleetingLines = entries
    .filter((e) => e.entry_type === "fleeting_note")
    .map((e) => `- ${e.content}`)
    .join("\n");

  let markdown = `## ${todayIST}\n\n`;
  if (journalLines) markdown += `### Journal\n${journalLines}\n\n`;
  if (fleetingLines) markdown += `### Fleeting Notes\n${fleetingLines}\n\n`;

  return markdown.trim();
}

function getNowIST(): string {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().replace("Z", "+05:30");
}

async function classifyWithHaiku(text: string, nowIST: string, currentBlockTitle: string | null): Promise<any[]> {
  const blockContext = currentBlockTitle
    ? `\n\nThe user's current active work block is: "${currentBlockTitle}". If the message says they're done/finished/complete with this specific block or its topic, classify as block_done — even if the phrasing sounds like a journal statement (e.g. "done with reading a book" when the block is "reading a book" means block_done, not journal). Only use journal/fleeting_note if the message is clearly about something unrelated to the current block, or is recounting a past experience rather than reporting task completion.`
    : "";

  const systemPrompt = `You are a classifier for a personal assistant called Helen. The current date/time in IST is ${nowIST}.${blockContext}

The user's message may contain MORE THAN ONE distinct thing at once — e.g. setting today's blocks AND listing several separate to-do items in the same message. Extract EVERY distinct intent you find, and respond with a JSON ARRAY containing one object per intent, even if there's only one. Respond with ONLY the raw JSON array, no other text, where each object matches one of these shapes:

For a one-off reminder (something to be told at a specific future time — nudges about external things like calls, deadlines, appointments, not your own scheduled activities). If the user gives NO specific time (e.g. "remind me to buy oranges tomorrow"), default the time portion to 09:00:00 and set time_specified to false. If they do give a time, use it exactly and set time_specified to true:
{"type": "reminder", "text": "short reminder text", "remind_at": "YYYY-MM-DDTHH:MM:SS+05:30", "time_specified": true or false}

For an event with a target date (weddings, appointments, deadlines — things happening TO or AROUND the user, not the user's own personal routine/activity blocks like workouts or classes, which are block_add instead). IMPORTANT OVERRIDE: if the user explicitly uses the word "event" anywhere in the message (e.g. "add an event: yoga retreat this weekend"), always classify as event regardless of how personal or activity-like it sounds — the explicit word is a deliberate signal that takes priority over the usual heuristic:
{"type": "event", "title": "event name", "event_date": "YYYY-MM-DD", "notes": "any extra detail or null"}

For a rambling idea, thought, or fleeting note to capture (not a task or reminder):
{"type": "fleeting_note", "content": "the user's actual words, lightly trimmed of filler like 'umm' only — preserve their exact wording, phrasing, and any formatting like [[double brackets]] exactly as written. Do NOT rewrite, rephrase, or summarize."}

For a journal/diary entry about something that happened:
{"type": "journal", "content": "the user's actual words, lightly trimmed of filler like 'umm' only — preserve their exact wording, phrasing, and any formatting like [[double brackets]] exactly as written. Do NOT rewrite, rephrase, or summarize."}

For anything else — greetings, questions, general conversation:
{"type": "chat", "reply": "a short, warm, natural reply"}

For setting today's full list of flexible work blocks, no fixed times (only when the user is clearly laying out their whole day's plan, e.g. "today's blocks are X, Y, Z"):
{"type": "block_set", "blocks": ["block 1", "block 2", "block 3"]}

For marking the current block as finished (e.g. "done with that", "finished"):
{"type": "block_done"}

For skipping the current block without finishing it (e.g. "skip gym", "let's skip this one"):
{"type": "block_skip"}

For adding one new block — to today's flexible queue by default, OR to a specific future date, OR with a fixed clock time (start, and optionally end), OR any combination. This is for the user's OWN scheduled activities/blocks — workouts, classes, work sessions, personal routines — as opposed to "reminder" (nudges about external things) or "event" (things happening to/around the user). If the activity sounds like something the user will personally do or attend (a class, workout, session, routine), ALWAYS prefer block_add over reminder or event, even if the phrasing includes a date, a time, or a time range like "from X to Y". Resolve day names/relative dates to an absolute YYYY-MM-DD using the current date above. Omit target_date if it means today. Omit scheduled_time and end_time if no time was mentioned at all. If only a start time was given (no explicit end), omit end_time — the system will default it. Worked examples:
- "add a block: pick up dry cleaning" → {"type": "block_add", "title": "pick up dry cleaning"}
- "workout at 6pm" → {"type": "block_add", "title": "workout", "scheduled_time": "18:00"}
- "yoga class from 6am to 7:30am tomorrow" → {"type": "block_add", "title": "yoga class", "target_date": "<tomorrow's date>", "scheduled_time": "06:00", "end_time": "07:30"}
{"type": "block_add", "title": "block title", "target_date": "YYYY-MM-DD or null", "scheduled_time": "HH:MM in 24hr format or null", "end_time": "HH:MM in 24hr format or null, ONLY if the user explicitly gave an end time"}

For creating a RECURRING/PERMANENT routine block that repeats on specific days of the week indefinitely (e.g. "yoga class every Monday, Wednesday, Friday at 6am", "gym every day at 6pm", "meditation every weekday at 7am"). Trigger words/phrasing: "every day", "daily", "every [day names]", "routine", "permanent". This ALWAYS requires a scheduled_time — if the user gives no time, this doesn't apply, use block_add instead. Resolve day names into a lowercase 3-letter array like ["mon","wed","fri"]; use the string "daily" for every day, "weekdays" for Mon-Fri, "weekends" for Sat-Sun:
{"type": "block_recurring_add", "title": "block title", "scheduled_time": "HH:MM in 24hr format", "end_time": "HH:MM in 24hr format or null (defaults to 1hr later)", "days": ["mon","wed","fri"] or "daily" or "weekdays" or "weekends"}

For stopping/deactivating an existing recurring routine entirely, all future days (e.g. "stop the yoga class routine", "cancel my gym routine"):
{"type": "block_recurring_stop", "title": "routine title or close match"}

For skipping a recurring routine on one specific date or a date range, WITHOUT stopping it permanently — it resumes automatically afterward (e.g. "skip yoga class tomorrow", "skip gym next week", "no yoga class on Friday"). Resolve relative dates to absolute YYYY-MM-DD using the current date above. If it's a single day, set skip_date_end the same as skip_date:
{"type": "block_recurring_skip", "title": "routine title or close match", "skip_date": "YYYY-MM-DD", "skip_date_end": "YYYY-MM-DD"}

For reordering two blocks (e.g. "swap gym and admin"):
{"type": "block_swap", "a": "first block name", "b": "second block name"}

For asking what's left / current status of today's blocks (e.g. "what's left today", "show my blocks"):
{"type": "block_show"}

For adding an item to a categorized list — general to-dos, urgent items, movies to watch, books to read, or any other category the user names (e.g. "add Dune to my movies to watch list", "add call the plumber to urgent", "mark attendance for today's class", "send an email about the meditation class"). If the user doesn't name a category, default to "todo". If the message lists several items, output one object per item, all with type "list_item":
{"type": "list_item", "category": "short lowercase category name e.g. todo, urgent, movies, books — use \"todo\" if the user doesn't name one", "title": "the item itself"}

For marking an existing list item as done, in any category (e.g. "watched Dune", "done with calling the plumber", "I sent that email", "done with the attendance marking"):
{"type": "list_item_done", "title": "item title or close match", "category": "category if mentioned, or null"}

For logging a measurable progress metric — workouts, yoga, meditation, reading, notes, or any trackable practice, anything with a number attached (e.g. "did 10 pushups, 4 squats, held warrior pose 50 sec", "read 20 pages", "created 3 zettelkasten notes"). A single message can contain several metrics — output one object per metric, all with type "progress":
{"type": "progress", "category": "short category name grouping related metrics e.g. \"Workout + Yoga\", \"Reading\", \"Notes\" — infer a sensible one if unclear, defaulting to \"General\"", "metric_name": "short lowercase metric name e.g. pushups, squats, warrior pose hold, pages read, zettelkasten notes", "value": numeric value only, "unit": "unit as a short word or null if the metric is just a count e.g. reps, seconds, minutes, pages, notes"}

Always resolve relative dates/times (tomorrow, next month, in 2 weeks) into absolute values based on the current date/time given above. Output ONLY the raw JSON array — no markdown code blocks, no backticks, no explanation before or after.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    }),
  });

  const data = await res.json();
  let raw = data.content?.[0]?.text ?? "[]";

  raw = raw.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  try {
    const parsed = JSON.parse(raw);
    // Backward-safe: if the model ever returns a single object instead of an array, wrap it
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    console.error("Failed to parse Haiku output:", raw);
    return [{ type: "chat", reply: "I heard you, but had trouble understanding the structure of that — could you rephrase?" }];
  }
}

function normalizeForMatch(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/(ing|ed)$/, "").replace(/s$/, ""));
}

// Word-level fuzzy match: stems each word (strips -ing/-ed/-s) and checks
// overlap, so "call the plumber" matches "calling the plumber" even though
// neither string is a literal substring of the other.
function fuzzyTitleMatch(a: string, b: string): boolean {
  const aw = normalizeForMatch(a);
  const bw = normalizeForMatch(b);
  if (aw.length === 0 || bw.length === 0) return false;
  const shorter = aw.length <= bw.length ? aw : bw;
  const longer = aw.length <= bw.length ? bw : aw;
  const overlap = shorter.filter((w) => longer.includes(w)).length;
  return overlap / shorter.length >= 0.6;
}

function formatTime12h(time24: string): string {
  // time24 looks like "06:00:00" or "18:30:00" or "06:00"
  const [hStr, mStr] = time24.split(":");
  let h = parseInt(hStr, 10);
  const m = mStr;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function addOneHour(time24: string): string {
  // time24 looks like "HH:MM"
  const [hStr, mStr] = time24.split(":");
  let h = (parseInt(hStr, 10) + 1) % 24;
  return `${String(h).padStart(2, "0")}:${mStr}`;
}

function dayNameToNum(name: string): number {
  const map: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return map[name.toLowerCase().slice(0, 3)] ?? -1;
}

function resolveDaysField(days: any): number[] {
  if (typeof days === "string") {
    const d = days.toLowerCase();
    if (d === "daily") return [0, 1, 2, 3, 4, 5, 6];
    if (d === "weekdays") return [1, 2, 3, 4, 5];
    if (d === "weekends") return [0, 6];
    const n = dayNameToNum(d);
    return n >= 0 ? [n] : [];
  }
  if (Array.isArray(days)) {
    return days.map((d: string) => dayNameToNum(d)).filter((n: number) => n >= 0);
  }
  return [];
}

function dateRangeArray(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");
  while (cursor <= end) {
    dates.push(cursor.toISOString().split("T")[0]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

async function handleClassification(c: any, originalText: string): Promise<string> {
  switch (c.type) {
    case "reminder": {
      const { error } = await supabase.from("reminders").insert({
        text: c.text,
        remind_at: c.remind_at,
      });
      if (error) throw error;

      // Every reminder also shows up as a block, since the user checks
      // /blocks and the dashboard more reliably than they read every ping.
      // If no specific time was given, the block stays flexible (no time)
      // rather than showing a misleadingly precise default slot.
      const timeSpecified = c.time_specified !== false;
      const remindDate = c.remind_at.split("T")[0];
      const remindTime = c.remind_at.split("T")[1].slice(0, 5);
      const blockScheduledTime = timeSpecified ? remindTime : null;
      const blockEndTime = timeSpecified ? addOneHour(remindTime) : null;

      const { data: existingPos } = await supabase
        .from("blocks")
        .select("position")
        .eq("block_date", remindDate)
        .order("position", { ascending: false })
        .limit(1);
      const nextPosition = existingPos && existingPos.length > 0 ? existingPos[0].position + 1 : 0;

      const { data: currentBlocks } = await supabase
        .from("blocks")
        .select("id")
        .eq("block_date", remindDate)
        .eq("status", "current");
      const blockStatus = !currentBlocks || currentBlocks.length === 0 ? "current" : "pending";

      await supabase.from("blocks").insert({
        title: c.text,
        position: nextPosition,
        status: blockStatus,
        block_date: remindDate,
        scheduled_time: blockScheduledTime,
        end_time: blockEndTime,
      });

      return `Got it — I'll remind you: "${c.text}" at ${formatIST(c.remind_at)}.`;
    }

    case "event": {
      const { error } = await supabase.from("events").insert({
        title: c.title,
        event_date: c.event_date,
        notes: c.notes ?? null,
      });
      if (error) throw error;
      return `Added "${c.title}" on ${c.event_date} — I'll nudge you at 2 weeks, 1 week, 2 days, 1 day, and the day itself.`;
    }

    case "fleeting_note": {
      const { error } = await supabase.from("journal_entries").insert({
        entry_type: "fleeting_note",
        content: c.content,
      });
      if (error) throw error;
      return `Captured that idea — filed for tonight's review.`;
    }

    case "journal": {
      const { error } = await supabase.from("journal_entries").insert({
        entry_type: "journal",
        content: c.content,
      });
      if (error) throw error;
      return `Logged in today's journal.`;
    }

    case "block_set": {
      const todayIST = getTodayIST();
      // Clear any existing blocks for today, then insert the new queue
      await supabase.from("blocks").delete().eq("block_date", todayIST);

      const rows = (c.blocks as string[]).map((title, i) => ({
        title,
        position: i,
        status: i === 0 ? "current" : "pending",
        block_date: todayIST,
      }));

      const { error } = await supabase.from("blocks").insert(rows);
      if (error) throw error;
      return `Set today's blocks:\n${(c.blocks as string[]).map((b, i) => `${i + 1}. ${b}`).join("\n")}\n\nFirst up: ${c.blocks[0]}`;
    }

    case "block_done": {
      const current = await getCurrentBlock();
      if (!current) return "No current block to mark done — set today's blocks first.";
      const { done, next } = await markBlockDoneById(supabase, current.id);
      await supabase.from("journal_entries").insert({
        entry_type: "journal",
        content: `Completed "${done}": ${originalText}`,
      });
      return next ? `Nice — "${done}" done. Next up: ${next}` : `Nice — "${done}" done. That's everything for today!`;
    }

    case "block_skip": {
      const current = await getCurrentBlock();
      if (!current) return "No current block to skip — set today's blocks first.";
      await supabase.from("blocks").update({ status: "skipped" }).eq("id", current.id);
      const next = await advanceToNextBlock(current.position);
      return next ? `Skipped "${current.title}". Next up: ${next.title}` : `Skipped "${current.title}". That's everything for today!`;
    }

    case "block_add": {
      const todayIST = getTodayIST();
      const targetDate = c.target_date || todayIST;
      const scheduledTime = c.scheduled_time || null;
      let endTime = c.end_time || null;
      let assumedDefaultEnd = false;

      if (scheduledTime && !endTime) {
        endTime = addOneHour(scheduledTime);
        assumedDefaultEnd = true;
      }

      const { data: existing } = await supabase
        .from("blocks")
        .select("position")
        .eq("block_date", targetDate)
        .order("position", { ascending: false })
        .limit(1);

      const nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 0;
      const { data: currentBlocks } = await supabase
        .from("blocks")
        .select("id")
        .eq("block_date", targetDate)
        .eq("status", "current");

      const status = !currentBlocks || currentBlocks.length === 0 ? "current" : "pending";

      const { error } = await supabase.from("blocks").insert({
        title: c.title,
        position: nextPosition,
        status,
        block_date: targetDate,
        scheduled_time: scheduledTime,
        end_time: endTime,
      });
      if (error) throw error;

      const dateLabel = targetDate === todayIST ? "today's queue" : `queue for ${targetDate}`;
      let timeLabel = "";
      if (scheduledTime && endTime) {
        timeLabel = ` from ${formatTime12h(scheduledTime)} to ${formatTime12h(endTime)}${assumedDefaultEnd ? " (assumed 1hr, tell me the real end time if different)" : ""}`;
      }
      return `Added "${c.title}"${timeLabel} to ${dateLabel}.`;
    }

    case "block_recurring_add": {
      const scheduledTime = c.scheduled_time;
      if (!scheduledTime) {
        return `A recurring block needs a time — try again with something like "yoga class every Monday at 6am".`;
      }
      const endTime = c.end_time || addOneHour(scheduledTime);
      const daysArr = resolveDaysField(c.days);
      if (daysArr.length === 0) {
        return `Couldn't figure out which days that repeats on — try naming them explicitly, e.g. "every Monday, Wednesday, Friday".`;
      }

      const { error } = await supabase.from("recurring_blocks").insert({
        title: c.title,
        scheduled_time: scheduledTime,
        end_time: endTime,
        days_of_week: daysArr,
      });
      if (error) throw error;

      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const dayLabels = daysArr.map((n: number) => dayNames[n]).join(", ");
      return `Set up "${c.title}" as a recurring block: ${formatTime12h(scheduledTime)}–${formatTime12h(endTime)}, on ${dayLabels}. It'll appear automatically each matching day.`;
    }

    case "block_recurring_stop": {
      const { data: routines } = await supabase.from("recurring_blocks").select("*").eq("active", true);
      const match = routines?.find((r) => fuzzyTitleMatch(r.title, String(c.title)));
      if (!match) return `Couldn't find an active recurring routine matching "${c.title}".`;

      await supabase.from("recurring_blocks").update({ active: false }).eq("id", match.id);

      const todayIST = getTodayIST();
      await supabase
        .from("blocks")
        .delete()
        .eq("title", match.title)
        .eq("scheduled_time", match.scheduled_time)
        .gte("block_date", todayIST);
      await supabase
        .from("reminders")
        .delete()
        .eq("text", match.title)
        .eq("delivered", false)
        .gte("remind_at", `${todayIST}T00:00:00+05:30`);

      return `Stopped the "${match.title}" routine. Past occurrences stay in your history; future ones are cleared.`;
    }

    case "block_recurring_skip": {
      const { data: routines } = await supabase.from("recurring_blocks").select("*").eq("active", true);
      const match = routines?.find((r) => fuzzyTitleMatch(r.title, String(c.title)));
      if (!match) return `Couldn't find an active recurring routine matching "${c.title}".`;

      const startDate = c.skip_date;
      const endDate = c.skip_date_end || c.skip_date;
      const newExclusions = dateRangeArray(startDate, endDate);
      const updatedExclusions = [...new Set([...(match.excluded_dates || []), ...newExclusions])];

      await supabase.from("recurring_blocks").update({ excluded_dates: updatedExclusions }).eq("id", match.id);

      await supabase
        .from("blocks")
        .delete()
        .eq("title", match.title)
        .eq("scheduled_time", match.scheduled_time)
        .gte("block_date", startDate)
        .lte("block_date", endDate);
      await supabase
        .from("reminders")
        .delete()
        .eq("text", match.title)
        .eq("delivered", false)
        .gte("remind_at", `${startDate}T00:00:00+05:30`)
        .lte("remind_at", `${endDate}T23:59:59+05:30`);

      return `Skipping "${match.title}" from ${startDate} to ${endDate}. It'll resume automatically afterward.`;
    }

    case "block_swap": {
      const todayIST = getTodayIST();
      const { data: blocks } = await supabase
        .from("blocks")
        .select("*")
        .eq("block_date", todayIST)
        .in("status", ["pending", "current"]);

      const a = blocks?.find((b) => b.title.toLowerCase().includes(String(c.a).toLowerCase()));
      const b = blocks?.find((b2) => b2.title.toLowerCase().includes(String(c.b).toLowerCase()));

      if (!a || !b) return "Couldn't find both of those blocks in today's list.";

      await supabase.from("blocks").update({ position: b.position }).eq("id", a.id);
      await supabase.from("blocks").update({ position: a.position }).eq("id", b.id);
      return `Swapped "${a.title}" and "${b.title}".`;
    }

    case "block_show": {
      return await getBlocksSummary();
    }

    case "progress": {
      const rawCategory = c.category || "General";

      // Snap to an existing category if a close match exists, so Haiku's
      // wording drift (e.g. "Workout" vs "Workout + Yoga") doesn't fragment
      // the dashboard into near-duplicate sections.
      const { data: existingCategories } = await supabase
        .from("progress_entries")
        .select("category")
        .limit(200);

      const distinctCategories = [...new Set((existingCategories ?? []).map((r) => r.category))];
      const matchedCategory = distinctCategories.find((existing) => fuzzyTitleMatch(existing, rawCategory));
      const category = matchedCategory ?? rawCategory;

      const { error } = await supabase.from("progress_entries").insert({
        category,
        metric_name: c.metric_name,
        value: c.value,
        unit: c.unit ?? null,
        entry_date: getTodayIST(),
      });
      if (error) throw error;
      return `Logged: ${c.metric_name} — ${c.value}${c.unit ? " " + c.unit : ""} (${category})`;
    }

    case "list_item": {
      const category = c.category || "todo";
      const { data: existing } = await supabase
        .from("list_items")
        .select("position")
        .eq("category", category)
        .order("position", { ascending: false })
        .limit(1);

      const nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 0;

      const { error } = await supabase.from("list_items").insert({
        category,
        title: c.title,
        position: nextPosition,
      });
      if (error) throw error;
      return `Added "${c.title}" to your ${category} list.`;
    }

    case "list_item_done": {
      let query = supabase.from("list_items").select("*").eq("status", "pending");
      if (c.category) query = query.eq("category", c.category);
      const { data: pending } = await query;

      const match = pending?.find((li) => fuzzyTitleMatch(li.title, String(c.title)));
      if (!match) return `Couldn't find a pending list item matching "${c.title}"${c.category ? ` in ${c.category}` : ""}.`;
      const item = await markListItemDoneById(supabase, match.id);
      return item ? `Marked done in ${item.category}: "${item.title}"` : `Couldn't find that item.`;
    }

    case "chat":
    default:
      return c.reply ?? `Heard you: "${originalText}"`;
  }
}

async function getCurrentBlock(): Promise<any | null> {
  const todayIST = getTodayIST();
  const { data } = await supabase
    .from("blocks")
    .select("*")
    .eq("block_date", todayIST)
    .eq("status", "current")
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

async function advanceToNextBlock(afterPosition: number): Promise<any | null> {
  const todayIST = getTodayIST();
  const { data } = await supabase
    .from("blocks")
    .select("*")
    .eq("block_date", todayIST)
    .eq("status", "pending")
    .gt("position", afterPosition)
    .order("position", { ascending: true })
    .limit(1);

  if (!data || data.length === 0) return null;

  await supabase.from("blocks").update({ status: "current" }).eq("id", data[0].id);
  return data[0];
}

async function getBlocksSummary(): Promise<string> {
  const todayIST = getTodayIST();
  const { data } = await supabase
    .from("blocks")
    .select("*")
    .eq("block_date", todayIST)
    .order("position", { ascending: true });

  if (!data || data.length === 0) return "No blocks set for today yet.";

  const icons: Record<string, string> = { done: "✅", current: "▶️", skipped: "⏭️", pending: "⬜" };
  return data
    .map((b) => {
      const timeLabel = b.scheduled_time
        ? ` (${formatTime12h(b.scheduled_time)}${b.end_time ? "–" + formatTime12h(b.end_time) : ""})`
        : "";
      return `${icons[b.status] ?? "⬜"} ${b.title}${timeLabel}`;
    })
    .join("\n");
}

async function getUsageSummary(): Promise<string> {
  const todayIST = getTodayIST();
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const monthStartIST = `${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, "0")}-01`;

  const { count: todayCount } = await supabase
    .from("message_log")
    .select("*", { count: "exact", head: true })
    .gte("created_at", `${todayIST}T00:00:00+05:30`);

  const { count: monthCount } = await supabase
    .from("message_log")
    .select("*", { count: "exact", head: true })
    .gte("created_at", `${monthStartIST}T00:00:00+05:30`);

  const avgCostPerMessage = 0.25; // rough estimate in rupees
  const fixedMonthlyOverhead = 40; // hourly chime + daily digest, roughly

  const todayEst = ((todayCount ?? 0) * avgCostPerMessage).toFixed(2);
  const monthEst = ((monthCount ?? 0) * avgCostPerMessage + fixedMonthlyOverhead).toFixed(2);

  return `📊 Usage (rough estimate)\n\nToday: ${todayCount ?? 0} messages (~₹${todayEst})\nThis month: ${monthCount ?? 0} messages (~₹${monthEst} incl. chime/digest overhead)\n\nThis is an estimate, not your actual bill — check console.anthropic.com for the real number.`;
}

async function getTasksData(): Promise<{ text: string; inline_keyboard: any[][] }> {
  const { data } = await supabase
    .from("list_items")
    .select("id, title")
    .eq("category", "todo")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (!data || data.length === 0) {
    return { text: "No pending tasks — nice and clear.", inline_keyboard: [] };
  }
  const text = `📋 Pending tasks:\n${data.map((t) => `⬜ ${t.title}`).join("\n")}`;
  const inline_keyboard = data.map((t) => [{ text: `✅ ${t.title}`, callback_data: `done:${t.id}` }]);
  return { text, inline_keyboard };
}

async function getListsSummary(): Promise<string> {
  const { data } = await supabase
    .from("list_items")
    .select("category, title, status")
    .eq("status", "pending")
    .order("category", { ascending: true })
    .order("position", { ascending: true });

  if (!data || data.length === 0) return "All lists are clear — nothing pending.";

  const grouped: Record<string, string[]> = {};
  for (const item of data) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(`⬜ ${item.title}`);
  }

  return Object.entries(grouped)
    .map(([category, items]) => `📁 ${category}\n${items.join("\n")}`)
    .join("\n\n");
}

function formatIST(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

async function sendTelegramMessage(chatId: number, text: string, replyMarkup?: any) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
  });
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function editTelegramMessage(chatId: number, messageId: number, text: string, replyMarkup: any) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    }),
  });
}
