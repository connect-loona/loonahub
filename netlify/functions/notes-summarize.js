exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Method not allowed'
    };
  }

  const { transcript, title, recordedBy } = JSON.parse(event.body);
  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (!CLAUDE_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not set' }), headers };
  }

  if (!transcript || !transcript.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No transcript provided' }), headers };
  }

  // IST, so relative dates ("by Friday", "end of this month") resolve against the team's
  // actual local day rather than the server's UTC clock. Weekday name is included explicitly
  // because models resolve "next Monday" more reliably when they don't also have to derive
  // today's day-of-week from a bare date first — that extra arithmetic step is where an
  // off-by-one (e.g. Monday coming out as Tuesday) tends to creep in.
  const istDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayIST = istDate.toISOString().slice(0, 10);
  const todayWeekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][istDate.getUTCDay()];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1800,
        system: `You turn raw meeting transcripts into clean, structured notes for a creative agency. Today is ${todayWeekday}, ${todayIST} (India Standard Time) — use this to resolve relative deadlines like "by Friday" or "next Monday" to an actual YYYY-MM-DD date; double-check your day-of-week arithmetic before answering.${recordedBy ? ` This meeting was recorded from ${recordedBy}'s device. The transcript's speaker labels ("Speaker 1", "Speaker 2", etc.) come from audio diarization and do NOT indicate who is who — you cannot tell which speaker is ${recordedBy} from the label alone. When a speaker claims an action item in the first person ("I'll do it", "I will handle this", "let me take care of that") and no other real name is given for that task, assign it to "${recordedBy}" rather than leaving it unassigned, since they are the person who recorded this meeting and a first-person claim most plausibly refers to them.` : ''} Always reply with ONLY valid JSON, no markdown fences, no commentary, matching this exact shape: {"summary": "2-4 sentence plain-language summary of what the meeting was about", "decisions": ["short bullet point per concrete decision made", "..."], "actionItems": [{"task": "clear, specific action to take", "assignee": "person's first name if mentioned or inferable per the rule above, else empty string", "dueDate": "YYYY-MM-DD if the transcript mentions a specific or relative deadline for this task (e.g. 'by Friday', 'next Monday', 'end of this month'), else empty string"}], "followUps": ["open question or item that needs a future follow-up", "..."], "clientSafeSummary": "a version of the summary and decisions rewritten to be safe to share externally with a client — strip internal team discussion, costs, staffing, and anything sensitive, keep only what a client would want to know about their project status and next steps. If the meeting was purely internal with nothing client-appropriate to share, use a short neutral line like 'Internal team sync — no client-facing updates.'"}. Keep decisions and followUps to at most 8 items each and actionItems to whatever is genuinely actionable (any of these can be an empty array if none apply). If the transcript is too short or unclear to summarize meaningfully, still return valid JSON with your best-effort interpretation.`,
        messages: [
          {
            role: 'user',
            content: `Meeting title: ${title || '(untitled)'}\n\nTranscript:\n${transcript}`
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    let raw = (data.content && data.content[0] && data.content[0].text) || '{}';
    raw = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { summary: raw, decisions: [], actionItems: [], followUps: [], clientSafeSummary: '' };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        summary: parsed.summary || '',
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
        followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
        clientSafeSummary: parsed.clientSafeSummary || ''
      }),
      headers
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }), headers };
  }
};
