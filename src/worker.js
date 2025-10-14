export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    // Validate webhook secret
    const webhookSecret = request.headers.get("x-fireflies-secret");
    if (webhookSecret !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Read body (Fireflies sends JSON)
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    // Quick webhook handshake / ping handling
    if (payload.type === "ping") {
      return json({ ok: true });
    }

    // Fireflies webhook payloads typically include transcript_id or meeting info.
    // We handle both: direct transcript_id, or nested under data.
    const transcriptId =
      payload.transcript_id ||
      payload.transcriptId ||
      payload?.data?.transcript_id ||
      payload?.data?.transcriptId;

    if (!transcriptId) {
      return new Response("No transcript_id in webhook", { status: 200 });
    }

    // Fetch transcript+analytics from Fireflies GraphQL
    const ff = await fetchFireflies(env.FIREFLIES_API_KEY, transcriptId);

    if (!ff?.data?.transcript) {
      // If API returns nothing (e.g., processing not finished), just ack to avoid retries storms
      return new Response("No transcript yet", { status: 200 });
    }

    const t = ff.data.transcript;
    // Useful fields (null-safe)
    const title = t.title || "";
    const dateISO = t.date || ""; // ISO string
    const durationSec = t.duration_seconds ?? null;
    const transcriptUrl = t.transcript_url || "";
    const participants = Array.isArray(t.participants) ? t.participants : []; // often emails
    const speakers = t.speakers || []; // [{id, name}]
    const speakerAnalytics = t.analytics?.speakers || []; // per-speaker metrics (talk time, words, questions, etc.)

    // Derive attendance per "person". Prefer analytics by speaker name or email; fall back to participants list.
    // We'll generate rows for:
    // - Every analytics speaker
    // - Any participant emails not matched by speaker name/email (marked not attended unless later matched)
    const byPerson = determineAttendance({
      speakers,
      speakerAnalytics,
      participants,
      thresholds: {
        WORDS_MIN: Number(env.ACTIVE_WORDS_MIN || 20), // words spoken
        DURATION_MIN_SEC: Number(env.ACTIVE_DURATION_MIN_SEC || 60), // seconds spoken
        QUESTIONS_MIN: Number(env.ACTIVE_QUESTIONS_MIN || 1), // asked >= 1 question
      },
    });

    // Prepare Google Sheets insert
    const whenISO = new Date().toISOString();
    const meetingID = transcriptId;

    const values = byPerson.map((p) => [
      whenISO,
      meetingID,
      p.person,
      p.attended ? "TRUE" : "FALSE",
      p.confidence.toFixed(2),
      p.reason,
      title,
      dateISO,
      durationSec ?? "",
      transcriptUrl,
    ]);

    if (values.length) {
      await appendToSheet({
        apiKey: env.GOOGLE_API_KEY,
        spreadsheetId: env.SHEET_ID,
        rangeA1: `${env.SHEET_TAB || "Attendance"}!A:J`,
        values,
      });
    }

    return new Response("OK", { status: 200 });
  },
};

/* ---------------- Fireflies GraphQL ---------------- */

async function fetchFireflies(apiKey, transcriptId) {
  const query = `
    query GetTranscript($id: ID!) {
      transcript(transcript_id: $id) {
        transcript_id
        title
        date
        duration_seconds
        transcript_url
        participants       # array of emails
        speakers { id name }
        analytics {
          speakers {
            name
            user_id
            user_email
            word_count
            questions
            monologues_count
            longest_monologue
            duration_pct
            duration_sec
            words_per_minute
            filler_words
          }
        }
      }
    }
  `;
  // NOTE: The above fields are documented under Transcript & MeetingAnalytics schemas. Some fields require Pro+ plans.

  const res = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { id: transcriptId } }),
  });

  // Fireflies uses token-based Bearer auth over a single GraphQL endpoint.
  return res.json();
}

/* ---------------- Attendance Heuristics ---------------- */

function determineAttendance({
  speakers,
  speakerAnalytics,
  participants,
  thresholds,
}) {
  // Build index by normalized name/email
  const norm = (s) => (s || "").trim().toLowerCase();
  const analyticsByKey = new Map();

  for (const s of speakerAnalytics) {
    const keyName = norm(s.name);
    const keyEmail = norm(s.user_email);
    const record = {
      display: s.name || s.user_email || "Unknown",
      word_count: s.word_count ?? 0,
      duration_sec: s.duration_sec ?? null,
      questions: s.questions ?? 0,
      duration_pct: s.duration_pct ?? null,
    };
    if (keyName) analyticsByKey.set(`n:${keyName}`, record);
    if (keyEmail) analyticsByKey.set(`e:${keyEmail}`, record);
  }

  const rows = [];
  const seen = new Set();

  // Prefer analytics speakers (they actually spoke)
  for (const [key, rec] of analyticsByKey.entries()) {
    if (seen.has(rec.display)) continue;
    const attended = isActive(rec, thresholds);
    const { score, reason } = scoreActive(rec, thresholds);
    rows.push({
      person: rec.display,
      attended,
      confidence: score,
      reason,
    });
    seen.add(rec.display);
  }

  // Add participant emails that didn't appear as speakers (likely silent attendees)
  for (const email of participants || []) {
    const keyEmail = `e:${norm(email)}`;
    if (analyticsByKey.has(keyEmail)) continue; // already captured above
    const display = email;
    // If they never spoke, mark not attended (or use a softer rule if you want "present == attended")
    rows.push({
      person: display,
      attended: false,
      confidence: 0.5,
      reason: "Present in participant list but no speech/activity detected",
    });
  }

  // If no analytics (plan/basic), fall back to "any participant == attended=false" to be conservative.
  if (!rows.length && Array.isArray(participants) && participants.length) {
    for (const email of participants) {
      rows.push({
        person: email,
        attended: false,
        confidence: 0.4,
        reason: "Analytics unavailable; cannot confirm activity",
      });
    }
  }

  return rows;
}

function isActive(rec, th) {
  const w = rec.word_count || 0;
  const d = rec.duration_sec || 0;
  const q = rec.questions || 0;
  return w >= th.WORDS_MIN || d >= th.DURATION_MIN_SEC || q >= th.QUESTIONS_MIN;
}

function scoreActive(rec, th) {
  // Simple confidence model: add up normalized contributions from words, duration, questions
  const w = rec.word_count || 0;
  const d = rec.duration_sec || 0;
  const q = rec.questions || 0;

  let score = 0.0;
  score += Math.min(w / (th.WORDS_MIN * 2), 1) * 0.4; // up to 0.4 from words
  score += Math.min(d / (th.DURATION_MIN_SEC * 2), 1) * 0.4; // up to 0.4 from duration
  score += Math.min(q / (th.QUESTIONS_MIN * 2), 1) * 0.2; // up to 0.2 from questions
  score = Math.max(0.1, Math.min(1.0, score));

  const reasons = [];
  if (w) reasons.push(`${w} words`);
  if (d) reasons.push(`${d}s spoken`);
  if (q) reasons.push(`${q} questions`);
  return {
    score,
    reason: reasons.length ? reasons.join("; ") : "No detectable speech",
  };
}

/* ---------------- Google Sheets helpers (API Key) ---------------- */

async function appendToSheet({ apiKey, spreadsheetId, rangeA1, values }) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}/values/${encodeURIComponent(
    rangeA1
  )}:append?valueInputOption=USER_ENTERED&key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Sheets append failed: ${res.status} ${t}`);
  }
}

/* ---------------- utils ---------------- */

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
