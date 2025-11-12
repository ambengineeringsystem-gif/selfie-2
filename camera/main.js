// Lightweight camera client for pairing + auto-answering (session-based)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  update,
  push,
  onChildAdded,
  onValue,
  remove,
  onDisconnect,
  get,
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-database.js";

// Embedded Firebase config (same project)
const firebaseConfig = {
  apiKey: "AIzaSyB7KNURIlPW2S2J_aJdoX3c4L6BR5gma0g",
  authDomain: "secu-18771.firebaseapp.com",
  databaseURL: "https://secu-18771-default-rtdb.firebaseio.com",
  projectId: "secu-18771",
  storageBucket: "secu-18771.firebasestorage.app",
  messagingSenderId: "119665330735",
  appId: "1:119665330735:web:52bdea3a4a8aac362114da",
  measurementId: "G-GJMJJT9636",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const cameraNameInput = document.getElementById('cameraNameInput');
const registerBtn = document.getElementById('registerBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const genCodeBtn = document.getElementById('genCodeBtn');
const pairCodeDisplay = document.getElementById('pairCodeDisplay');
const statusEl = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const previewEl = document.getElementById('preview');
const centerArea = document.getElementById('centerArea');
const capturedDiv = document.getElementById('captured');

let registeredCameraName = null;
let cameraDbRef = null;
let localStream = null;
let listeners = [];
let activePairCode = null;
let pairCodeTimer = null;
let currentSessionId = null; // track the active session id for cross-device commands
const PAIR_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const servers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Only expose one action: generatePairCode. It will register and start the camera as needed.
genCodeBtn.onclick = generatePairCode;

function setStatus(msg){ if(statusEl) statusEl.textContent = msg; }

async function registerCamera(){
  const name = (cameraNameInput && cameraNameInput.value || '').trim() || (localStorage.getItem('cameraName') || '').trim();
  if(!name){ alert('Enter a camera name'); return null; }
  try{
    const camRef = ref(db, 'cameras/' + name);
    const deviceInfo = { platform: navigator.platform || '', userAgent: navigator.userAgent || '' };
    await update(camRef, { online: true, standby: true, lastSeen: Date.now(), device: deviceInfo });
    try{ onDisconnect(camRef).remove(); }catch(e){}
    registeredCameraName = name; cameraDbRef = camRef; setStatus('Registered as ' + name);
    try{ localStorage.setItem('cameraName', name); }catch(e){}
    return name;
  }catch(e){ console.warn('register failed', e); setStatus('Register failed'); return null; }
}

async function startListening(){
  // startListening is now internal to generatePairCode; keep this function for compatibility but keep behavior minimal
  if(!registeredCameraName) return;
  try{
    // attach session listener (only once)
    const sessionsRef = ref(db, 'sessions');
    const sessListener = onChildAdded(sessionsRef, async snap => {
      const session = snap.val(); const sessionId = snap.key; if(!session) return;
      if(session.target !== registeredCameraName) return; if(!session.offer) return; if(session.answer) return;
      setStatus('Incoming session — answering...');
      // When we receive an incoming session, request camera/mic permission and show preview.
      try{
          if(!localStream){
          localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
          localVideo.srcObject = localStream;
          if(previewEl){ previewEl.style.display = 'block'; previewEl.classList.add('fullscreen'); }
          // hide the centered UI (icon/code) when the preview is shown
          try{ if(centerArea) centerArea.style.display = 'none'; }catch(e){}
          setStatus('Camera active');
        }
      }catch(e){ console.warn('getUserMedia failed at incoming session', e); return setStatus('Camera permission required'); }

      const pc = new RTCPeerConnection(servers);
  // store current session id so other code (capture handlers) can send commands
  try{ currentSessionId = sessionId; }catch(e){}
      if(localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      const calleeCandsRef = ref(db, 'sessions/' + sessionId + '/calleeCandidates');
      pc.onicecandidate = e => { if(e.candidate) push(calleeCandsRef, e.candidate.toJSON()); };

      // buffer caller (remote) candidates until remote description is applied.
      const callerCandsRef = ref(db, 'sessions/' + sessionId + '/callerCandidates');
      const pendingCallerCandidates = [];
      const callerListener = onChildAdded(callerCandsRef, csnap => {
        const c = csnap.val();
        if(!c) return;
        // If remote description is set, add immediately, otherwise queue it.
        try{
          if(pc.remoteDescription && pc.remoteDescription.type){
            pc.addIceCandidate(c).catch(e=>console.warn('addIce failed', e));
          }else{
            pendingCallerCandidates.push(c);
          }
        }catch(e){
          // In case of unexpected errors, queue candidate as a fallback
          pendingCallerCandidates.push(c);
        }
      });
      listeners.push(callerListener);

      try{
        await pc.setRemoteDescription(session.offer);

        // flush any pending remote candidates collected before remoteDescription was set
        for(const c of pendingCallerCandidates){
          try{ await pc.addIceCandidate(c); }catch(e){ console.warn('flush addIce failed', e); }
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await set(ref(db, 'sessions/' + sessionId + '/answer'), pc.localDescription.toJSON());
        set(ref(db, 'sessions/' + sessionId + '/answered'), true);
        set(ref(db, 'sessions/' + sessionId + '/status'), 'answered');
  setStatus('Session answered: ' + sessionId);
  console.log('camera: answered session', sessionId);
      }catch(e){ console.warn('answer failed', e); }

        // listen for remote commands (e.g., takePhoto) under this session
        try{
          const commandsRef = ref(db, 'sessions/' + sessionId + '/commands');
          const cmdListener = onChildAdded(commandsRef, async csnap => {
            const cmd = csnap.val(); if(!cmd || !cmd.type) return;
            try{
              if(cmd.type === 'takePhoto'){
                // take local frame and show preview
                captureLocalFrame();
                setStatus('Remote triggered photo');
              }
            }catch(e){ console.warn('command handling failed', e); }
          });
          listeners.push(cmdListener);
        }catch(e){/* ignore */}

        // Listen for direct viewerCommands (from viewer) - alternate channel
        try{
          const viewerCmdRef = ref(db, 'sessions/' + sessionId + '/viewerCommands');
          const viewerListener = onChildAdded(viewerCmdRef, async csnap => {
            const cmd = csnap.val(); if(!cmd || !cmd.type) return;
            try{
              if(cmd.type === 'downloadCaptured'){
                // download the camera's captured image if present
                const img = capturedDiv && capturedDiv.querySelector('img');
                if(img && img.src){
                  const a = document.createElement('a'); a.href = img.src; a.download = 'camera-capture-' + Date.now() + '.jpg'; document.body.appendChild(a); a.click(); a.remove();
                  setStatus('Downloaded local captured image');
                }
              }else if(cmd.type === 'nextShot'){
                if(capturedDiv){ capturedDiv.innerHTML = ''; }
                setStatus('Ready for next shot');
              }
            }catch(e){ console.warn('viewerCommand handling failed', e); }
          });
          listeners.push(viewerListener);
        }catch(e){ /* ignore */ }

        // Also listen for 'lastCommand' value which is easier for single-shot commands
        try{
          const lastCmdRef = ref(db, 'sessions/' + sessionId + '/lastCommand');
          const lastListener = onValue(lastCmdRef, async snapCmd => {
            const cmd = snapCmd.val(); console.log('camera: lastCommand change', sessionId, cmd); if(!cmd || !cmd.type) return;
            try{
              if(cmd.type === 'takePhoto'){
                  captureLocalFrame();
                  setStatus('Remote triggered photo (lastCommand)');
                  // write an acknowledgement so remote can see we processed the command
                  try{
                    const ackRef = ref(db, 'sessions/' + sessionId + '/lastCommandAck');
                    await set(ackRef, { type: 'takePhotoAck', from: (registeredCameraName||'camera'), ts: Date.now() });
                  }catch(e){ console.warn('failed to write ack', e); }
                  // clear the command so it won't fire again
                  try{ await set(lastCmdRef, null); }catch(e){ console.warn('failed to clear lastCommand', e); }
                }
                else if(cmd.type === 'downloadCaptured'){
                  // instruct camera to download its captured image (if present)
                  try{
                    const img = capturedDiv && capturedDiv.querySelector('img');
                    if(img && img.src){
                      const a = document.createElement('a');
                      a.href = img.src;
                      a.download = 'camera-capture-' + Date.now() + '.jpg';
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      setStatus('Downloaded captured image locally');
                    }else{
                      setStatus('No captured image to download');
                    }
                  }catch(e){ console.warn('downloadCaptured failed', e); setStatus('Download failed'); }
                  // ack and clear
                  try{ const ackRef = ref(db, 'sessions/' + sessionId + '/lastCommandAck'); await set(ackRef, { type: 'downloadCapturedAck', from: (registeredCameraName||'camera'), ts: Date.now() }); }catch(e){}
                  try{ await set(lastCmdRef, null); }catch(e){}
                }
                else if(cmd.type === 'nextShot'){
                  // clear the captured preview and prepare for next shot
                  try{ if(capturedDiv){ capturedDiv.innerHTML = ''; } setStatus('Ready for next shot'); }catch(e){ console.warn('nextShot handling failed', e); }
                  // ack and clear
                  try{ const ackRef = ref(db, 'sessions/' + sessionId + '/lastCommandAck'); await set(ackRef, { type: 'nextShotAck', from: (registeredCameraName||'camera'), ts: Date.now() }); }catch(e){}
                  try{ await set(lastCmdRef, null); }catch(e){}
                }
            }catch(e){ console.warn('lastCommand handling failed', e); }
          });
          listeners.push(lastListener);
        }catch(e){ /* ignore */ }
      pc.onconnectionstatechange = () => {
        // when connected, hide the pair code UI (do not necessarily delete the code from DB)
        if(pc.connectionState === 'connected' || pc.connectionState === 'completed'){
          try{ if(pairCodeDisplay) pairCodeDisplay.style.display = 'none'; }catch(e){}
          try{ if(genCodeBtn) genCodeBtn.style.display = 'none'; }catch(e){}
        }

        // when the connection ends, restore the centered UI so user can generate another code
        if(pc.connectionState === 'closed' || pc.connectionState === 'failed' || pc.connectionState === 'disconnected'){
          try{ callerListener(); }catch(e){}
          try{ if(previewEl){ previewEl.style.display = 'none'; previewEl.classList.remove('fullscreen'); } }catch(e){}
          try{ if(centerArea) centerArea.style.display = 'flex'; }catch(e){}
          // show the code if it still exists, otherwise show the icon
          try{
            if(activePairCode){ if(pairCodeDisplay) pairCodeDisplay.style.display = 'block'; if(genCodeBtn) genCodeBtn.style.display = 'none'; }
            else { if(genCodeBtn) genCodeBtn.style.display = 'block'; if(pairCodeDisplay) pairCodeDisplay.style.display = 'none'; }
          }catch(e){}
          // clear the stored session id when connection ends
          try{ currentSessionId = null; }catch(e){}
        }
      };
    });
    listeners.push(sessListener);

    try{ await update(cameraDbRef, { online: true, standby: false, lastSeen: Date.now() }); }catch(e){}
  }catch(e){ console.warn('startListening failed', e); }
}

async function generatePairCode(){
  // Ensure camera is registered and streaming, then write a one-time code
  try{
    // register if needed
    if(!registeredCameraName){
      const name = (cameraNameInput && cameraNameInput.value || '').trim() || (localStorage.getItem('cameraName') || '').trim();
      if(!name){
        const promptName = prompt('Enter a camera name to register (example: my-phone):');
        if(!promptName) return setStatus('Name required');
        cameraNameInput.value = promptName.trim();
      }
      const res = await registerCamera();
      if(!res) return;
    }

    // start local camera if not already started
    // Do not start local camera here. Media will be requested when an incoming session arrives.

    // ensure we are listening for sessions
    await startListening();

    // clean previous code if any
    try{ if(activePairCode){ await remove(ref(db, 'codes/' + activePairCode)); activePairCode = null; } }catch(e){}

    const code = makeCode(5);
    const payload = { camera: registeredCameraName, created: Date.now(), expires: Date.now() + PAIR_CODE_TTL_MS };
    await set(ref(db, 'codes/' + code), payload);
    activePairCode = code;
    if(pairCodeDisplay) {
      pairCodeDisplay.textContent = code;
      pairCodeDisplay.style.display = 'block';
    }
    // render QR code for the generated pair code so another phone can scan it
    try{
      const qrEl = document.getElementById('pairQr');
      if(qrEl){
        qrEl.innerHTML = '';
        // QRCode is provided by qrcode.min.js included in the HTML
        try{ new QRCode(qrEl, { text: code, width: 200, height: 200, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M }); }catch(e){
          // fallback: show plain code if QR lib fails
          qrEl.textContent = code;
        }
        qrEl.style.display = 'block';
      }
    }catch(e){ console.warn('QR render failed', e); }
    // hide the icon so only the code is visible in the center
    try{ if(genCodeBtn) genCodeBtn.style.display = 'none'; }catch(e){}
    if(pairCodeTimer) clearTimeout(pairCodeTimer);
    pairCodeTimer = setTimeout(async ()=>{
      try{ await remove(ref(db, 'codes/' + code)); }catch(e){}
      if(activePairCode===code) activePairCode=null;
      try{ if(pairCodeDisplay) pairCodeDisplay.textContent = ''; if(pairCodeDisplay) pairCodeDisplay.style.display = 'none'; }catch(e){}
      try{ const qrEl = document.getElementById('pairQr'); if(qrEl){ qrEl.innerHTML=''; qrEl.style.display='none'; } }catch(e){}
      try{ if(genCodeBtn) genCodeBtn.style.display = 'block'; }catch(e){}
    }, PAIR_CODE_TTL_MS);
    setStatus('Pair code: ' + code + ' (expires in 5m)');
  }catch(e){ console.warn('generatePairCode failed', e); setStatus('Failed to generate code'); }
}

function makeCode(len=5){ const chars='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s; }

function captureLocalFrame(){
  try{
    if(!localVideo){ setStatus('No local video element'); console.warn('captureLocalFrame: no localVideo'); return; }
    if(!localVideo.videoWidth || !localVideo.videoHeight){ setStatus('Local video not ready'); console.warn('captureLocalFrame: video not ready', localVideo.videoWidth, localVideo.videoHeight); return; }
    const canvas = document.createElement('canvas'); canvas.width = localVideo.videoWidth; canvas.height = localVideo.videoHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(localVideo, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    console.log('captureLocalFrame: captured dataUrl length=', dataUrl.length);
    try{
      if(capturedDiv){
        capturedDiv.innerHTML = '';
        // create wrapper so we can overlay action icons
        const wrap = document.createElement('div'); wrap.className = 'captured-wrap';
        const img = document.createElement('img'); img.src = dataUrl; img.className = 'captured-img';
        wrap.appendChild(img);

        // heart icon (download locally and request viewer to download)
        const heart = document.createElement('button'); heart.className = 'icon-btn heart'; heart.title = 'Download (both sides)'; heart.innerHTML = '❤';
        heart.addEventListener('click', async ()=>{
          try{
            // download local image
            const a = document.createElement('a'); a.href = img.src; a.download = 'camera-capture-' + Date.now() + '.jpg'; document.body.appendChild(a); a.click(); a.remove();
            setStatus('Downloaded local image');
            // notify viewer (if session active) to download its captured image too
            if(currentSessionId){
              const cmdsRef = ref(db, 'sessions/' + currentSessionId + '/cameraCommands');
              await push(cmdsRef, { type: 'downloadCaptured', from: (registeredCameraName||'camera'), ts: Date.now() });
            }
          }catch(e){ console.warn('heart download failed', e); setStatus('Download failed'); }
        });
        wrap.appendChild(heart);

        // trash icon (clear captured preview and request viewer to prepare next shot)
        const trash = document.createElement('button'); trash.className = 'icon-btn trash'; trash.title = 'Reset for next shot'; trash.innerHTML = '🗑';
        trash.addEventListener('click', async ()=>{
          try{ if(capturedDiv){ capturedDiv.innerHTML = ''; } setStatus('Ready for next shot');
            if(currentSessionId){ const cmdsRef = ref(db, 'sessions/' + currentSessionId + '/cameraCommands'); await push(cmdsRef, { type: 'nextShot', from: (registeredCameraName||'camera'), ts: Date.now() }); }
          }catch(e){ console.warn('trash action failed', e); }
        });
        wrap.appendChild(trash);

        capturedDiv.appendChild(wrap);
        capturedDiv.style.display = 'flex';
      }
    }catch(e){ console.warn('failed to show captured image', e); }
    setStatus('Local photo captured');
  }catch(e){ console.warn('captureLocalFrame failed', e); setStatus('Capture failed'); }
}

async function stopAll(){
  stopBtn.disabled = true; setStatus('Stopping...');
  listeners.forEach(u => { try{ u(); }catch(e){} }); listeners = [];
  try{ if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; localVideo.srcObject=null; } }catch(e){}
  try{ if(previewEl) previewEl.style.display = 'none'; }catch(e){}
  try{ if(pairCodeTimer) clearTimeout(pairCodeTimer); }catch(e){}
  try{ if(activePairCode) await remove(ref(db, 'codes/' + activePairCode)); }catch(e){}
  activePairCode = null;
  try{ if(pairCodeDisplay) pairCodeDisplay.textContent = ''; if(pairCodeDisplay) pairCodeDisplay.style.display = 'none'; }catch(e){}
  try{ if(genCodeBtn) genCodeBtn.style.display = 'block'; }catch(e){}
  setStatus('Stopped'); startBtn.disabled = false; stopBtn.disabled = true;
}

window.addEventListener('beforeunload', async ()=>{
  try{ if(activePairCode) await remove(ref(db, 'codes/' + activePairCode)); }catch(e){}
});

export {};
