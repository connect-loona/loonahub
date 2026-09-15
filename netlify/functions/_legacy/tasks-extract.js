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
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { transcript, members, brands } = JSON.parse(event.body);
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (!OPENAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not set' }), headers };
  }

  if (!transcript || !transcript.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No transcript provided' }), headers };
  }

  const memberList = Array.isArray(members) ? members.join(', ') : '';
  const brandList = Array.isArray(brands) ? brands.join(', ') : '';
  // IST, with the weekday name included explicitly — resolving "by Friday" requires knowing
  // today's day-of-week first, and that extra derivation step is where models tend to slip
  // by a day.
  const istDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStr = istDate.toISOString().slice(0, 10);
  const todayWeekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][istDate.getUTCDay()];

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You extract discrete, actionable tasks from a spoken or typed note for a creative agency. The note may be in English, Hindi, or Hinglish (code-mixed Hindi/English). Today is ${todayWeekday}, ${todayStr} (India Standard Time) — double-check your day-of-week arithmetic before resolving a relative date. Known team members: ${memberList || '(none provided)'}. Known brand/client names: ${brandList || '(none provided)'}.

For each distinct task mentioned, output an object with:
- "task": a clear, specific description of the action to take, always written in English regardless of the note's language (rewrite for clarity, keep it short)
- "assignee": must be exactly one of the known team members (matched by first name is fine) if a person is named or clearly implied as responsible, else an empty string — never invent a name not in the list
- "brand": must be exactly one of the known brand/client names if one is mentioned or clearly implied, else an empty string — never invent a name not in the list
- "due_date": "YYYY-MM-DD" if a date or relative date (e.g. "tomorrow", "by Friday", "next week", "17th") is mentioned, computed relative to today's date, else an empty string
- "priority": "High", "Medium", or "Low" if urgency is stated or clearly implied (e.g. "urgent", "high priority", "whenever", "low priority"), else "Medium"

Reply with ONLY valid JSON, no markdown fences, no commentary, matching this exact shape: {"tasks": [{"task": "...", "assignee": "...", "brand": "...", "due_date": "...", "priority": "..."}]}. If the transcript names multiple tasks, return all of them. If nothing actionable is found, return {"tasks": []}.`
          },
          { role: 'user', content: transcript }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    let raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
    raw = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { tasks: [] };
    }

    const memberSet = new Set(Array.isArray(members) ? members : []);
    const brandSet = new Set(Array.isArray(brands) ? brands : []);
    const prioritySet = new Set(['High', 'Medium', 'Low']);
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).map(t => ({
      task: (t.task || '').toString(),
      assignee: memberSet.has(t.assignee) ? t.assignee : '',
      brand: brandSet.has(t.brand) ? t.brand : '',
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : '',
      priority: prioritySet.has(t.priority) ? t.priority : 'Medium'
    })).filter(t => t.task.trim());

    return { statusCode: 200, body: JSON.stringify({ tasks }), headers };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }), headers };
  }
};
