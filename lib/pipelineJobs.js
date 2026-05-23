const { runGenerateFlow: pipelineRunGenerateFlow } = require('./pipeline');

function createJobRecord(overrides = {}) {
  return {
    status: 'running',
    progress: [],
    results: null,
    events: [],
    startedAt: Date.now(),
    total: 0,
    completed: 0,
    ...overrides
  };
}

function markJobFailed({ job, jobId, label, err }) {
  job.status = 'error';
  job.error = err.message;
  job.errorStack = err.stack;
  job.finishedAt = Date.now();
  console.error(`[${label}] job ${jobId} failed:`, err.message);
  if (err.stack) console.error(err.stack);
}

function collectProcessJobEvent(job, event) {
  if (event.type === 'plan' && event.stage === 'PLANNER') {
    job.progress.push({
      sceneId: event.sceneId,
      status: 'processing',
      message: event.message || 'planning...'
    });
    job.total = (job.total || 0) + 1;
  }
  if (event.type === 'scene_done' && event.stage === 'AGENT_C') {
    const idx = job.progress.findIndex((p) => p.sceneId === event.sceneId);
    if (idx >= 0) {
      job.progress[idx].status = event.report?.ok ? 'done' : 'error';
      job.progress[idx].message = event.message || '';
    }
    job.completed = job.progress.filter((p) => p.status === 'done' || p.status === 'error').length;
  }
}

function collectStructuredJobEvent(job, event) {
  if (event.type === 'plan' && event.stage === 'PLANNER') {
    job.total = (job.total || 0) + 1;
  }
  if (event.type === 'scene_done' && event.stage === 'AGENT_C') {
    job.completed = (job.completed || 0) + 1;
    job.progress.push({
      type: event.type,
      stage: event.stage,
      message: event.message,
      sceneId: event.sceneId
    });
  }
  if (event.type === 'done') {
    job.progress.push({
      type: event.type,
      stage: event.stage,
      message: event.message,
      sceneId: event.sceneId
    });
  }
}

async function runUnifiedPipelineJob({
  jobId,
  job,
  label,
  flowInput,
  onEvent,
  mapResult,
  doneMessage = 'done'
}) {
  const result = await pipelineRunGenerateFlow({
    ...flowInput,
    onEvent: (event) => {
      job.events.push(event);
      onEvent?.(job, event);
    }
  });
  job.status = 'done';
  job.results = mapResult ? mapResult(result) : result;
  job.finishedAt = Date.now();
  console.log(`[${label}] job ${jobId} ${doneMessage}`);
  return result;
}

function buildUnifiedFlowInput({
  scriptText,
  annotatedScript,
  costumeCard,
  config,
  options = {},
  directorNotes = '',
  mappedSegments = [],
  mode
}) {
  const directorSegmentCount = Array.isArray(mappedSegments) ? mappedSegments.length : 0;
  const directorSegmentIntents = Array.isArray(mappedSegments)
    ? mappedSegments.map((s) => s.text || '').slice(0, 50)
    : [];

  return {
    scriptText,
    annotatedScript: annotatedScript || '',
    costumeCard: costumeCard || '',
    config,
    directorNotes,
    mode: mode || (String(directorNotes || '').trim() ? 'director' : 'ai'),
    options: {
      forbiddenTerms: options.forbiddenTerms || '',
      visualStyle: options.visualStyle || 'plain',
      directorSegmentCount,
      directorSegmentIntents,
      ...options
    }
  };
}

module.exports = {
  createJobRecord,
  markJobFailed,
  collectProcessJobEvent,
  collectStructuredJobEvent,
  runUnifiedPipelineJob,
  buildUnifiedFlowInput
};
