// Tells Sarvam to start processing a job after the client has finished uploading the
// audio file directly to the presigned URL from sarvam-create-job.
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
    const status = await job.start();
    return { statusCode: 200, body: JSON.stringify({ state: status.job_state }), headers };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || String(error) }), headers };
  }
};
