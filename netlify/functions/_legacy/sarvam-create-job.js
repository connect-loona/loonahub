// Creates a Sarvam batch Speech-to-Text job and returns a presigned upload URL for the
// single meeting-audio file. The client uploads directly to that URL (bypassing this
// function's payload limits entirely — Netlify Functions on the free tier can't carry a
// 30+ minute recording through their own body), then calls sarvam-start-job.
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

  const fileExt = (body.fileExt || 'webm').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webm';
  const numSpeakers = Number.isInteger(body.numSpeakers) && body.numSpeakers > 0 ? body.numSpeakers : undefined;
  const fileName = `meeting-audio.${fileExt}`;

  try {
    const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });

    const job = await client.speechToTextJob.createJob({
      model: 'saaras:v3',
      mode: 'transcribe',
      withDiarization: true,
      withTimestamps: true,
      numSpeakers,
    });

    const uploadLinks = await client.speechToTextJob.getUploadLinks({
      job_id: job.jobId,
      files: [fileName],
    });

    const fileInfo = uploadLinks.upload_urls && uploadLinks.upload_urls[fileName];
    if (!fileInfo || !fileInfo.file_url) {
      throw new Error('Sarvam did not return an upload URL for the audio file');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ jobId: job.jobId, uploadUrl: fileInfo.file_url, fileName }),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || String(error) }), headers };
  }
};
