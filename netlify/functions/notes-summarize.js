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

  const { transcript, title } = JSON.parse(event.body);
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
        max_tokens: 1500,
        system: 'You turn raw meeting transcripts into clean, useful notes for a creative agency. Always reply with ONLY valid JSON, no markdown fences, no commentary, matching this exact shape: {"summary": "2-4 sentence plain-language summary of what the meeting was about and what was decided", "keyPoints": ["short bullet point", "..."], "actionItems": [{"task": "clear, specific action to take", "assignee": "person\'s first name if mentioned in the transcript, else empty string"}]}. Keep keyPoints to at most 8 items and actionItems to whatever is genuinely actionable (can be empty array if none). If the transcript is too short or unclear to summarize meaningfully, still return valid JSON with your best-effort interpretation.',
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
      parsed = { summary: raw, keyPoints: [], actionItems: [] };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        summary: parsed.summary || '',
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : []
      }),
      headers
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }), headers };
  }
};
