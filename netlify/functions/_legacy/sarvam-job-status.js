// A single fast status check — the client polls this every few seconds rather than any
// server-side function waiting for the whole job, which would blow past Netlify's
// free-tier 10-second synchronous function timeout for anything but a very short meeting.
const { SarvamAIClient } = require('sarvamai');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SARVAM_API_KEY not set' }), headers };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }), headers };
  }

  const jobId = body.jobId;
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'jobId is required' }), headers };
  }

  try {
    const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    const job = client.speechToTextJob.getJob(jobId);
    const status = await job.getStatus();
    return {
      statusCode: 200,
      body: JSON.stringify({
        state: status.job_state,
        errorMessage: status.error_message || null,
        successfulFiles: status.successful_files_count || 0,
        failedFiles: status.failed_files_count || 0,
      }),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || String(error) }), headers };
  }
};
