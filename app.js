// ============================================================
//  KONFIGURASJON
//  Sett inn din Google OAuth Client ID her.
//  Se oppsettguide i appen (klikk "Konfigurasjon mangler").
// ============================================================
const CONFIG = {
  clientId: '1041011201222-v3o22i3dvmbjc85gfod20m699a64jgdk.apps.googleusercontent.com',
  notionDatabaseId: '02d1059e72f0461b97df4afdf034a1ec',
  scopes: [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/cloud-platform',
  ].join(' '),
  defaultLang: 'nb-NO',
};

// ============================================================
//  Tilstand
// ============================================================
let state = {
  isRecording: false,
  accessToken: null,
  tokenExpiry: null,
  currentDocId: null,
  currentDocTitle: null,
  finalText: '',
  autoSaveTimer: null,
  wordCount: 0,
  mediaStream: null,
  mediaRecorder: null,
  audioChunks: [],
  tokenClient: null,
  pendingSave: false,
  audioContext: null,
  analyser: null,
  animationFrame: null,
  userChosenMicId: null,
  userSetTitle: false,
  titleDialogCallback: null,
};

// ============================================================
//  Initialisering
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  checkConfig();
  checkBrowserSupport();
  restoreSession();
  setDefaultDocTitle();
  updateWordCount();

  document.getElementById('transcript').addEventListener('input', () => {
    state.finalText = document.getElementById('transcript').innerText;
    updateWordCount();
    scheduleAutoSave();
  });
});

function checkConfig() {
  if (CONFIG.clientId === 'DIN_CLIENT_ID_HER') {
    document.getElementById('setup-warning').classList.remove('hidden');
  }
}

function checkBrowserSupport() {
  if (!window.MediaRecorder || !navigator.mediaDevices) {
    document.getElementById('browser-warning').classList.remove('hidden');
    document.getElementById('record-btn').disabled = true;
  }
}

function setDefaultDocTitle() {
  const input = document.getElementById('doc-title');
  if (!input.value) {
    input.value = makeDocTitle();
  }
}

function makeDocTitle() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `Diktering ${yy}-${mm}-${dd} ${hh}.${min}`;
}

function formatDate(d) {
  return d.toLocaleDateString('nb-NO', { day:'2-digit', month:'2-digit', year:'numeric' });
}

function formatDateTime(d) {
  return d.toLocaleString('nb-NO', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

// ============================================================
//  Lokal lagring / sesjon
// ============================================================
function saveSession() {
  try {
    sessionStorage.setItem('diktering_draft', state.finalText);
    // Tittel lagres ikke — genereres alltid på nytt ved oppstart
  } catch (_) {}
}

function restoreSession() {
  try {
    const draft = sessionStorage.getItem('diktering_draft');

    if (draft) {
      state.finalText = draft;
      document.getElementById('transcript').innerText = draft;
    }
    // Tittel og docId gjenopprettes ikke — genereres alltid på nytt ved oppstart
  } catch (_) {}
}

// ============================================================
//  Tale-til-tekst (Google Cloud Speech-to-Text)
// ============================================================
const SEGMENT_MS = 25000;

async function populateMicList() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const select = document.getElementById('mic-select');
    const userChosen = state.userChosenMicId;
    select.innerHTML = '';
    mics.forEach((mic, i) => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `Mikrofon ${i + 1}`;
      select.appendChild(opt);
    });
    // Prioriter brukerens valg, deretter systemstandard, deretter første i lista
    if (userChosen && [...select.options].some(o => o.value === userChosen)) {
      select.value = userChosen;
    } else if ([...select.options].some(o => o.value === 'default')) {
      select.value = 'default';
    }
    select.style.display = mics.length <= 1 ? 'none' : '';
  } catch (_) {}
}

function updateMic() {
  const select = document.getElementById('mic-select');
  state.userChosenMicId = select.value;
  const label = select.options[select.selectedIndex]?.text || '';
  if (label) toast(`Mikrofon: ${label}`);
}

function updateLang() {
  // Språkendring trer i kraft ved neste segment
}

function toggleRecording() {
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  if (!isTokenValid()) {
    toast('Logg inn med Google først.', 'error');
    handleAuth();
    return;
  }
  try {
    const micSelect = document.getElementById('mic-select');
    const deviceId = micSelect.value;
    const audioConstraints = {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    };
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    await populateMicList();
  } catch (err) {
    toast('Mikrofontilgang ble avslått.', 'error');
    return;
  }
  if (!document.getElementById('doc-title').value.trim()) {
    document.getElementById('doc-title').value = makeDocTitle();
  }
  state.isRecording = true;
  document.getElementById('record-btn').classList.add('recording');
  document.getElementById('record-label').textContent = 'Stopp';
  setStatus('recording', 'Lytter...');
  startWaveform(state.mediaStream);
  startRecordingSegment();
}

function startRecordingSegment() {
  if (!state.isRecording || !state.mediaStream) return;
  const mimeType = getSupportedMimeType();
  const recorder = new MediaRecorder(state.mediaStream, { mimeType });
  state.mediaRecorder = recorder;
  state.audioChunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) state.audioChunks.push(e.data);
  };

  recorder.onstop = async () => {
    const blob = new Blob(state.audioChunks, { type: mimeType });
    state.audioChunks = [];
    if (state.isRecording) {
      startRecordingSegment();
    }
    if (blob.size > 2000) await transcribeAudio(blob, mimeType);
    if (!state.isRecording) {
      setStatus('idle', 'Klar');
    }
  };

  recorder.start();
  setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
    }
  }, SEGMENT_MS);
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function transcribeAudio(blob, mimeType) {
  if (!isTokenValid()) return;
  document.getElementById('typing-dots').classList.remove('hidden');
  if (!state.isRecording) setStatus('saving', 'Behandler...');
  try {
    const base64 = await blobToBase64(blob);
    const encoding = mimeType.includes('ogg') ? 'OGG_OPUS' : 'WEBM_OPUS';
    const lang = document.getElementById('lang-select').value;

    const res = await fetch('https://speech.googleapis.com/v1/speech:recognize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${state.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          encoding,
          languageCode: lang,
          enableAutomaticPunctuation: true,
          model: 'latest_long',
          useEnhanced: true,
          profanityFilter: false,
          enableWordConfidence: false,
        },
        audio: { content: base64 },
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const transcript = (data.results || [])
      .map(r => r.alternatives[0].transcript)
      .join(' ')
      .trim();

    if (transcript) {
      const separator = (state.finalText && !state.finalText.endsWith('\n')) ? ' ' : '';
      state.finalText += separator + transcript;
      renderTranscript();
      updateWordCount();
      scheduleAutoSave();
    }
  } catch (err) {
    console.error('Transkriberingsfeil:', err);
    toast(`Feil: ${err.message}`, 'error');
  } finally {
    document.getElementById('typing-dots').classList.add('hidden');
    if (state.isRecording) {
      setStatus('recording', 'Lytter...');
    } else {
      setStatus('idle', 'Klar');
    }
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function stopRecording() {
  state.isRecording = false;
  document.getElementById('record-btn').classList.remove('recording');
  document.getElementById('record-label').textContent = 'Start';
  document.getElementById('typing-dots').classList.add('hidden');
  setStatus('idle', 'Klar');
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    state.mediaRecorder.stop();
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }
  stopWaveform();
}

// ============================================================
//  Lydvisualisering (waveform)
// ============================================================
function startWaveform(stream) {
  const canvas = document.getElementById('waveform-canvas');
  canvas.classList.remove('hidden');
  canvas.width = canvas.offsetWidth * window.devicePixelRatio;
  canvas.height = canvas.offsetHeight * window.devicePixelRatio;

  state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 128;
  source.connect(state.analyser);

  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const BAR_COUNT = 48;
  const GAP = 3 * window.devicePixelRatio;
  const barW = (W - GAP * (BAR_COUNT - 1)) / BAR_COUNT;
  const MIN_H = 3 * window.devicePixelRatio;

  function draw() {
    if (!state.isRecording) { stopWaveform(); return; }
    state.animationFrame = requestAnimationFrame(draw);
    state.analyser.getByteFrequencyData(dataArray);
    ctx.clearRect(0, 0, W, H);

    for (let i = 0; i < BAR_COUNT; i++) {
      const idx = Math.floor((i / BAR_COUNT) * bufferLength);
      const val = dataArray[idx] / 255;
      const barH = Math.max(MIN_H, val * H * 0.9);
      const x = i * (barW + GAP);
      const y = (H - barH) / 2;

      const alpha = 0.35 + val * 0.65;
      ctx.fillStyle = `rgba(29,233,182,${alpha})`;
      const r = Math.min(barW / 2, 4 * window.devicePixelRatio);
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, r);
      ctx.fill();
    }
  }
  draw();
}

function stopWaveform() {
  if (state.animationFrame) {
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = null;
  }
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
    state.analyser = null;
  }
  const canvas = document.getElementById('waveform-canvas');
  canvas.classList.add('hidden');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function renderTranscript() {
  const el = document.getElementById('transcript');
  // Behold markørposisjon ved manuell redigering
  el.innerText = state.finalText;
  // Flytt markøren til slutten
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ============================================================
//  UI-hjelpere
// ============================================================
function setStatus(type, text) {
  const indicator = document.getElementById('status-indicator');
  indicator.className = `status-indicator status-${type}`;
  document.getElementById('status-text').textContent = text;
}

function updateWordCount() {
  const text = state.finalText.trim();
  const count = text ? text.split(/\s+/).length : 0;
  document.getElementById('word-count').textContent = `${count} ord`;
}

function clearTranscript() {
  if (!state.finalText.trim()) return;
  if (!confirm('Slette all tekst?')) return;
  state.finalText = '';
  document.getElementById('transcript').innerText = '';
  document.getElementById('interim').textContent = '';
  state.currentDocId = null;
  sessionStorage.removeItem('diktering_docId');
  sessionStorage.removeItem('diktering_draft');
  updateWordCount();
  setStatus('idle', 'Klar');
  document.getElementById('doc-meta').textContent = '';
  document.getElementById('doc-title').value = '';
  state.userSetTitle = false;
  toast('Tekst slettet');
}

async function newDocument() {
  if (state.isRecording) stopRecording();

  if (state.finalText.trim()) {
    const choice = confirm('Lagre gjeldende dokument før du starter nytt?');
    if (choice) {
      await saveToGoogleDocs(false);
    }
  }

  state.finalText = '';
  state.currentDocId = null;
  state.currentDocTitle = null;
  document.getElementById('transcript').innerText = '';
  document.getElementById('interim').textContent = '';
  document.getElementById('doc-meta').textContent = '';
  sessionStorage.removeItem('diktering_docId');
  sessionStorage.removeItem('diktering_draft');
  updateWordCount();
  setStatus('idle', 'Klar');
  updateOpenDocButton();
  document.getElementById('notion-btn').disabled = true;
  document.getElementById('notion-status').classList.add('hidden');
  document.getElementById('open-notion-btn').classList.add('hidden');
  state.userSetTitle = false;
  document.getElementById('notion-status-text').textContent = '';

  const input = document.getElementById('doc-title');
  input.value = makeDocTitle();

  toast('Nytt dokument klart');
}

function updateOpenDocButton() {
  const btn = document.getElementById('open-doc-btn');
  if (state.currentDocId) {
    btn.href = `https://docs.google.com/document/d/${state.currentDocId}/edit`;
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

function scheduleAutoSave() {
  saveSession();
  if (state.accessToken && isTokenValid()) {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(() => {
      if (state.finalText.trim().length > 20) {
        saveToGoogleDocs(true);
      }
    }, 8000); // Auto-lagre 8 sek etter siste endring
  }
}

// ============================================================
//  Google OAuth (Google Identity Services)
// ============================================================
function handleAuth() {
  if (CONFIG.clientId === 'DIN_CLIENT_ID_HER') {
    showSetupGuide();
    return;
  }

  if (state.accessToken && isTokenValid()) {
    signOut();
    return;
  }

  if (!state.tokenClient) {
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.clientId,
      scope: CONFIG.scopes,
      callback: onTokenReceived,
    });
  }
  state.tokenClient.requestAccessToken();
}

function onTokenReceived(response) {
  if (response.error) {
    toast(`Innlogging feilet: ${response.error}`, 'error');
    return;
  }
  state.accessToken = response.access_token;
  state.tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;

  // Hent brukerinfo
  fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${state.accessToken}` }
  })
    .then(r => r.json())
    .then(info => {
      document.getElementById('user-name').textContent = info.name || info.email;
      document.getElementById('user-info').classList.remove('hidden');
      document.getElementById('auth-btn').classList.add('hidden');
      toast(`Logget inn som ${info.name || info.email}`);
      updateSaveButton();
    })
    .catch(() => {
      document.getElementById('user-info').classList.remove('hidden');
      document.getElementById('auth-btn').classList.add('hidden');
      updateSaveButton();
    });
}

function signOut() {
  if (state.accessToken) {
    google.accounts.oauth2.revoke(state.accessToken);
  }
  state.accessToken = null;
  state.tokenExpiry = null;
  state.currentDocId = null;
  sessionStorage.removeItem('diktering_docId');
  document.getElementById('user-info').classList.add('hidden');
  document.getElementById('auth-btn').classList.remove('hidden');
  toast('Logget ut');
  updateSaveButton();
}

function isTokenValid() {
  return state.accessToken && state.tokenExpiry && Date.now() < state.tokenExpiry;
}

function updateSaveButton() {
  const btn = document.getElementById('save-btn');
  if (state.accessToken && isTokenValid()) {
    btn.disabled = false;
  } else {
    btn.disabled = false; // Knappen styrer auth-flyten selv
  }
}

// ============================================================
//  Google Docs / Drive API
// ============================================================
async function saveToGoogleDocs(isAutoSave = false) {
  if (!isTokenValid()) {
    if (CONFIG.clientId === 'DIN_CLIENT_ID_HER') {
      showSetupGuide();
      return;
    }
    state.pendingSave = true;
    handleAuth();
    return;
  }

  const text = state.finalText.trim();
  if (!text) {
    if (!isAutoSave) toast('Ingenting å lagre ennå.');
    return;
  }

  const title = document.getElementById('doc-title').value.trim() || makeDocTitle();

  setStatus('saving', 'Lagrer...');
  document.getElementById('save-label').textContent = 'Lagrer...';
  document.getElementById('save-btn').disabled = true;

  try {
    if (state.currentDocId) {
      await updateGoogleDoc(state.currentDocId, text);
    } else {
      state.currentDocId = await createGoogleDoc(title, text);
      state.currentDocTitle = title;
      sessionStorage.setItem('diktering_docId', state.currentDocId);
    }

    const now = new Date();
    document.getElementById('doc-meta').textContent = `Lagret ${formatDateTime(now)}`;
    updateOpenDocButton();
    document.getElementById('notion-btn').disabled = false;

    if (state.isRecording) {
      setStatus('recording', 'Lytter...');
    } else {
      setStatus('saved', `Lagret ${now.toLocaleTimeString('nb-NO', { hour:'2-digit', minute:'2-digit' })}`);
    }

    if (!isAutoSave) {
      toast(`Lagret i Google Docs`, 'success');
    }
  } catch (err) {
    console.error('Lagringsfeil:', err);
    if (!state.isRecording) setStatus('error', 'Lagring feilet');
    toast(`Lagring feilet: ${err.message}`, 'error');
  } finally {
    document.getElementById('save-label').textContent = 'Lagre til Drive';
    document.getElementById('save-btn').disabled = false;
  }
}

let cachedFolderId = null;

async function getDiktafonFolderId() {
  if (cachedFolderId) return cachedFolderId;
  const q = encodeURIComponent("name='_Diktafon' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const res = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  const data = await res.json();
  if (data.error) {
    toast(`Mappe-søk feilet: ${data.error.message}`, 'error');
    return null;
  }
  if (data.files && data.files.length > 0) {
    cachedFolderId = data.files[0].id;
    return cachedFolderId;
  }
  // Mappen finnes ikke — opprett den
  const createRes = await apiFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    body: JSON.stringify({
      name: '_Diktafon',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const folder = await createRes.json();
  if (folder.error) {
    toast(`Kunne ikke opprette _Diktafon-mappe: ${folder.error.message}`, 'error');
    return null;
  }
  if (folder.id) {
    cachedFolderId = folder.id;
    return cachedFolderId;
  }
  return null;
}

async function createGoogleDoc(title, content) {
  // Steg 1: Opprett tomt dokument
  const createRes = await apiFetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });

  const doc = await createRes.json();
  if (!doc.documentId) throw new Error(doc.error?.message || 'Kunne ikke opprette dokument');

  // Steg 2: Sett inn tekst
  await insertTextIntoDoc(doc.documentId, content);

  // Steg 3: Flytt til _Diktafon-mappen
  const folderId = await getDiktafonFolderId();
  if (folderId) {
    const moveRes = await apiFetch(
      `https://www.googleapis.com/drive/v3/files/${doc.documentId}?addParents=${folderId}&removeParents=root&fields=id`,
      { method: 'PATCH', body: JSON.stringify({}) }
    );
    const moveData = await moveRes.json();
    if (moveData.error) {
      console.error('Flytt til mappe feilet:', moveData.error);
      toast(`Lagret, men kunne ikke flytte til _Diktafon: ${moveData.error.message}`, 'error');
    }
  }

  return doc.documentId;
}

async function updateGoogleDoc(docId, content) {
  // Hent gjeldende dokumentlengde
  const docRes = await apiFetch(`https://docs.googleapis.com/v1/documents/${docId}`);
  const doc = await docRes.json();

  if (doc.error) throw new Error(doc.error.message);

  // Finn slutten av dokumentet (siste tegn-indeks)
  const endIndex = doc.body?.content?.at(-1)?.endIndex ?? 1;
  const textLength = endIndex - 1;

  const requests = [];

  // Slett eksisterende innhold hvis det finnes
  if (textLength > 0) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIndex - 1 }
      }
    });
  }

  // Sett inn ny tekst
  requests.push({
    insertText: {
      location: { index: 1 },
      text: content,
    }
  });

  const updateRes = await apiFetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });

  const result = await updateRes.json();
  if (result.error) throw new Error(result.error.message);
}

async function insertTextIntoDoc(docId, content) {
  const res = await apiFetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        insertText: { location: { index: 1 }, text: content }
      }]
    }),
  });
  const result = await res.json();
  if (result.error) throw new Error(result.error.message);
}

function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${state.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

// ============================================================
//  Tittel-dialog (delt mellom filnavn og Notion)
// ============================================================
async function openTitleDialog(callback = null) {
  const text = state.finalText.trim();
  if (!text) { toast('Ingen tekst å lage tittel fra.'); return; }

  document.getElementById('title-modal-heading').textContent = callback ? 'Tittel i Notion' : 'Endre filnavn';
  document.getElementById('title-modal-confirm').textContent = callback ? 'Eksporter til Notion' : 'Bekreft';
  document.getElementById('title-modal-input').value = document.getElementById('doc-title').value;
  document.getElementById('title-modal').classList.remove('hidden');
  state.titleDialogCallback = callback;

  // Foreslå tittel med Gemini i bakgrunnen
  suggestTitle(text).then(suggested => {
    const input = document.getElementById('title-modal-input');
    if (input && !state.userSetTitle) input.value = suggested;
  });
}

function cancelTitleDialog() {
  document.getElementById('title-modal').classList.add('hidden');
  state.titleDialogCallback = null;
}

function confirmTitleDialog() {
  const title = document.getElementById('title-modal-input').value.trim() || makeDocTitle();
  document.getElementById('title-modal').classList.add('hidden');

  if (state.titleDialogCallback) {
    // Kalt fra Notion-eksport
    const cb = state.titleDialogCallback;
    state.titleDialogCallback = null;
    cb(title);
  } else {
    // Kalt fra "Endre filnavn"
    document.getElementById('doc-title').value = title;
    state.userSetTitle = true;
    toast(`Filnavn satt til: «${title}»`, 'success');
  }
}

// ============================================================
//  Notion-eksport
// ============================================================
let notionDatabaseId = null;

function notionFetch(endpoint, options = {}) {
  return fetch('/api/notion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint,
      body: options.body ? JSON.parse(options.body) : undefined,
    }),
  });
}


async function exportToNotion() {
  const text = state.finalText.trim();
  if (!text) { toast('Ingen tekst å eksportere.'); return; }

  if (state.userSetTitle) {
    // Bruker har allerede satt tittel — eksporter direkte
    const title = document.getElementById('doc-title').value.trim() || makeDocTitle();
    await doNotionExport(title);
  } else {
    // Åpne tittel-dialog
    openTitleDialog((title) => doNotionExport(title));
  }
}

async function doNotionExport(title) {

  const btn = document.getElementById('notion-btn');
  btn.disabled = true;
  setStatus('saving', 'Eksporterer til Notion...');

  try {
    const text = state.finalText.trim();
    const chunks = [];
    for (let i = 0; i < text.length; i += 2000) chunks.push(text.slice(i, i + 2000));
    const children = chunks.map(chunk => ({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] },
    }));

    const res = await notionFetch('pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: CONFIG.notionDatabaseId },
        properties: { Tittel: { title: [{ text: { content: title } }] } },
        children,
      }),
    });

    const data = await res.json();
    if (data.object === 'error') throw new Error(data.message);

    const now = new Date().toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('notion-status-text').textContent = `Notion kl. ${now}: «${title}»`;
    document.getElementById('notion-status').classList.remove('hidden');
    if (data.url) {
      const btn = document.getElementById('open-notion-btn');
      btn.href = data.url;
      btn.classList.remove('hidden');
    }
    toast(`Eksportert til Notion: «${title}»`, 'success');
    setStatus('idle', 'Klar');
  } catch (err) {
    console.error('Notion-feil:', err);
    setStatus('error', 'Notion feilet');
    toast(`Notion feilet: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function suggestTitle(text) {
  try {
    const preview = text.slice(0, 1000);
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Lag en kort, beskrivende tittel (maks 8 ord) på norsk for dette notatet. Returner kun tittelen, ingen anførselsmerker eller punktum:\n\n${preview}`,
        temperature: 0.4,
      }),
    });
    const data = await res.json();
    const suggested = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (suggested) return suggested;
  } catch (_) {}
  return document.getElementById('doc-title').value.trim() || makeDocTitle();
}

// ============================================================
//  Korrektur (Gemini AI)
// ============================================================
async function runKorrektur() {
  const text = state.finalText.trim();
  if (!text) { toast('Ingen tekst å korrigere.'); return; }
  if (!isTokenValid()) { toast('Logg inn med Google først.', 'error'); handleAuth(); return; }

  const btn = document.getElementById('korrektur-btn');
  btn.disabled = true;
  setStatus('saving', 'Korrektur...');

  try {
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Du er en norsk korrekturleser. Rett opp skrivefeil, fiks tegnsetting og gjør teksten helhetlig og lesbar. Behold meningen og innholdet nøyaktig. Returner kun den korrigerte teksten, uten kommentarer eller forklaringer.\n\n${text}`,
        temperature: 0.1,
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const corrected = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!corrected) throw new Error('Ingen respons fra Gemini');

    state.finalText = corrected;
    renderTranscript();
    updateWordCount();
    scheduleAutoSave();
    setStatus('idle', 'Klar');
    toast('Korrektur fullført', 'success');
  } catch (err) {
    console.error('Korrekturfeil:', err);
    setStatus('error', 'Korrektur feilet');
    toast(`Korrektur feilet: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
//  Toast-varsler
// ============================================================
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type === 'success' ? 'toast-success' : type === 'error' ? 'toast-error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s ease';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ============================================================
//  Oppsettguide
// ============================================================
function showSetupGuide() {
  document.getElementById('setup-modal').classList.remove('hidden');
}

function closeSetupGuide() {
  document.getElementById('setup-modal').classList.add('hidden');
}

// ============================================================
//  PWA Service Worker registrering
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
