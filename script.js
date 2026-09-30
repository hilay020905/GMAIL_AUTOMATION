/* Outreach — frontend logic (vanilla JS, no build step) */

const LS = {
  webAppUrl: 'ro_webapp_url',
  lastTab: 'ro_last_tab',
  queue: 'ro_email_queue',
  templateSubject: 'ro_template_subject_draft',
  templateBody: 'ro_template_body_draft',
  sendDelay: 'ro_send_delay',
  selectedResume: 'ro_selected_resume',
  selectedTemplate: 'ro_selected_template',
  templateSyncedAt: 'ro_template_synced_at',
  followupEnabled: 'ro_followup_enabled',
  followupDays: 'ro_followup_days',
  followupTemplate: 'ro_followup_template',
};

const state = {
  resumes: [],
  templates: [],
  followUps: [],
  sending: false,
  stopRequested: false,
};

// ---------- Backend communication ----------
function getWebAppUrl() {
  return localStorage.getItem(LS.webAppUrl) || '';
}

async function callBackend(action, payload = {}) {
  const url = getWebAppUrl();
  if (!url) {
    toast('Set your Apps Script Web App URL in Settings first.');
    throw new Error('No web app URL configured');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight Apps Script can't answer
    body: JSON.stringify({ action, ...payload }),
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error('Backend returned an unreadable response. Check the Web App URL and deployment access.');
  }
  if (!json.success) throw new Error(json.error || 'Unknown backend error');
  return json.data;
}

async function testConnection() {
  setConnStatus('pending', 'Connecting…');
  try {
    await callBackend('getState');
    setConnStatus('online', 'Connected');
    return true;
  } catch (e) {
    setConnStatus('offline', 'Not connected');
    return false;
  }
}

function setConnStatus(kind, label) {
  const el = document.getElementById('connStatus');
  el.className = 'conn-status ' + kind;
  el.querySelector('.conn-label').textContent = label;
}

// ---------- Utility ----------
function toast(msg, ms = 3800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The template body is now a rich-text (contenteditable) editor so Gmail can
// render bold/italic/underline/colour/font. Gmail's sendEmail wants both an
// HTML body and a plain-text fallback, so this strips tags down to text.
function htmlToPlainText(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return (div.textContent || div.innerText || '').trim();
}

function parseQueue(text) {
  return [...new Set(
    (text || '')
      .split(/[\n,;]+/)
      .map(s => s.trim())
      .filter(Boolean)
  )];
}

// ---------- Navigation (remembers last tab) ----------
function switchView(viewName) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewName));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + viewName));
  localStorage.setItem(LS.lastTab, viewName);
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ---------- Emails / queue ----------
const queueEl = document.getElementById('emailQueue');
const queueCountEl = document.getElementById('queueCount');

function updateQueueCount() {
  const list = parseQueue(queueEl.value);
  queueCountEl.textContent = `${list.length} queued`;
}

queueEl.addEventListener('input', () => {
  localStorage.setItem(LS.queue, queueEl.value);
  updateQueueCount();
});

document.getElementById('clearQueueBtn').addEventListener('click', () => {
  queueEl.value = '';
  localStorage.setItem(LS.queue, '');
  updateQueueCount();
});

const sendDelayInput = document.getElementById('sendDelay');
sendDelayInput.addEventListener('input', () => {
  localStorage.setItem(LS.sendDelay, sendDelayInput.value);
});
document.getElementById('delayMinus').addEventListener('click', () => {
  sendDelayInput.value = Math.max(1, (Number(sendDelayInput.value) || 4) - 1);
  localStorage.setItem(LS.sendDelay, sendDelayInput.value);
});
document.getElementById('delayPlus').addEventListener('click', () => {
  sendDelayInput.value = Math.min(120, (Number(sendDelayInput.value) || 4) + 1);
  localStorage.setItem(LS.sendDelay, sendDelayInput.value);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Resume selection (shared between Emails send + test send) ----------
function getSelectedResumeId() {
  const sel = document.getElementById('sendResumeSelect');
  return sel.value || '';
}

function populateResumeSelects() {
  const selects = [document.getElementById('sendResumeSelect'), document.getElementById('testResumeSelect')];
  const savedId = localStorage.getItem(LS.selectedResume);
  selects.forEach(sel => {
    if (!state.resumes.length) {
      sel.innerHTML = '<option value="">No resume uploaded</option>';
      return;
    }
    sel.innerHTML = state.resumes.map(r =>
      `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}${r.isDefault ? ' (default)' : ''}</option>`
    ).join('');
    const wanted = savedId && state.resumes.some(r => r.id === savedId)
      ? savedId
      : (state.resumes.find(r => r.isDefault) || state.resumes[0]).id;
    sel.value = wanted;
  });
}

['sendResumeSelect', 'testResumeSelect'].forEach(id => {
  document.getElementById(id).addEventListener('change', (e) => {
    localStorage.setItem(LS.selectedResume, e.target.value);
    // keep both pickers in sync so "which resume" is one shared choice
    ['sendResumeSelect', 'testResumeSelect'].forEach(otherId => {
      document.getElementById(otherId).value = e.target.value;
    });
  });
});

// ---------- Template version selection (shared between Emails send + test send) ----------
function getSelectedTemplateId() {
  const sel = document.getElementById('sendTemplateSelect');
  return sel.value || '';
}

function getSelectedTemplateContent() {
  // Falls back to whatever is currently in the Template tab editor when no
  // saved version is picked, so the app still works with just a single draft.
  // htmlBody carries formatting (bold/italic/colour/font); body is the
  // plain-text fallback Gmail uses for clients that can't render HTML.
  const id = getSelectedTemplateId();
  const match = state.templates.find(t => t.id === id);
  const htmlBody = match ? match.body : bodyEl.innerHTML;
  const subject = match ? match.subject : subjectEl.value.trim();
  return { subject, htmlBody, body: htmlToPlainText(htmlBody) };
}

function populateTemplateSelects() {
  const selects = [document.getElementById('sendTemplateSelect'), document.getElementById('testTemplateSelect')];
  const savedId = localStorage.getItem(LS.selectedTemplate);
  selects.forEach(sel => {
    if (!state.templates.length) {
      sel.innerHTML = '<option value="">Use current draft</option>';
      return;
    }
    sel.innerHTML = '<option value="">Use current draft</option>' + state.templates.map(t =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`
    ).join('');
    sel.value = savedId && state.templates.some(t => t.id === savedId) ? savedId : '';
  });
}

['sendTemplateSelect', 'testTemplateSelect'].forEach(id => {
  document.getElementById(id).addEventListener('change', (e) => {
    localStorage.setItem(LS.selectedTemplate, e.target.value);
    ['sendTemplateSelect', 'testTemplateSelect'].forEach(otherId => {
      document.getElementById(otherId).value = e.target.value;
    });
  });
});

// ---------- Follow-up scheduling (Emails tab) ----------
// A follow-up must use a saved, named template version — not "current draft" —
// since it's sent days later, possibly after the live editor has moved on.
const followupToggle = document.getElementById('followupToggle');
const followupDaysInput = document.getElementById('followupDays');
const followupTemplateSelect = document.getElementById('followupTemplateSelect');
const followupConfigBox = document.querySelector('.followup-config');

function populateFollowupTemplateSelect() {
  const savedId = localStorage.getItem(LS.followupTemplate);
  if (!state.templates.length) {
    followupTemplateSelect.innerHTML = '<option value="">Save a template version first</option>';
    followupToggle.checked = false;
    followupToggle.disabled = true;
  } else {
    followupTemplateSelect.innerHTML = state.templates.map(t =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`
    ).join('');
    followupTemplateSelect.value = savedId && state.templates.some(t => t.id === savedId) ? savedId : state.templates[0].id;
    followupToggle.disabled = false;
  }
  applyFollowupEnabledState();
}

function applyFollowupEnabledState() {
  const on = followupToggle.checked && !followupToggle.disabled;
  followupDaysInput.disabled = !on;
  followupTemplateSelect.disabled = !on || !state.templates.length;
  followupConfigBox.classList.toggle('disabled-look', !on);
}

followupToggle.addEventListener('change', () => {
  if (followupToggle.checked && !state.templates.length) {
    followupToggle.checked = false;
    toast('Save a template version first (Template tab) to use for follow-ups.');
    return;
  }
  localStorage.setItem(LS.followupEnabled, followupToggle.checked ? '1' : '');
  applyFollowupEnabledState();
});
followupTemplateSelect.addEventListener('change', () => {
  localStorage.setItem(LS.followupTemplate, followupTemplateSelect.value);
});
followupDaysInput.addEventListener('input', () => {
  localStorage.setItem(LS.followupDays, followupDaysInput.value);
});
document.getElementById('followupDaysMinus').addEventListener('click', () => {
  followupDaysInput.value = Math.max(1, (Number(followupDaysInput.value) || 3) - 1);
  localStorage.setItem(LS.followupDays, followupDaysInput.value);
});
document.getElementById('followupDaysPlus').addEventListener('click', () => {
  followupDaysInput.value = Math.min(14, (Number(followupDaysInput.value) || 3) + 1);
  localStorage.setItem(LS.followupDays, followupDaysInput.value);
});

async function sendAll() {
  if (state.sending) return;
  const { subject, body, htmlBody } = getSelectedTemplateContent();
  if (!subject || !body) {
    toast('Add a subject and body in the Template tab first.');
    switchView('template');
    return;
  }

  let list = parseQueue(queueEl.value);
  const invalid = list.filter(e => !EMAIL_RE.test(e));
  list = list.filter(e => EMAIL_RE.test(e));
  if (invalid.length) toast(`Skipping ${invalid.length} invalid address(es).`);
  if (!list.length) { toast('No valid email addresses in the list.'); return; }

  state.sending = true;
  state.stopRequested = false;
  document.getElementById('sendAllBtn').disabled = true;
  const progressBox = document.getElementById('sendProgress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  progressBox.classList.remove('hidden');

  const delaySec = Math.max(1, Number(document.getElementById('sendDelay').value) || 4);
  const failed = [];
  let sent = 0;
  const total = list.length;

  const followupWanted = followupToggle.checked && !followupToggle.disabled && state.templates.length > 0;
  const followupTemplate = followupWanted ? state.templates.find(t => t.id === followupTemplateSelect.value) : null;
  const followupDelayDays = Math.max(1, Number(followupDaysInput.value) || 3);
  let followupsScheduled = 0;

  for (let i = 0; i < list.length; i++) {
    if (state.stopRequested) break;
    const email = list[i];
    progressText.textContent = `Sending ${sent + failed.length + 1} / ${total} — ${email}`;
    try {
      const result = await callBackend('sendOneEmail', { to: email, subject, body, htmlBody, resumeId: getSelectedResumeId() });
      if (result.status === 'SENT') {
        sent++;
        removeFromQueue(email);
        if (followupTemplate) {
          try {
            const fu = await callBackend('scheduleFollowUp', {
              email,
              subject: followupTemplate.subject,
              htmlBody: followupTemplate.body,
              body: htmlToPlainText(followupTemplate.body),
              resumeId: getSelectedResumeId(),
              delayDays: followupDelayDays,
            });
            state.followUps.push(fu);
            followupsScheduled++;
          } catch (fuErr) {
            console.error('Follow-up scheduling failed for', email, fuErr);
          }
        }
      } else {
        failed.push({ email, error: result.error || 'Unknown error' });
      }
    } catch (e) {
      failed.push({ email, error: e.message });
    }
    progressFill.style.width = Math.round(((sent + failed.length) / total) * 100) + '%';
    if (i < list.length - 1 && !state.stopRequested) await sleep(delaySec * 1000);
  }

  progressText.textContent = state.stopRequested
    ? `Stopped — ${sent} sent, ${failed.length} failed, ${total - sent - failed.length} not attempted`
    : `Done — ${sent} sent, ${failed.length} failed`;

  renderFailed(failed);
  state.sending = false;
  document.getElementById('sendAllBtn').disabled = false;
  renderFollowUps();
  toast(`Finished: ${sent} sent${failed.length ? `, ${failed.length} failed` : ''}${followupsScheduled ? `, ${followupsScheduled} follow-up(s) scheduled` : ''}.`);
}

function removeFromQueue(email) {
  const list = parseQueue(queueEl.value).filter(e => e.toLowerCase() !== email.toLowerCase());
  queueEl.value = list.join('\n');
  localStorage.setItem(LS.queue, queueEl.value);
  updateQueueCount();
}

function renderFailed(failed) {
  const box = document.getElementById('failedBox');
  const list = document.getElementById('failedList');
  if (!failed.length) { box.classList.add('hidden'); list.innerHTML = ''; return; }
  box.classList.remove('hidden');
  list.innerHTML = failed.map(f => `<li>${escapeHtml(f.email)} — ${escapeHtml(f.error)}</li>`).join('');
}

document.getElementById('sendAllBtn').addEventListener('click', sendAll);
document.getElementById('stopSendBtn').addEventListener('click', () => { state.stopRequested = true; });

// ---------- Template ----------
const subjectEl = document.getElementById('templateSubject');
const bodyEl = document.getElementById('templateBody'); // contenteditable div, holds HTML

subjectEl.addEventListener('input', () => localStorage.setItem(LS.templateSubject, subjectEl.value));

function saveBodyDraft() { localStorage.setItem(LS.templateBody, bodyEl.innerHTML); }
bodyEl.addEventListener('input', saveBodyDraft);

// Formatting toolbar — execCommand is deprecated but still the only way to
// drive a plain contenteditable box without a rich-text library, and it's
// well supported in Chrome/Edge, which is what this personal tool targets.
document.querySelectorAll('.rte-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    bodyEl.focus();
    document.execCommand(btn.dataset.cmd, false, null);
    saveBodyDraft();
  });
});
document.getElementById('rteFont').addEventListener('change', (e) => {
  bodyEl.focus();
  document.execCommand('fontName', false, e.target.value);
  saveBodyDraft();
});
document.querySelectorAll('.rte-swatch[data-color]').forEach(btn => {
  btn.addEventListener('click', () => {
    bodyEl.focus();
    document.execCommand('foreColor', false, btn.dataset.color);
    saveBodyDraft();
  });
});
document.getElementById('rteColor').addEventListener('input', (e) => {
  bodyEl.focus();
  document.execCommand('foreColor', false, e.target.value);
  saveBodyDraft();
});

const templateSyncStatusEl = document.getElementById('templateSyncStatus');
function setSyncStatus(kind, text) {
  templateSyncStatusEl.textContent = text;
  templateSyncStatusEl.className = 'sync-status' + (kind ? ' ' + kind : '');
}

document.getElementById('saveTemplateBtn').addEventListener('click', async () => {
  setSyncStatus('', 'Saving…');
  try {
    await callBackend('saveTemplate', { subject: subjectEl.value, body: bodyEl.innerHTML });
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    localStorage.setItem(LS.templateSyncedAt, stamp);
    setSyncStatus('ok', `Saved to backend at ${stamp}`);
    toast('Template saved.');
  } catch (e) {
    setSyncStatus('err', 'Save failed — see toast for details');
    toast('Error: ' + e.message);
  }
});

// ---------- Template versions ----------
function renderTemplateVersions() {
  const box = document.getElementById('templateVersionList');
  if (!state.templates.length) {
    box.innerHTML = '<p class="muted">No saved versions yet.</p>';
    return;
  }
  box.innerHTML = state.templates.map(t => `
    <div class="version-card" data-id="${escapeHtml(t.id)}">
      <span class="version-name">${escapeHtml(t.name)}</span>
      <span class="version-meta">${t.createdAt ? new Date(t.createdAt).toLocaleDateString() : ''}</span>
      <div class="version-actions">
        <button class="btn tiny load-version-btn">Load</button>
        <button class="btn tiny danger delete-version-btn">Delete</button>
      </div>
    </div>
  `).join('');

  box.querySelectorAll('.load-version-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.version-card').dataset.id;
      const match = state.templates.find(t => t.id === id);
      if (!match) return;
      subjectEl.value = match.subject;
      bodyEl.innerHTML = match.body;
      localStorage.setItem(LS.templateSubject, match.subject);
      localStorage.setItem(LS.templateBody, match.body);
      toast(`Loaded "${match.name}" into the editor.`);
    });
  });
  box.querySelectorAll('.delete-version-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.version-card').dataset.id;
      try {
        await callBackend('deleteTemplateVersion', { id });
        state.templates = state.templates.filter(t => t.id !== id);
        renderTemplateVersions();
        populateTemplateSelects();
        toast('Version deleted.');
      } catch (err) { toast('Error: ' + err.message); }
    });
  });
}

document.getElementById('saveTemplateVersionBtn').addEventListener('click', async () => {
  const nameInput = document.getElementById('newTemplateName');
  const name = nameInput.value.trim();
  if (!name) return toast('Give this version a name first.');
  if (!subjectEl.value.trim() || !htmlToPlainText(bodyEl.innerHTML)) return toast('Write a subject and body above before saving a version.');
  try {
    const result = await callBackend('saveTemplateVersion', { name, subject: subjectEl.value, body: bodyEl.innerHTML });
    state.templates.push(result);
    renderTemplateVersions();
    populateTemplateSelects();
    nameInput.value = '';
    toast(`Saved version "${name}".`);
  } catch (e) { toast('Error: ' + e.message); }
});

// ---------- Resume ----------
// ---------- Follow-ups (own tab) ----------
function formatDueAt(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso || '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderFollowUps() {
  const box = document.getElementById('followupList');
  const countEl = document.getElementById('followupCount');
  const pendingCount = state.followUps.filter(f => f.status === 'PENDING').length;
  countEl.textContent = `${pendingCount} pending`;

  if (!state.followUps.length) {
    box.innerHTML = '<p class="muted">No follow-ups scheduled yet — turn one on from the Emails tab before sending.</p>';
    return;
  }

  box.innerHTML = state.followUps.map(f => `
    <div class="followup-card" data-id="${escapeHtml(f.id)}">
      <div class="followup-info">
        <span class="followup-email">${escapeHtml(f.email)}</span>
        <span class="followup-subject">${escapeHtml(f.subject)}</span>
        <span class="followup-due">${f.status === 'PENDING' ? 'Due' : f.status === 'SENT' ? 'Sent' : 'Was due'} ${escapeHtml(formatDueAt(f.status === 'SENT' && f.sentAt ? f.sentAt : f.dueAt))}</span>
      </div>
      <span class="status-pill ${escapeHtml(f.status)}">${escapeHtml(f.status)}</span>
      ${f.status === 'PENDING' ? '<button class="btn tiny danger cancel-followup-btn">Cancel</button>' : ''}
    </div>
  `).join('');

  box.querySelectorAll('.cancel-followup-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.followup-card').dataset.id;
      try {
        await callBackend('cancelFollowUp', { id });
        const match = state.followUps.find(f => f.id === id);
        if (match) match.status = 'CANCELLED';
        renderFollowUps();
        toast('Follow-up cancelled.');
      } catch (err) { toast('Error: ' + err.message); }
    });
  });
}

document.getElementById('checkFollowupsBtn').addEventListener('click', async () => {
  toast('Checking for due follow-ups…');
  try {
    await callBackend('runFollowUpsNow');
    const fresh = await callBackend('listFollowUps');
    state.followUps = fresh || [];
    renderFollowUps();
    toast('Follow-ups checked and updated.');
  } catch (e) { toast('Error: ' + e.message); }
});

function renderResumes() {
  const box = document.getElementById('resumeList');
  if (!state.resumes.length) {
    box.innerHTML = '<p class="muted">No resumes uploaded yet.</p>';
    return;
  }
  box.innerHTML = state.resumes.map(r => {
    const thumbUrl = r.driveFileId ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(r.driveFileId)}&sz=w200` : '';
    return `
    <div class="resume-card ${r.isDefault ? 'is-default' : ''}" data-id="${escapeHtml(r.id)}">
      <div class="resume-thumb">
        ${thumbUrl
          ? `<img src="${escapeHtml(thumbUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'resume-thumb-fallback',textContent:'${escapeHtml((r.name || 'file').split('.').pop().toUpperCase())}'}))" />`
          : `<span class="resume-thumb-fallback">FILE</span>`}
      </div>
      <div class="resume-info">
        <span class="resume-name">${escapeHtml(r.name)}</span>
        <span class="resume-meta">${r.uploadedAt ? new Date(r.uploadedAt).toLocaleDateString() : ''}</span>
      </div>
      ${r.isDefault ? '<span class="default-tag">Default</span>' : ''}
      <div class="resume-actions">
        ${r.url ? `<a class="btn tiny" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">View</a>` : ''}
        ${!r.isDefault ? `<button class="btn tiny set-default-btn">Set default</button>` : ''}
        <button class="btn tiny danger delete-resume-btn">Delete</button>
      </div>
    </div>
  `;
  }).join('');

  box.querySelectorAll('.set-default-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.resume-card').dataset.id;
      try {
        await callBackend('setDefaultResume', { id });
        state.resumes.forEach(r => r.isDefault = (r.id === id));
        renderResumes();
        populateResumeSelects();
        toast('Default resume updated.');
      } catch (err) { toast('Error: ' + err.message); }
    });
  });
  box.querySelectorAll('.delete-resume-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.resume-card').dataset.id;
      try {
        await callBackend('deleteResume', { id });
        state.resumes = state.resumes.filter(r => r.id !== id);
        if (state.resumes.length && !state.resumes.some(r => r.isDefault)) state.resumes[0].isDefault = true;
        renderResumes();
        populateResumeSelects();
        toast('Resume deleted.');
      } catch (err) { toast('Error: ' + err.message); }
    });
  });
}

document.getElementById('uploadResumeBtn').addEventListener('click', () => {
  document.getElementById('resumeFileInput').click();
});

document.getElementById('resumeFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('File too large (max 10MB).'); return; }
  try {
    const base64 = await fileToBase64(file);
    toast('Uploading resume…');
    const result = await callBackend('uploadResume', {
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: base64,
    });
    state.resumes.forEach(r => r.isDefault = false);
    state.resumes.push(result);
    renderResumes();
    populateResumeSelects();
    toast(`Uploaded ${file.name}${result.isDefault ? ' — set as default.' : '.'}`);
  } catch (err) {
    toast('Error: ' + err.message);
  }
  e.target.value = '';
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

// ---------- Settings ----------
document.getElementById('saveUrlBtn').addEventListener('click', async () => {
  const url = document.getElementById('webAppUrl').value.trim();
  if (!url) return toast('Enter a Web App URL.');
  localStorage.setItem(LS.webAppUrl, url);
  const ok = await testConnection();
  if (ok) await loadState();
});

document.getElementById('sendTestEmailBtn').addEventListener('click', async () => {
  const to = document.getElementById('testEmailAddress').value.trim();
  if (!to) return toast('Enter a test recipient email.');
  const testTemplateId = document.getElementById('testTemplateSelect').value;
  const match = state.templates.find(t => t.id === testTemplateId);
  const htmlBody = match ? match.body : bodyEl.innerHTML;
  const subject = (match ? match.subject : subjectEl.value.trim()) || undefined;
  const body = htmlToPlainText(htmlBody) || undefined;
  try {
    const result = await callBackend('sendTestEmail', {
      to,
      subject,
      body,
      htmlBody: htmlToPlainText(htmlBody) ? htmlBody : undefined,
      resumeId: document.getElementById('testResumeSelect').value || undefined,
    });
    toast('Test email sent to ' + to + (result.attachedResume ? ' (resume attached).' : ' (no default resume set).'));
    await callBackend('saveTestEmail', { testEmail: to });
  } catch (e) { toast('Error: ' + e.message); }
});

// ---------- Boot ----------
async function loadState() {
  try {
    const s = await callBackend('getState');
    document.getElementById('connectedGmail').textContent = s.connectedGmail || '—';
    document.getElementById('brandEmail').textContent = s.connectedGmail || 'Not connected';
    if (s.testEmail) document.getElementById('testEmailAddress').value = s.testEmail;

    // Server template wins only if there's no local unsaved draft.
    if (!localStorage.getItem(LS.templateSubject) && s.template.subject) subjectEl.value = s.template.subject;
    if (!localStorage.getItem(LS.templateBody) && s.template.body) bodyEl.innerHTML = s.template.body;

    state.resumes = s.resumes || [];
    state.templates = s.templates || [];
    state.followUps = s.followUps || [];
    renderResumes();
    populateResumeSelects();
    renderTemplateVersions();
    populateTemplateSelects();
    populateFollowupTemplateSelect();
    renderFollowUps();

    if (!localStorage.getItem(LS.templateSyncedAt) && (s.template.subject || s.template.body)) {
      setSyncStatus('ok', 'Synced from backend');
    }
  } catch (e) { /* not connected yet */ }
}

(function restoreDrafts() {
  const savedQueue = localStorage.getItem(LS.queue);
  if (savedQueue) queueEl.value = savedQueue;
  updateQueueCount();

  const savedSubject = localStorage.getItem(LS.templateSubject);
  const savedBody = localStorage.getItem(LS.templateBody);
  if (savedSubject) subjectEl.value = savedSubject;
  if (savedBody) bodyEl.innerHTML = savedBody;

  const savedDelay = localStorage.getItem(LS.sendDelay);
  if (savedDelay) document.getElementById('sendDelay').value = savedDelay;

  const savedFollowupDays = localStorage.getItem(LS.followupDays);
  if (savedFollowupDays) followupDaysInput.value = savedFollowupDays;
  followupToggle.checked = localStorage.getItem(LS.followupEnabled) === '1';
  applyFollowupEnabledState();

  const lastTab = localStorage.getItem(LS.lastTab) || 'emails';
  switchView(lastTab);

  const syncedAt = localStorage.getItem(LS.templateSyncedAt);
  if (syncedAt) setSyncStatus('ok', `Saved to backend at ${syncedAt}`);
})();

(async function init() {
  const url = getWebAppUrl();
  if (url) {
    document.getElementById('webAppUrl').value = url;
    const ok = await testConnection();
    if (ok) await loadState();
  } else {
    setConnStatus('offline', 'Not connected');
  }
})();
