// Once a job is Completed, fetches the transcript output and turns Sarvam's diarized
// segments into a readable "Speaker N: ..." transcript for the note-generation step.
const { SarvamAIClient } = require('sarvamai');

function formatDiarizedTranscript(entries) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const lines = [];
  let current = null;
  for (const entry of entries) {
    const speakerLabel = 'Speaker ' + (parseInt(entry.speaker_id, 10) + 1 || entry.speaker_id);
    if (current && current.speaker === speakerLabel) {
      current.text += ' ' + entry.transcript;
    } else {
      if (current) lines.push(current);
      current = { speaker: speakerLabel, text: entry.transcript };
    }
  }
  if (current) lines.push(current);
  return lines.map((l) => `${l.speaker}: ${l.text.trim()}`).join('\n');
}

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

    const mappings = await job.getOutputMappings();
    if (!mappings.length) {
      const status = await job.getStatus();
      throw new Error(status.error_message || 'No successful output files for this job yet');
    }

    const outputFiles = mappings.map((m) => m.output_file);
    const downloadLinks = await client.speechToTextJob.getDownloadLinks({
      job_id: jobId,
      files: outputFiles,
    });

    // Single audio file per meeting, so there's exactly one mapping/output in practice.
    const outputFile = outputFiles[0];
    const fileInfo = downloadLinks.download_urls && downloadLinks.download_urls[outputFile];
    if (!fileInfo || !fileInfo.file_url) {
      throw new Error('Sarvam did not return a download URL for the transcript output');
    }

    const resp = await fetch(fileInfo.file_url);
    if (!resp.ok) throw new Error(`Failed to download transcript output: ${resp.status}`);
    const data = await resp.json();

    const entries = (data.diarized_transcript && data.diarized_transcript.entries) || [];
    const transcript = entries.length ? formatDiarizedTranscript(entries) : (data.transcript || '');

    return {
      statusCode: 200,
      body: JSON.stringify({
        transcript,
        rawTranscript: data.transcript || '',
        diarizedEntries: entries,
        languageCode: data.language_code || null,
      }),
      headers,
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || String(error) }), headers };
  }
};
