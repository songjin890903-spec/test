/* ================================================================
   生成提示词工具 JS 逻辑
   直接由 admin.html 引用，无需登录验证
   ================================================================ */

// ========== 工具函数 ==========
function getConfig() {
  const modelSel = document.getElementById('model').value;
  const modelCustom = document.getElementById('modelCustom').value.trim();
  const model = modelSel === '_custom' ? (modelCustom || undefined) : modelSel;
  return {
    apiKey: document.getElementById('apiKey').value.trim(),
    apiType: document.getElementById('apiType').value,
    model: model,
    apiUrl: document.getElementById('apiUrl').value.trim() || undefined
  };
}
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function showStatus(containerId, type, msg) {
  document.getElementById(containerId).innerHTML = '<div class="status status-' + type + '">' + escapeHtml(msg) + '</div>';
}
function clearStatus(containerId) { document.getElementById(containerId).innerHTML = ''; }
function setStepState(stepId, state) {
  const el = document.getElementById(stepId);
  el.classList.remove('active', 'completed');
  if (state) el.classList.add(state);
}

// ========== 模式切换 ==========
function switchMode(mode) {
  currentMode = mode;
  document.getElementById('modeAgentA').classList.toggle('active', mode === 'agentA');
  document.getElementById('modeDirect').classList.toggle('active', mode === 'direct');
  document.getElementById('agentAFlow').classList.toggle('hidden', mode !== 'agentA');
  document.getElementById('directFlow').classList.toggle('hidden', mode !== 'direct');
}
function onApiTypeChange() {
  const apiType = document.getElementById('apiType').value;
  document.getElementById('modelGroupClaude').style.display = apiType === 'anthropic' ? '' : 'none';
  document.getElementById('modelGroupOai').style.display = apiType === 'openai' ? '' : 'none';
  document.getElementById('modelGroupGemini').style.display = apiType === 'gemini' ? '' : 'none';
  document.getElementById('modelGroupMiniMax').style.display = apiType === 'minimax' ? '' : 'none';
  const defaultModel = { anthropic: 'claude-sonnet-4-6', openai: 'deepseek-chat', gemini: 'gemini-2.5-pro', minimax: 'MiniMax-M2' }[apiType];
  document.getElementById('model').value = defaultModel;
  document.getElementById('modelCustom').classList.add('hidden');
  const placeholders = {
    anthropic: '留空=https://api.anthropic.com / 或填中转站',
    openai: '例如 https://api.deepseek.com/v1/chat/completions',
    gemini: '留空=https://generativelanguage.googleapis.com / 或填中转站',
    minimax: '留空=https://api.minimax.chat/v1'
  };
  document.getElementById('apiUrl').placeholder = placeholders[apiType];
}
function onModelChange() {
  const sel = document.getElementById('model');
  const customInput = document.getElementById('modelCustom');
  if (sel.value === '_custom') { customInput.classList.remove('hidden'); customInput.focus(); }
  else { customInput.classList.add('hidden'); customInput.value = ''; }
}

// ========== Agent A 流程 ==========
async function handleAgentAUpload(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('agentAFileName').textContent = '已选择：' + file.name;
  document.getElementById('agentAFileName').classList.remove('hidden');
  showStatus('agentAUploadStatus', 'info', '正在解析文件...');
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch('/api/agent-a/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    agentAState.scriptText = data.scriptText;
    showStatus('agentAUploadStatus', 'success', '解析成功：' + data.charCount + ' 字，' + data.sceneCount + ' 个场景');
    document.getElementById('analysisModeWrap').classList.remove('hidden');
    updateStep1Button();
  } catch (err) { showStatus('agentAUploadStatus', 'error', err.message); }
  input.value = '';
}

function setAnalysisMode(mode) {
  agentAState.analysisMode = mode;
  const aiBtn = document.getElementById('modeAI');
  const dirBtn = document.getElementById('modeDirector');
  if (mode === 'ai') {
    aiBtn.style.background = '#2d5af0'; aiBtn.style.color = '#fff';
    dirBtn.style.background = 'transparent'; dirBtn.style.color = '#888';
    document.getElementById('analysisModeHint').textContent = 'AI 将用剧作方法论自动分析剧本，生成批注';
    document.getElementById('directorNotesWrap').classList.add('hidden');
    document.getElementById('stepMapping').classList.add('hidden');
    document.getElementById('arrowAfterMapping').classList.add('hidden');
    document.getElementById('stepSoulCard').classList.remove('hidden');
    document.getElementById('arrowAfterSoulCard').classList.remove('hidden');
    document.getElementById('stepSoulCard').textContent = '② 剧魂定位卡';
    document.getElementById('stepAnnotate').textContent = '③ 逐场景批注';
    document.getElementById('stepGenerate').textContent = '④ 提示词生成';
  } else {
    dirBtn.style.background = '#f59e0b'; dirBtn.style.color = '#fff';
    aiBtn.style.background = 'transparent'; aiBtn.style.color = '#888';
    document.getElementById('analysisModeHint').textContent = '将导演录音转文字映射到剧本对应位置，保留导演原话';
    document.getElementById('directorNotesWrap').classList.remove('hidden');
    document.getElementById('stepMapping').classList.remove('hidden');
    document.getElementById('arrowAfterMapping').classList.remove('hidden');
    document.getElementById('stepSoulCard').classList.add('hidden');
    document.getElementById('arrowAfterSoulCard').classList.add('hidden');
    document.getElementById('stepAnnotate').textContent = '③ 逐场景批注';
    document.getElementById('stepGenerate').textContent = '④ 提示词生成';
  }
  updateStep1Button();
}

function updateStep1Button() {
  const btn = document.getElementById('btnStep1Next');
  const hasScript = !!agentAState.scriptText;
  if (agentAState.analysisMode === 'director') {
    btn.textContent = '开始映射分析';
    btn.disabled = !(hasScript && document.getElementById('directorNotesInput').value.trim());
  } else {
    btn.textContent = '生成剧魂定位卡';
    btn.disabled = !hasScript;
  }
}

async function handleDirectorFileUpload(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('directorFileName').textContent = '已选择：' + file.name;
  document.getElementById('directorFileName').classList.remove('hidden');
  try {
    document.getElementById('directorNotesInput').value = await file.text();
    showStatus('directorNotesStatus', 'success', '已加载');
    updateStep1Button();
  } catch (err) { showStatus('directorNotesStatus', 'error', err.message); }
  input.value = '';
}

function handleStep1Next() {
  if (agentAState.analysisMode === 'director') startDirectorAnnotate();
  else generateSoulCard();
}

async function generateSoulCard() {
  const config = getConfig();
  if (!config.apiKey) return showStatus('agentAUploadStatus', 'error', '请先填写 API Key');
  if (!agentAState.scriptText) return showStatus('agentAUploadStatus', 'error', '请先上传剧本');
  const btn = document.getElementById('btnStep1Next');
  btn.disabled = true; btn.textContent = '生成中...';
  document.getElementById('agentA_soulCard').classList.remove('hidden');
  showStatus('soulCardStatus', 'loading', '正在调用 AI 生成剧魂定位卡（可能需要1-2分钟）...');
  setStepState('stepUpload', 'completed');
  setStepState('stepSoulCard', 'active');
  try {
    const res = await fetch('/api/agent-a/soul-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: agentAState.scriptText, config })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    agentAState.soulCard = data.soulCard;
    const contentEl = document.getElementById('soulCardContent');
    contentEl.textContent = data.soulCard;
    contentEl.style.display = 'block';
    document.getElementById('soulCardEditHint').classList.remove('hidden');
    document.getElementById('soulCardActions').classList.remove('hidden');
    showStatus('soulCardStatus', 'success', '剧魂定位卡生成完成，请审阅后确认');
  } catch (err) { showStatus('soulCardStatus', 'error', err.message); }
  btn.disabled = false; btn.textContent = '生成剧魂定位卡';
}

async function startDirectorAnnotate() {
  const config = getConfig();
  if (!config.apiKey) return showStatus('agentAUploadStatus', 'error', '请先填写 API Key');
  const notesText = document.getElementById('directorNotesInput').value.trim();
  if (!notesText) return showStatus('directorNotesStatus', 'error', '请输入导演讲戏文本');
  agentAState.directorNotes = notesText;
  const btn = document.getElementById('btnStep1Next');
  btn.disabled = true; btn.textContent = '映射分析中...';
  setStepState('stepUpload', 'completed');
  setStepState('stepMapping', 'active');
  document.getElementById('agentA_mapping').classList.remove('hidden');
  showStatus('mappingStatus', 'loading', '正在分析导演讲戏文本（可能需要1-2分钟）...');
  try {
    const res = await fetch('/api/agent-a/director-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: agentAState.scriptText, directorNotes: notesText, config })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    agentAState.mappedSegments = data.segments;
    agentAState.sceneOptions = data.sceneOptions;
    renderMappingPreview(data.segments, data.summary, data.sceneOptions);
    showStatus('mappingStatus', 'success', '映射完成');
    document.getElementById('mappingActions').classList.remove('hidden');
  } catch (err) { showStatus('mappingStatus', 'error', '映射失败：' + err.message); }
  btn.disabled = false; btn.textContent = '开始映射分析';
}

function renderMappingPreview(segments, summary, sceneOptions) {
  if (summary) {
    let s = '<div class="check-bar"><span class="check-item check-ok">共 ' + segments.length + ' 段</span>';
    if (summary.mapped) s += '<span class="check-item check-ok">✓ 已映射 ' + summary.mapped + '</span>';
    if (summary.unmapped) s += '<span class="check-item check-fail">✗ 未映射 ' + summary.unmapped + '</span>';
    s += '</div>';
    document.getElementById('mappingSummary').innerHTML = s;
    document.getElementById('mappingSummary').classList.remove('hidden');
  }
  let opts = '<option value="">-- 未映射 --</option><option value="global">🌐 全局</option>';
  for (const sc of sceneOptions) opts += '<option value="' + escapeHtml(sc.id) + '">场景 ' + escapeHtml(sc.id) + '</option>';
  let html = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const conf = seg.confidence || 'medium';
    html += '<div class="map-card" style="margin-bottom:10px;padding:12px;background:#12141c;border:1px solid #2a2d38;border-radius:8px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">';
    html += '<span style="font-size:11px;color:#666;">#' + (i+1) + '</span>';
    html += '<span style="font-size:11px;padding:2px 6px;border-radius:4px;background:rgba(59,130,246,0.2);color:#93c5fd;">' + escapeHtml(seg.type || '') + '</span>';
    html += '<select data-seg-index="' + i + '" onchange="updateSegmentMapping(this)" style="padding:4px 8px;border:1px solid #2a2d38;border-radius:6px;background:#1a1d27;color:#e0e0e0;font-size:12px;">' + opts + '</select>';
    html += '</div>';
    html += '<div style="font-size:12px;color:#ccc;white-space:pre-wrap;">' + escapeHtml((seg.text||'').slice(0,200)) + '</div>';
    if (seg.reason) html += '<div style="font-size:11px;color:#666;margin-top:4px;">📎 ' + escapeHtml(seg.reason) + '</div>';
    html += '</div>';
  }
  document.getElementById('mappingList').innerHTML = html;
}

function updateSegmentMapping(sel) {
  const idx = parseInt(sel.dataset.segIndex);
  if (agentAState.mappedSegments && agentAState.mappedSegments[idx]) {
    agentAState.mappedSegments[idx].sceneId = sel.value || null;
    if (sel.value === 'global') agentAState.mappedSegments[idx].type = 'global';
  }
}

async function confirmMapping() {
  const config = getConfig();
  const valid = (agentAState.mappedSegments || []).filter(s => s.sceneId && s.sceneId !== 'null');
  if (!valid.length) return showStatus('mappingStatus', 'error', '请至少映射一段');
  setStepState('stepMapping', 'completed');
  setStepState('stepAnnotate', 'active');
  document.getElementById('agentA_annotate').classList.remove('hidden');
  showStatus('annotateStatus', 'loading', '正在提交批注任务...');
  try {
    const res = await fetch('/api/agent-a/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: agentAState.scriptText, config, mode: 'director', mappedSegments: valid })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    agentAState.annotateJobId = data.jobId;
    pollAnnotateProgress(data.jobId);
  } catch (err) { showStatus('annotateStatus', 'error', err.message); }
}

function redoMapping() {
  document.getElementById('mappingList').innerHTML = '';
  document.getElementById('mappingSummary').classList.add('hidden');
  document.getElementById('mappingActions').classList.add('hidden');
  startDirectorAnnotate();
}

function regenerateSoulCard() {
  document.getElementById('soulCardContent').style.display = 'none';
  document.getElementById('soulCardActions').classList.add('hidden');
  generateSoulCard();
}

async function confirmSoulCard() {
  agentAState.soulCard = document.getElementById('soulCardContent').textContent;
  const config = getConfig();
  setStepState('stepSoulCard', 'completed');
  setStepState('stepAnnotate', 'active');
  document.getElementById('agentA_annotate').classList.remove('hidden');
  showStatus('annotateStatus', 'loading', '正在提交批注任务...');
  try {
    const res = await fetch('/api/agent-a/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: agentAState.scriptText, soulCard: agentAState.soulCard, config })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    agentAState.annotateJobId = data.jobId;
    pollAnnotateProgress(data.jobId);
  } catch (err) { showStatus('annotateStatus', 'error', err.message); }
}

function pollAnnotateProgress(jobId) {
  const es = new EventSource('/api/agent-a/progress/' + jobId);
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.error) { showStatus('annotateStatus', 'error', d.error); es.close(); return; }
    if (d.status === 'running') {
      let html = '';
      if (d.total) html += '<div class="progress-bar"><div class="progress-fill" style="width:' + Math.round((d.completed/d.total)*100) + '%"></div></div><div class="progress-text">' + d.completed + '/' + d.total + ' 场景</div>';
      for (const p of (d.progress||[])) {
        const dot = p.status==='done'?'dot-done':p.status==='error'?'dot-error':p.status==='processing'?'dot-processing':'dot-pending';
        html += '<div class="progress-item"><span class="dot ' + dot + '"></span>' + escapeHtml(p.sceneId) + ' ' + escapeHtml(p.message||'') + renderSubSteps(p.steps) + '</div>';
      }
      document.getElementById('annotateStatus').innerHTML = html || '<div class="status status-loading">批注进行中...</div>';
    } else if (d.status === 'done') {
      showStatus('annotateStatus', 'success', '批注完成！');
      es.close(); fetchAnnotateResult(jobId);
    } else if (d.status === 'error') {
      showStatus('annotateStatus', 'error', '批注失败'); es.close();
    }
  };
  es.onerror = () => { es.close(); setTimeout(() => fetchAnnotateResult(jobId), 1000); };
}

async function fetchAnnotateResult(jobId) {
  try {
    const res = await fetch('/api/agent-a/results/' + jobId);
    const data = await res.json();
    if (data.status === 'done' && data.result) {
      agentAState.annotatedScript = data.result;
      let html = '';
      if (data.validations?.length) {
        html += '<div style="margin-bottom:10px;">';
        for (const v of data.validations) {
          if (!v) continue;
          const s = v.stats;
          html += '<div class="check-bar" style="margin-bottom:4px;">';
          html += '<span style="font-size:12px;color:#ccc;">场景' + escapeHtml(v.sceneId) + '</span>';
          html += '<span class="check-item ' + (s.dlHit===s.dlTotal?'check-ok':'check-fail') + '">' + (s.dlHit===s.dlTotal?'✓':'✗') + ' 台词</span>';
          html += '<span class="check-item ' + (s.hasFeel?'check-ok':'check-fail') + '">' + (s.hasFeel?'✓':'✗') + ' 感受</span>';
          html += '</div>';
        }
        html += '</div>';
      }
      const resultEl = document.getElementById('annotateResult');
      resultEl.innerHTML = html + '<div style="white-space:pre-wrap;word-break:break-all;">' + escapeHtml(data.result) + '</div>';
      resultEl.classList.remove('hidden');
      document.getElementById('annotateActions').classList.remove('hidden');
      showStatus('annotateStatus', 'success', '批注完成');
    }
  } catch (err) { showStatus('annotateStatus', 'error', err.message); }
}

async function downloadAnnotation() {
  if (agentAState.annotateJobId) window.open('/api/agent-a/download/' + agentAState.annotateJobId, '_blank');
}

function copyAnnotation() {
  if (agentAState.annotatedScript) navigator.clipboard.writeText(agentAState.annotatedScript).then(() => showStatus('annotateStatus', 'success', '已复制'));
}

async function proceedToGenerate() {
  if (!agentAState.annotatedScript) return;
  setStepState('stepAnnotate', 'completed');
  setStepState('stepGenerate', 'active');
  const genSection = document.getElementById('agentA_generate');
  genSection.classList.remove('hidden');
  try {
    const res = await fetch('/api/parse-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: agentAState.annotatedScript })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    agentAState.scenes = data.scenes;
    renderSceneInfo('agentA_sceneInfo', data.scenes);
  } catch (err) { document.getElementById('agentA_sceneInfo').innerHTML = '<div class="status status-error">' + escapeHtml(err.message) + '</div>'; }
  genSection.scrollIntoView({ behavior: 'smooth' });
}

async function startGenerateFromAgentA() {
  if (!agentAState.scenes?.length) return;
  const config = getConfig();
  if (!config.apiKey) return;
  const btn = document.getElementById('btnGenerateA');
  btn.disabled = true; btn.textContent = '生成中...';
  const progressEl = document.getElementById('agentA_generateProgress');
  const resultEl = document.getElementById('agentA_generateResult');
  progressEl.classList.remove('hidden');
  progressEl.innerHTML = '<div class="status status-loading">正在提交生成任务...</div>';
  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenes: agentAState.scenes, costumeCard: document.getElementById('costumeCardA').value.trim(), config })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    agentAState.generateJobId = data.jobId;
    pollGenerateProgress(data.jobId, progressEl, resultEl, btn, 'agentA');
  } catch (err) { progressEl.innerHTML = '<div class="status status-error">' + escapeHtml(err.message) + '</div>'; btn.disabled = false; btn.textContent = '开始生成提示词'; }
}

// ========== 直接模式 ==========
async function handleDirectUpload(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('directFileName').textContent = '已选择：' + file.name;
  document.getElementById('directFileName').classList.remove('hidden');
  showStatus('directUploadStatus', 'info', '正在解析文件...');
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    directState.scenes = data.scenes;
    showStatus('directUploadStatus', 'success', '解析成功：' + data.scenes.length + ' 个场景');
    document.getElementById('directScenes').classList.remove('hidden');
    renderSceneInfo('directSceneList', data.scenes);
    document.getElementById('directGenerate').classList.remove('hidden');
  } catch (err) { showStatus('directUploadStatus', 'error', err.message); }
  input.value = '';
}

async function startDirectGenerate() {
  if (!directState.scenes?.length) return;
  const config = getConfig();
  if (!config.apiKey) return showStatus('directUploadStatus', 'error', '请先填写 API Key');
  const btn = document.getElementById('btnGenerateD');
  btn.disabled = true; btn.textContent = '生成中...';
  document.getElementById('directProgress').classList.remove('hidden');
  const progressEl = document.getElementById('directProgressList');
  progressEl.innerHTML = '<div class="status status-loading">正在提交生成任务...</div>';
  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenes: directState.scenes, costumeCard: document.getElementById('costumeCardD').value.trim(), config })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    directState.jobId = data.jobId;
    pollGenerateProgress(data.jobId, progressEl, document.getElementById('directResultList'), btn, 'direct');
  } catch (err) { progressEl.innerHTML = '<div class="status status-error">' + escapeHtml(err.message) + '</div>'; btn.disabled = false; btn.textContent = '开始生成提示词'; }
}

// ========== 共享 ==========
function renderSubSteps(steps) {
  if (!steps || !steps.length) return '';
  let h = '<div class="sub-steps">';
  for (const s of steps) {
    const cls = s.done ? 'sub-step-done' : s.active ? 'sub-step-active' : 'sub-step-pending';
    const icon = s.done ? '✓' : s.active ? '●' : '○';
    h += '<span class="sub-step ' + cls + '">' + icon + ' ' + escapeHtml(s.name) + '</span>';
  }
  return h + '</div>';
}

function pollGenerateProgress(jobId, progressEl, resultEl, btn, mode) {
  const es = new EventSource('/api/progress/' + jobId);
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.error) { progressEl.innerHTML = '<div class="status status-error">⚠ ' + escapeHtml(d.error) + '</div>'; es.close(); btn.disabled = false; btn.textContent = '开始生成提示词'; return; }
    const pct = d.total ? Math.round((d.completed/d.total)*100) : 0;
    let html = '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div><div class="progress-text">' + d.completed + '/' + d.total + ' 场景完成</div>';
    for (const p of (d.progress||[])) {
      const dot = p.status==='done'?'dot-done':p.status==='error'?'dot-error':p.status==='processing'?'dot-processing':'dot-pending';
      html += '<div class="progress-item"><span class="dot ' + dot + '"></span><span style="color:' + (p.status==='error'?'#fca5a5':'#ccc') + '">' + escapeHtml(p.sceneId) + '</span><span style="color:#888;font-size:11px;margin-left:6px;">' + escapeHtml(p.message||'') + '</span>' + renderSubSteps(p.steps) + '</div>';
    }
    progressEl.innerHTML = html;
    if (d.status === 'done') { es.close(); btn.disabled = false; btn.textContent = '开始生成提示词'; fetchGenerateResults(jobId, resultEl, mode); }
  };
  es.onerror = () => { es.close(); btn.disabled = false; btn.textContent = '开始生成提示词'; setTimeout(() => fetchGenerateResults(jobId, resultEl, mode), 1000); };
}

async function fetchGenerateResults(jobId, resultEl, mode) {
  try {
    const res = await fetch('/api/results/' + jobId);
    const data = await res.json();
    if (!data.results?.length) return;
    if (mode === 'direct') document.getElementById('directResults').classList.remove('hidden');
    let html = '<div style="margin-bottom:10px;display:flex;gap:8px;">';
    html += '<button class="btn btn-primary btn-sm" onclick="copyAllClean(event)">复制全部</button>';
    html += '<button class="btn btn-outline btn-sm" onclick="downloadResults(\'clean\')">下载纯提示词</button>';
    html += '<button class="btn btn-outline btn-sm" onclick="downloadResults(\'full\')">下载完整版</button>';
    html += '</div>';
    for (const r of data.results) {
      const tag = r.sceneType==='wuxi'?'tag-wuxi':r.sceneType==='wenxi'?'tag-wenxi':'tag-mixed';
      const lbl = r.sceneType==='wuxi'?'武戏':r.sceneType==='wenxi'?'文戏':'混合';
      const segs = splitSegments(cleanPromptContent(r.content));
      html += '<details style="margin-bottom:8px;" open><summary style="cursor:pointer;font-size:13px;padding:8px;background:#12141c;border-radius:6px;">场景 ' + escapeHtml(r.sceneId) + ' <span class="scene-tag ' + tag + '">' + lbl + '</span></summary>';
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        html += '<div style="border:1px solid #2a2d38;border-radius:6px;margin:6px 0;overflow:hidden;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#1a1d27;font-size:12px;">';
        html += '<span style="color:#93b4ff;">' + escapeHtml(seg.title) + '</span>';
        html += '<button class="btn btn-outline btn-sm" onclick="copySegmentText(this)" data-text="' + btoa(encodeURIComponent(seg.text)) + '" style="padding:2px 10px;font-size:11px;">复制</button>';
        html += '</div><div class="result-box" style="border:none;border-radius:0;max-height:300px;">' + escapeHtml(seg.text) + '</div></div>';
      }
      html += '</details>';
    }
    resultEl.innerHTML = html;
    resultEl.classList.remove('hidden');
    window._generateResults = data.results;
  } catch (err) { resultEl.innerHTML = '<div class="status status-error">获取结果失败</div>'; }
}

function splitSegments(content) {
  const pos = [];
  const re = /【片段\S+】/g; let m;
  while ((m = re.exec(content)) !== null) {
    let start = m.index;
    const before = content.substring(Math.max(0, m.index - 200), m.index);
    const at = before.match(/(?:^|\n)(@[^\n]+(?:\n@[^\n]+)*)\s*$/);
    if (at) { start = m.index - at[0].length; if (content[start] === '\n') start++; }
    pos.push({ start, i: m.index });
  }
  if (!pos.length) {
    const re2 = /【\S*?片段\S*?】|【\S*?\d+-\d+[A-Z]】|片段\s+\d+-\d+[A-Z]/g;
    while ((m = re2.exec(content)) !== null) {
      if (!pos.some(p => p.i === m.index)) pos.push({ start: m.index, i: m.index });
    }
    if (!pos.length) return [{ title: '全部内容', text: content }];
  }
  const segs = [];
  for (let i = 0; i < pos.length; i++) {
    const start = pos[i].start;
    const end = i < pos.length - 1 ? pos[i+1].start : content.length;
    const text = content.substring(start, end).trim();
    const tm = text.match(/【片段(\S+)】\s*([^\n]*)/);
    segs.push({ title: tm ? '片段' + tm[1] + ' ' + tm[2] : '片段' + (i+1), text });
  }
  return segs;
}

function cleanPromptContent(c) {
  return c.replace(/<scene_plan>[\s\S]*?<\/scene_plan>/g,'').replace(/<analysis>[\s\S]*?<\/analysis>/g,'')
    .replace(/^（⚠️?[^）]*）\s*$/gm,'').replace(/^导演禁止项[^\n]*$/gm,'禁止项：')
    .replace(/【接导演意图第\d+条】\s*/g,'').replace(/（←[^）]{0,50}）/g,'').replace(/\n{3,}/g,'\n\n').trim();
}

function copySegmentText(btn) {
  navigator.clipboard.writeText(decodeURIComponent(atob(btn.dataset.text))).then(() => {
    btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1500);
  });
}

function copyAllClean(event) {
  if (!window._generateResults) return;
  let all = '';
  for (const r of window._generateResults) {
    all += '═'.repeat(50) + '\n场景 ' + r.sceneId + '  ' + r.sceneHeader + '\n' + '═'.repeat(50) + '\n\n' + cleanPromptContent(r.content) + '\n\n';
  }
  navigator.clipboard.writeText(all).then(() => {
    const b = event?.target;
    if (b) { const o = b.textContent; b.textContent = '已复制全部'; setTimeout(() => { b.textContent = o; }, 1500); }
  });
}

function downloadResults(type) {
  const jobId = currentMode === 'direct' ? directState.jobId : agentAState.generateJobId;
  if (jobId) window.open(type === 'clean' ? '/api/download-prompts/' + jobId : '/api/download/' + jobId, '_blank');
}

function renderSceneInfo(cid, scenes) {
  let h = '';
  for (const s of scenes) {
    const tag = s.sceneType==='wuxi'?'tag-wuxi':s.sceneType==='wenxi'?'tag-wenxi':'tag-mixed';
    const lbl = s.sceneType==='wuxi'?'武戏':s.sceneType==='wenxi'?'文戏':'混合';
    h += '<div class="scene-item"><span>场景 ' + escapeHtml(s.id) + '　' + escapeHtml(s.header||'') + '</span><span class="scene-tag ' + tag + '">' + lbl + '</span></div>';
  }
  document.getElementById(cid).innerHTML = h;
}

// ========== 初始化 ==========
onApiTypeChange();
document.getElementById('directorNotesInput').addEventListener('input', updateStep1Button);
