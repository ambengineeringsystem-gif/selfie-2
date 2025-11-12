// Selfie Remote - lightweight viewer & shutter using Firebase Realtime Database sessions
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getDatabase, ref, push, set, onValue, onChildAdded, get, remove } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-database.js";

// Embedded Firebase config (uses the same project as cam/viewer)
const embeddedConfig = {
  apiKey: "AIzaSyB7KNURIlPW2S2J_aJdoX3c4L6BR5gma0g",
  authDomain: "secu-18771.firebaseapp.com",
  databaseURL: "https://secu-18771-default-rtdb.firebaseio.com",
  projectId: "secu-18771",
  storageBucket: "secu-18771.firebasestorage.app",
  messagingSenderId: "119665330735",
  appId: "1:119665330735:web:52bdea3a4a8aac362114da",
  measurementId: "G-GJMJJT9636"
};

const firebaseConfig = embeddedConfig;
let db = null;
let app = null;
if(firebaseConfig && firebaseConfig.apiKey && (firebaseConfig.databaseURL || firebaseConfig.projectId)){
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);
}

const statusEl = document.getElementById('status');
const remoteVideo = document.getElementById('remoteVideo');
const takePhotoBtn = document.getElementById('takePhoto');
const capturedDiv = document.getElementById('captured');

let pc = null;
let callerCandidatesRef = null;
let calleeCandidatesRef = null;
let sessionId = null;
let localViewerId = localStorage.getItem('selfieViewerId') || ('viewer-' + Math.random().toString(36).slice(2,9));
localStorage.setItem('selfieViewerId', localViewerId);

const servers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function setStatus(msg){ if(statusEl) statusEl.textContent = msg; }

async function connectCamera(name){
  if(!db) { setStatus('DB not initialized'); return; }
  setStatus('Connecting to ' + name + ' ...');
  if(pc){ hangUp(); }

  pc = new RTCPeerConnection(servers);

  const remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;
  pc.ontrack = e => { e.streams[0].getTracks().forEach(t=> remoteStream.addTrack(t)); };

  // add recvonly transceivers to request tracks
  try{ pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' }); }catch(e){}

  // ICE -> push to callerCandidates
  const sessionsRef = ref(db, 'sessions');
  const sessionRef = push(sessionsRef);
  sessionId = sessionRef.key;
  console.log('connectCamera: created sessionId=', sessionId);
  callerCandidatesRef = ref(db, 'sessions/' + sessionId + '/callerCandidates');
  calleeCandidatesRef = ref(db, 'sessions/' + sessionId + '/calleeCandidates');

  pc.onicecandidate = e => { if(!e.candidate) return; push(callerCandidatesRef, e.candidate.toJSON()); };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await set(sessionRef, { from: localViewerId, target: name, offer: pc.localDescription.toJSON(), created: Date.now() });
  setStatus('Offer written, waiting for camera...');

  // listen for answer
  const ansRef = ref(db, 'sessions/' + sessionId + '/answer');
  const ansListener = onValue(ansRef, async snap => {
    const val = snap.val(); if(!val) return;
    try{
      if(pc && pc.signalingState === 'have-local-offer'){
        await pc.setRemoteDescription(val);
  setStatus('Connected — stream should appear shortly');
  console.log('remote: session connected (applied answer) sessionId=', sessionId);

        // Reveal the video feed and hide the pairing UI when connected
        try{
          const viewerEl = document.getElementById('viewer');
          const pairByCodeEl = document.getElementById('pairByCode');
          if(pairByCodeEl){ pairByCodeEl.style.display = 'none'; pairByCodeEl.classList.add('hidden'); }
          if(viewerEl){ viewerEl.style.display = ''; viewerEl.classList.remove('hidden'); viewerEl.classList.add('fullscreen'); }
          // hide the whole controls column while viewing the stream
          const controlsEl = document.getElementById('controls');
          if(controlsEl){ controlsEl.style.display = 'none'; controlsEl.classList.add('hidden'); }
        }catch(e){ /* ignore UI errors */ }

        // listen for callee ICE
        const candsRef = ref(db, 'sessions/' + sessionId + '/calleeCandidates');
        onChildAdded(candsRef, s => { const cand = s.val(); if(cand) pc.addIceCandidate(cand).catch(e=>console.warn('addIce error',e)); });
        // listen for cameraCommands coming from the camera (e.g., when camera wants the viewer to act)
        try{
          const cameraCmdRef = ref(db, 'sessions/' + sessionId + '/cameraCommands');
          onChildAdded(cameraCmdRef, s => {
            const cmd = s.val(); if(!cmd || !cmd.type) return;
            try{
                      if(cmd.type === 'downloadCaptured'){
                // download remote's captured image if present
                const img = capturedDiv && capturedDiv.querySelector('img');
                if(img && img.src){ const a = document.createElement('a'); a.href = img.src; a.download = 'viewer-capture-' + Date.now() + '.jpg'; document.body.appendChild(a); a.click(); a.remove(); setStatus('Downloaded viewer image'); }
              }else if(cmd.type === 'nextShot'){
                        if(capturedDiv){ capturedDiv.innerHTML = ''; try{ capturedDiv.style.display = 'none'; }catch(e){} }
                setStatus('Ready for next shot');
              }
            }catch(e){ console.warn('cameraCommand handling failed', e); }
          });
        }catch(e){ /* ignore */ }
        // listen for ack from camera when it processes commands
        try{
          const ackRef = ref(db, 'sessions/' + sessionId + '/lastCommandAck');
          onValue(ackRef, snap => { const ack = snap.val(); if(!ack) return; console.log('remote: received ack', ack); setStatus('Camera acknowledged command: ' + (ack.type||'')); });
        }catch(e){ /* ignore */ }
      }
    }catch(e){ console.warn('answer apply failed', e); }
  });

}

function hangUp(){ try{ if(pc) pc.close(); }catch(e){} pc = null; if(sessionId && db) { setStatus('Disconnected'); } sessionId = null; }

// Restore UI when hanging up: show controls and pairing UI again
function restoreControlsUI(){
  try{
    const controlsEl = document.getElementById('controls');
    const hdr = document.querySelector('header');
    const pairByCodeEl = document.getElementById('pairByCode');
    const viewerEl = document.getElementById('viewer');
    if(controlsEl){ controlsEl.style.display = ''; controlsEl.classList.remove('hidden'); }
    if(hdr){ hdr.style.display = ''; hdr.classList.remove('hidden'); }
    if(pairByCodeEl){ pairByCodeEl.style.display = ''; pairByCodeEl.classList.remove('hidden'); }
    if(viewerEl){ viewerEl.style.display = 'none'; viewerEl.classList.add('hidden'); viewerEl.classList.remove('fullscreen'); }
    try{ document.body.classList.remove('pairing-mode'); }catch(e){}
  }catch(e){ /* ignore */ }
}

// capture current frame from remoteVideo
async function captureFrame(){
  if(!remoteVideo || !remoteVideo.videoWidth) { setStatus('No video to capture'); return; }
  const canvas = document.createElement('canvas'); canvas.width = remoteVideo.videoWidth; canvas.height = remoteVideo.videoHeight;
  const ctx = canvas.getContext('2d'); ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  capturedDiv.innerHTML = '';
  // create wrapper with overlay action icons
  const wrap = document.createElement('div'); wrap.className = 'captured-wrap';
  const img = document.createElement('img'); img.src = dataUrl; img.className = 'captured-img';
  wrap.appendChild(img);

  // heart icon: download viewer image locally and request camera to download its image as well
  const heart = document.createElement('button'); heart.className = 'icon-btn heart'; heart.title = 'Download (both sides)'; heart.innerHTML = '❤';
  heart.addEventListener('click', async ()=>{
    try{
      const a = document.createElement('a'); a.href = img.src; a.download = 'viewer-capture-' + Date.now() + '.jpg'; document.body.appendChild(a); a.click(); a.remove();
      setStatus('Downloaded viewer image');
      // also request camera to download its captured image
  if(sessionId && db){ const cmdsRef = ref(db, 'sessions/' + sessionId + '/viewerCommands'); await push(cmdsRef, { type: 'downloadCaptured', from: localViewerId, ts: Date.now() }); }
    }catch(e){ console.warn('remote heart failed', e); setStatus('Download failed'); }
  });
  wrap.appendChild(heart);

  // trash icon: clear viewer preview and request camera to ready next shot
  const trash = document.createElement('button'); trash.className = 'icon-btn trash'; trash.title = 'Reset for next shot'; trash.innerHTML = '🗑';
  trash.addEventListener('click', async ()=>{
    try{ if(capturedDiv){ capturedDiv.innerHTML = ''; try{ capturedDiv.style.display = 'none'; }catch(e){} } setStatus('Ready for next shot');
  if(sessionId && db){ const cmdsRef = ref(db, 'sessions/' + sessionId + '/viewerCommands'); await push(cmdsRef, { type: 'nextShot', from: localViewerId, ts: Date.now() }); }
    }catch(e){ console.warn('remote trash failed', e); }
  });
  wrap.appendChild(trash);

  capturedDiv.appendChild(wrap);
  // ensure the captured container is visible and uses flex layout (overlayed in CSS)
  try{ if(capturedDiv) capturedDiv.style.display = 'flex'; }catch(e){}
  // downloads are handled via the overlay action buttons (heart icon). No inline anchor.
  setStatus('Photo captured');
  // Notify the camera to take a local photo as well (if session exists)
  try{
    if(db && sessionId){
      // write a lastCommand entry so camera can pick it up reliably
      const lastCmdRef = ref(db, 'sessions/' + sessionId + '/lastCommand');
      const payload = { type: 'takePhoto', from: localViewerId, ts: Date.now() };
      await set(lastCmdRef, payload);
      // small log for debugging
      console.log('Pushed lastCommand for session', sessionId, payload);
      setStatus('Triggered remote camera to capture (session ' + sessionId + ')');
    }
  }catch(e){ console.warn('failed to notify camera', e); }
}

takePhotoBtn.onclick = captureFrame;

// Connect by short code (lookup /codes/<code> -> { camera, created })
const codeInput = document.getElementById('codeInput');
const codeConnectBtn = document.getElementById('codeConnect');
async function connectByCode(code){
  if(!db) return setStatus('DB not initialized');
  if(!code) return setStatus('Enter a code');
  setStatus('Looking up code...');
  try{
    const snap = await get(ref(db, 'codes/' + code));
    const val = snap.val();
    if(!val || !val.camera) return setStatus('Code not found or expired');
    // optionally consume the code so it can't be reused
    try{ await remove(ref(db, 'codes/' + code)); }catch(e){}
    // leaving pairing-mode as we transition to the connection UI
    try{ document.body.classList.remove('pairing-mode'); }catch(e){}
    connectCamera(val.camera);
  }catch(e){ console.warn('code lookup failed', e); setStatus('Lookup error'); }
}
codeConnectBtn && (codeConnectBtn.onclick = ()=> connectByCode((codeInput && codeInput.value||'').trim()));

// Remote -> Camera actions
// Note: download-on-camera button was removed from the UI. Camera download requests can still be
// sent via the heart icon on captured images or other programmatic paths.
// Note: the `nextShotOnCamera` control was removed from the UI. If needed, the viewer can still
// request a next shot by pushing a `nextShot` lastCommand into the session path programmatically.

// init
if(!db){ setStatus('Firebase not configured.'); }
else { setStatus('Ready — enter camera code to connect'); }

// Auto-connect when opened with ?code=XYZ in the URL — useful for QR-based flow
try{
  const params = new URLSearchParams(location.search);
  const codeParam = params.get('code');
  if(codeParam){
    // auto-fill and connect
    const codeInputEl = document.getElementById('codeInput');
    if(codeInputEl){ codeInputEl.value = codeParam; }
    // small delay to ensure DB and UI ready
    setTimeout(()=> connectByCode(codeParam), 250);
  }
}catch(e){ /* ignore */ }

// Startup UI: show only start icon; reveal pairing card when icon clicked
try{
  const startScreen = document.getElementById('startScreen');
  const startIcon = document.getElementById('startIcon');
  const pairByCode = document.getElementById('pairByCode');
  const codeInputEl = document.getElementById('codeInput');
  // Ensure pairing card hidden initially in JS too (defensive)
  if(pairByCode){ pairByCode.style.display = 'none'; pairByCode.classList.add('hidden'); }

  if(startIcon && startScreen){
    startIcon.addEventListener('click', ()=>{
      // Hide the start screen overlay
      startScreen.style.display = 'none';
      startScreen.setAttribute('aria-hidden','true');

      // Hide header and viewer so only the pairing card remains visible
      const hdr = document.querySelector('header');
      const viewerEl = document.getElementById('viewer');
      if(hdr) { hdr.classList.add('hidden'); hdr.style.display = 'none'; }
      if(viewerEl) { viewerEl.classList.add('hidden'); viewerEl.style.display = 'none'; }

      // Reveal the pairing UI (only visible element) and enter pairing-mode
      if(pairByCode){ pairByCode.style.display = ''; pairByCode.classList.remove('hidden'); }
      // Add a body class so CSS can force a plain background and hide other UI
      try{ document.body.classList.add('pairing-mode'); }catch(e){}
      if(codeInputEl) codeInputEl.focus();
    });
  }
}catch(e){ console.warn('start UI init failed', e); }
