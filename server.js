/**
 * UDA Scale Academy - AI Growth Coach
 * Express server: serves the chat UI, answers via Anthropic API using
 * the course knowledge base, and forwards content requests to Make.
 *
 * Required env vars (set in Railway):
 *   ANTHROPIC_API_KEY   - your Anthropic API key
 * Optional env vars:
 *   MAKE_WEBHOOK_URL        - Make.com webhook for "request missing content"
 *   BOOKING_URL_MINDSET     - link to book a private mindset session
 *   BOOKING_URL_CASHFLOW    - link to book a private cashflow & profit session
 *   MODEL                   - defaults to claude-sonnet-4-6
 *   PORT                    - defaults to 3000
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const KB_DIR = path.join(__dirname, "knowledge-base");

// ---------------------------------------------------------------
// Knowledge base: load all markdown at boot, build a simple index
// ---------------------------------------------------------------
const docs = [];
function loadKB(dir, rel = "") {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const relPath = path.join(rel, item);
    if (fs.statSync(full).isDirectory()) {
      loadKB(full, relPath);
    } else if (item.endsWith(".md")) {
      const raw = fs.readFileSync(full, "utf-8");
      const meta = {};
      const m = raw.match(/^---\n([\s\S]*?)\n---/);
      if (m) {
        for (const line of m[1].split("\n")) {
          const i = line.indexOf(":");
          if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
      }
      const body = raw.replace(/^---\n[\s\S]*?\n---/, "").trim();
      const title = (body.match(/^#\s+(.+)/m) || [])[1] || item.replace(".md", "");
      docs.push({
        path: relPath,
        course: meta.course || meta.space || relPath.split(path.sep)[0].replace(/-/g, " "),
        section: meta.section || "",
        type: meta.type || "lesson",
        title,
        body,
        tokens: tokenize(title + " " + relPath + " " + body),
      });
    }
  }
}
function tokenize(s) {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2)
  );
}
loadKB(KB_DIR);
console.log(`Knowledge base loaded: ${docs.length} documents`);

// Rank docs against a query with simple term-overlap scoring,
// weighting title matches higher.
function retrieve(query, k = 6) {
  const qTokens = [...tokenize(query)];
  const scored = docs.map((d) => {
    let score = 0;
    for (const t of qTokens) {
      if (d.tokens.has(t)) score += 1;
      if (d.title.toLowerCase().includes(t)) score += 3;
      if (d.course.toLowerCase().includes(t)) score += 2;
    }
    return { d, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).filter((s) => s.score > 0).map((s) => s.d);
}

// ---------------------------------------------------------------
// System prompt: coach persona, prescriptions, referral rules
// ---------------------------------------------------------------
function systemPrompt(contextDocs) {
  const bookingMindset = process.env.BOOKING_URL_MINDSET || "";
  const bookingCashflow = process.env.BOOKING_URL_CASHFLOW || "";
  const contextBlock = contextDocs
    .map(
      (d, i) =>
        `<doc index="${i + 1}" course="${d.course}" section="${d.section}" title="${d.title}">\n` +
        d.body.slice(0, 2400) +
        `\n</doc>`
    )
    .join("\n\n");

  return `You are the UDA Scale Academy Growth Coach - an AI assistant inside Liza Simpson's coaching community for agency owners (The Upside Down Agency / UDA Scale Academy). You help members find the right training content, diagnose what is really holding their agency's growth back, and keep them accountable.

PERSONALITY & APPROACH:
- Warm, direct, practical - like a sharp coach who has run agencies, not a generic chatbot.
- Diagnose before prescribing: if a member describes a symptom (no leads, low profit, overwhelm), ask 1-2 sharp follow-up questions to find the underlying constraint before recommending content. Don't interrogate - two questions max, then give value.
- Prescribe specifically: point to actual courses/lessons from the ACADEMY CONTENT below by name (course + lesson), and explain in one line WHY that lesson addresses their situation. Suggest a concrete order to work through them.
- Give members a clear "do this next" - one action they can commit to. When natural, offer to turn a plan into a simple checklist they can work through and report back on.

USING ACADEMY CONTENT:
- The documents below were retrieved from the academy's course library based on the member's message. Ground your recommendations in them.
- If the retrieved content does not cover the member's question, say so honestly. Tell them you may not have that content yet and invite them to tap "Request this content" (a button in this chat) so Liza can see the gap and prioritise it. Never invent lessons that don't exist.

PRIVATE COACHING REFERRALS (important - use judgement, never be pushy):
- If the member shows signs of MINDSET struggles (self-doubt, imposter syndrome, fear of selling/raising prices, overwhelm, procrastination, burnout, "I know what to do but I don't do it"), first help them genuinely, then ONCE per conversation suggest booking a private mindset session with Liza${bookingMindset ? ` - booking link: ${bookingMindset}` : " (they can book via the 'Book your 1:1 with Liza' space in the community)"}. Frame it as the fastest way through, not as an upsell.
- If the member is wrestling with CASHFLOW, PROFIT or PRICING stress (can't pay themselves, margins evaporating, debt pressure, revenue up but profit flat), same rule: real help first, then suggest a private cashflow & profit session${bookingCashflow ? ` - booking link: ${bookingCashflow}` : " (bookable via the 'Book your 1:1 with Liza' space)"}.
- Maximum one referral suggestion per conversation, only when the signal is genuinely there, and always AFTER you've provided real value. If they decline or ignore it, don't raise it again.

STYLE:
- Keep responses tight - agency owners are busy. Short paragraphs, minimal fluff.
- Use the member's numbers and situation when they share them.
- Australian English is fine (Liza's community is Australia-based).

ACADEMY CONTENT (retrieved for this message):
${contextBlock || "(no strongly matching content found for this message)"}`;
}

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, email } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "messages required" });
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const context = retrieve(
      (lastUser ? lastUser.content : "") +
        " " +
        messages.slice(-4).map((m) => m.content).join(" ")
    );

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: systemPrompt(context),
        messages: messages.slice(-12),
      }),
    });
    const data = await anthropicResp.json();
    if (!anthropicResp.ok) {
      console.error("Anthropic error:", JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: "AI service error" });
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    res.json({ reply: text, sources: context.map((d) => ({ course: d.course, title: d.title })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/request-content", async (req, res) => {
  const { question, email, context } = req.body || {};
  const payload = {
    type: "content_request",
    question: question || "",
    member_email: email || "anonymous",
    conversation_context: (context || "").slice(0, 2000),
    requested_at: new Date().toISOString(),
  };
  console.log("CONTENT REQUEST:", JSON.stringify(payload));
  if (process.env.MAKE_WEBHOOK_URL) {
    try {
      await fetch(process.env.MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error("Webhook failed:", e.message);
    }
  }
  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true, docs: docs.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UDA Growth Coach running on :${PORT}`));
