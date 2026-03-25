// pose.js — clean, consolidated implementation
const videoElement = document.getElementById('video');
const canvasElement = document.getElementById('overlay');
const canvasCtx = canvasElement.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const snapBtn = document.getElementById('snapBtn');
const topHeightLabel = document.getElementById('topHeight');
const estHeightLabel = document.getElementById('estHeight');
const hideCameraChk = document.getElementById('hideCameraChk');
const hideSkeletonChk = document.getElementById('hideSkeletonChk');
const hideImagesChk = document.getElementById('hideImagesChk');
const disableBlinkChk = document.getElementById('disableBlinkChk');

let stream = null;
let rafId = null;
let showCamera = true;
let showSkeleton = false;
let showImages = true;
let flipHorizontal = false;
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
let _onLoadedMetadata = null;

// Smoothing configuration and state
const smoothingConfig = {
  enabled: true,
  baseAlpha: 0.25,      // minimum responsiveness (lower = smoother)
  minAlpha: 0.12,       // never go below this
  maxAlpha: 0.9,        // max responsiveness when fast motion
  speedScale: 0.0025,   // how much speed increases alpha
};
let _smoothedLandmarks = [];
let _smoothedTimestamps = [];
// initial shoulder distance used to scale fixed-pixel offsets so JSONs can keep pixel values
let _initialShoulderDist = null;
function resizeCanvasToVideo(){
  const vw = videoElement.videoWidth || videoElement.clientWidth || 640;
  const vh = videoElement.videoHeight || videoElement.clientHeight || 480;
  canvasElement.width = vw;
  canvasElement.height = vh;
  canvasElement.style.width = videoElement.clientWidth + 'px';
  canvasElement.style.height = videoElement.clientHeight + 'px';
}

// Load images
const torsoImg = new Image(); torsoImg.src = 'images/torso.png'; let torsoLoaded=false; torsoImg.onload=()=>torsoLoaded=true;
const headImg = new Image(); headImg.src = 'images/head.png'; let headLoaded=false; headImg.onload=()=>headLoaded=true;
const headLeftImg = new Image(); headLeftImg.src = 'images/headleft.png'; let headLeftLoaded=false; headLeftImg.onload=()=>headLeftLoaded=true;
const headRightImg = new Image(); headRightImg.src = 'images/headright.png'; let headRightLoaded=false; headRightImg.onload=()=>headRightLoaded=true;
// Blink overlay images (single-frame closed-eyes overlays)
const blinkImg = new Image(); blinkImg.src = 'images/blink.png'; let blinkLoaded=false; blinkImg.onload=()=>blinkLoaded=true;
const blinkLeftImg = new Image(); blinkLeftImg.src = 'images/blinkleft.png'; let blinkLeftLoaded=false; blinkLeftImg.onload=()=>blinkLeftLoaded=true;
const blinkRightImg = new Image(); blinkRightImg.src = 'images/blinkright.png'; let blinkRightLoaded=false; blinkRightImg.onload=()=>blinkRightLoaded=true;

// Default configs (will be merged with JSON files)
let torsoConfig = {enabled:true,widthMultiplier:1.4,heightMultiplier:1.2,alpha:0.95,rotationOffsetDegrees:0,centerOffsetX:0,centerOffsetY:0,useShoulderFallback:true,fallbackHipMultiplier:1.6};
let headConfig = {enabled:true,widthMultiplier:0.7,heightMultiplier:0.7,offsetX:0,offsetY:-10,rotationOffsetDegrees:0,alpha:1.0,leftImage:'images/headleft.png',rightImage:'images/headright.png',turnThreshold:0.18,flipVertical:false,flipHorizontal:false,blinkEnabled:true,blinkMinMs:2500,blinkMaxMs:6000,blinkDurationMs:120,blinkLeftImage:'images/blinkleft.png',blinkRightImage:'images/blinkright.png'};
// arm-tracking configs removed — only torso and head remain

// Load external JSON configs if present
// Load configs (exposed as reloadConfigs so editing JSON files updates without full page reload)
async function reloadConfigs(){
  try{
    const tResp = await fetch('torso.json');
    if (tResp.ok){ const cfg = await tResp.json(); if (cfg && cfg.headConfig){ console.warn('torso.json contains headConfig — ignoring headConfig in torso.json; use head.json for head settings'); delete cfg.headConfig; } Object.assign(torsoConfig,cfg); console.log('torso.json loaded', torsoConfig); }
  }catch(err){ console.warn('torso.json failed to load or parse', err); }
  try{
    const hResp = await fetch('head.json');
    if (hResp.ok){ const cfg = await hResp.json(); Object.assign(headConfig,cfg); console.log('head.json loaded', headConfig); }
  }catch(err){ console.warn('head.json failed to load or parse', err); }

  // If the settings panel exists, ensure the Disable Blinking checkbox reflects loaded config
  try{
    const db = document.getElementById('disableBlinkChk'); if (db) db.checked = !headConfig.blinkEnabled;
  }catch(e){}
}
// initial load
reloadConfigs();
// allow manual reload by pressing `r` (or `R`) so you can edit JSON and see changes immediately
window.addEventListener('keydown', (e)=>{ if (e.key==='r' || e.key==='R'){ reloadConfigs(); console.log('Configs reloaded via keypress'); } });

// arm-tracking state removed

function drawImageRotated(img, cx, cy, w, h, angle, flipX=false, flipY=false){
  canvasCtx.save();
  canvasCtx.translate(cx, cy);
  canvasCtx.rotate(angle);
  const scaleX = flipX ? -1 : 1;
  const scaleY = flipY ? -1 : 1;
  if (scaleX !== 1 || scaleY !== 1) canvasCtx.scale(scaleX, scaleY);
  canvasCtx.drawImage(img, -w/2, -h/2, w, h);
  canvasCtx.restore();
}

function drawUpperBody(landmarks){
  if (!landmarks || landmarks.length===0) return;
  resizeCanvasToVideo();
  canvasCtx.clearRect(0,0,canvasElement.width,canvasElement.height);

  const w = canvasElement.width, h = canvasElement.height;
  // Smooth landmarks into pixel-space coordinates
  function smoothLandmarks(src){
    const now = performance.now();
    const out = new Array(src.length);
    for (let i=0;i<src.length;i++){
        const lm = src[i] || {x:0,y:0,visibility:0};
        const rawX = (flipHorizontal ? (1 - lm.x) : lm.x) * w;
        const rawY = lm.y * h, rawV = lm.visibility ?? (lm.v ?? 1);
      const prev = _smoothedLandmarks[i];
      const prevT = _smoothedTimestamps[i] || now;
      const dt = Math.max(1, now - prevT);
      let sx = rawX, sy = rawY, sv = rawV;
      if (smoothingConfig.enabled && prev){
        const dx = rawX - prev.x, dy = rawY - prev.y;
        const speed = Math.sqrt(dx*dx + dy*dy) / dt; // px per ms
        let alpha = smoothingConfig.baseAlpha + speed * smoothingConfig.speedScale;
        alpha = Math.max(smoothingConfig.minAlpha, Math.min(smoothingConfig.maxAlpha, alpha));
        sx = prev.x + alpha * (rawX - prev.x);
        sy = prev.y + alpha * (rawY - prev.y);
        sv = prev.v + alpha * (rawV - prev.v);
      }
      out[i] = {x: sx, y: sy, v: sv};
      _smoothedLandmarks[i] = out[i];
      _smoothedTimestamps[i] = now;
    }
    return out;
  }

  const sm = smoothLandmarks(landmarks);
  const pt = i => { const lm = sm[i] || {x:0,y:0,v:0}; return {x: lm.x, y: lm.y, v: lm.v}; };
  const indices = {nose:0,lShoulder:11,rShoulder:12,lElbow:13,rElbow:14,lWrist:15,rWrist:16,lHip:23,rHip:24};
  const pts = {}; for (const k in indices) pts[k] = pt(indices[k]);

  // Helper: shoulder midpoint and distance
  const midShoulder = {x:(pts.lShoulder.x+pts.rShoulder.x)/2, y:(pts.lShoulder.y+pts.rShoulder.y)/2};
  const dxShould = pts.rShoulder.x - pts.lShoulder.x, dyShould = pts.rShoulder.y - pts.lShoulder.y;
  const shoulderDist = Math.hypot(dxShould, dyShould) || Math.max(w,h)/6;


  // upper-arm drawing removed

  // Draw torso using shoulders only (no hip fallback)
  if (torsoLoaded && torsoConfig.enabled && pts.lShoulder.v>0.2 && pts.rShoulder.v>0.2 && showImages){
    // Infer a hip point vertically below the shoulder midpoint based only on shoulder distance
    const inferredMidHip = { x: midShoulder.x, y: midShoulder.y + shoulderDist * (torsoConfig.hipOffsetMultiplier||1.6) };
    const dx = inferredMidHip.x - midShoulder.x, dy = inferredMidHip.y - midShoulder.y;
    const rawTorsoHeight = Math.hypot(dx,dy);
    const torsoH = Math.max(20, rawTorsoHeight * (torsoConfig.heightMultiplier||1.2));
    const torsoW = Math.max(20, shoulderDist * (torsoConfig.widthMultiplier||1.4));
    const cx = (midShoulder.x + inferredMidHip.x)/2 + (torsoConfig.centerOffsetX||0);
    const cy = (midShoulder.y + inferredMidHip.y)/2 + (torsoConfig.centerOffsetY||0);
    const angle = Math.atan2(dy,dx) + ((torsoConfig.rotationOffsetDegrees||0) * Math.PI/180);
    canvasCtx.globalAlpha = (typeof torsoConfig.alpha==='number')?torsoConfig.alpha:0.95;
    // Respect `torsoConfig.rotationOffsetDegrees` from torso.json — do not force extra rotation
    const adjTorsoAngle = (flipHorizontal ? (Math.PI - angle) : angle);
    drawImageRotated(torsoImg, cx, cy, torsoW, torsoH, adjTorsoAngle, false, false);
    canvasCtx.globalAlpha = 1.0;
  }


  // draw skeleton (optional) — arms removed
  if (showSkeleton){
    canvasCtx.lineWidth = 4; canvasCtx.lineCap = 'round';
    const drawLine = (a,b,color) => { if (a && b && a.v>0.2 && b.v>0.2){ canvasCtx.strokeStyle=color; canvasCtx.beginPath(); canvasCtx.moveTo(a.x,a.y); canvasCtx.lineTo(b.x,b.y); canvasCtx.stroke(); } };
    drawLine(pts.lShoulder, pts.rShoulder, '#ffd166');
    drawLine(pts.lShoulder, pts.lHip, '#a78bfa'); drawLine(pts.rShoulder, pts.rHip, '#a78bfa');
    drawLine(pts.lHip, pts.rHip, '#ffd166'); drawLine(pts.nose, pts.lShoulder, '#ff7ab6'); drawLine(pts.nose, pts.rShoulder, '#ff7ab6');
    const drawPt = (p) => { if (p && p.v>0.2){ canvasCtx.fillStyle='#e6eef3'; canvasCtx.beginPath(); canvasCtx.arc(p.x,p.y,6,0,Math.PI*2); canvasCtx.fill(); canvasCtx.fillStyle='#0b1220'; canvasCtx.beginPath(); canvasCtx.arc(p.x,p.y,3,0,Math.PI*2); canvasCtx.fill(); } };
    drawPt(pts.nose); drawPt(pts.lShoulder); drawPt(pts.rShoulder); drawPt(pts.lHip); drawPt(pts.rHip);
  }

  // head on top with left/right swap based on lateral nose offset
  if ((headLoaded || headLeftLoaded || headRightLoaded) && headConfig.enabled && pts.lShoulder && pts.rShoulder && showImages){
    const dx = pts.rShoulder.x - pts.lShoulder.x, dy = pts.rShoulder.y - pts.lShoulder.y; const shoulderDist = Math.hypot(dx,dy)||100;
    const headW = Math.max(20, shoulderDist * (headConfig.widthMultiplier||0.7));
    const headH = Math.max(20, headW * (headConfig.heightMultiplier||0.7));
    const useNose = pts.nose && pts.nose.v>0.2;
    // Keep head horizontally centered on shoulder midpoint to avoid lateral shift when turning.
    // Anchor vertical position to the shoulder midpoint so the head image doesn't move up/down with depth.
    // Allow `headConfig.offsetY` to be either pixels (e.g. -10) or a fraction of shoulder distance
    // (e.g. -0.2 moves the head up by 20% of shoulder distance).
    const cx = midShoulder.x + (headConfig.offsetX||0);
    const rawOffsetY = Number(headConfig.offsetY) || 0;
    let offsetYPixels;
    if (Math.abs(rawOffsetY) <= 2) {
      // fractional offset (e.g. -0.5 means -50% of shoulder distance)
      offsetYPixels = rawOffsetY * shoulderDist;
    } else {
      // pixel offset: scale it relative to the initial observed shoulder distance
      if (!_initialShoulderDist && shoulderDist > 0) _initialShoulderDist = shoulderDist;
      const base = _initialShoulderDist || shoulderDist || 1;
      const scale = shoulderDist / base;
      offsetYPixels = rawOffsetY * scale;
    }
    const cy = midShoulder.y + offsetYPixels;
    const angle = Math.atan2(dy,dx) + ((headConfig.rotationOffsetDegrees||0) * Math.PI/180);

    // choose image: prefer eye-based normalized offset (more distance-invariant)
    let chosenImg = null;
    const turnThreshold = (headConfig.turnThreshold !== undefined) ? Number(headConfig.turnThreshold) : 0.18;
    const leftEyeIdx = 2, rightEyeIdx = 5;
    const hasEyes = sm[leftEyeIdx] && sm[rightEyeIdx] && (sm[leftEyeIdx].v ?? 0) > 0.15 && (sm[rightEyeIdx].v ?? 0) > 0.15;
    if (useNose && hasEyes){
      const leftEye = sm[leftEyeIdx];
      const rightEye = sm[rightEyeIdx];
      const faceMid = (leftEye.x + rightEye.x) / 2;
      const eyeDist = Math.abs(rightEye.x - leftEye.x) || shoulderDist;
      const norm = (pts.nose.x - faceMid) / eyeDist; // negative = nose left
      if (norm < -turnThreshold && headLeftLoaded) chosenImg = headLeftImg;
      else if (norm > turnThreshold && headRightLoaded) chosenImg = headRightImg;
      else if (headLoaded) chosenImg = headImg;
    } else if (useNose){
      // fallback to shoulder-mid method
      const thresholdPx = shoulderDist * turnThreshold;
      if (pts.nose.x < midShoulder.x - thresholdPx && headLeftLoaded) chosenImg = headLeftImg;
      else if (pts.nose.x > midShoulder.x + thresholdPx && headRightLoaded) chosenImg = headRightImg;
      else if (headLoaded) chosenImg = headImg;
    } else {
      chosenImg = headLoaded? headImg : (headLeftLoaded? headLeftImg : (headRightLoaded? headRightImg : null));
    }

    if (chosenImg){
      canvasCtx.globalAlpha = (typeof headConfig.alpha==='number')?headConfig.alpha:1.0;
      const flipX = !!headConfig.flipHorizontal;
      const flipY = !!headConfig.flipVertical;
      const adjAngle = flipHorizontal ? (Math.PI - angle) : angle;
      drawImageRotated(chosenImg, cx, cy, headW, headH, adjAngle, flipX, flipY);
      canvasCtx.globalAlpha = 1.0;
    }
    // Blinking: randomized automatic blink overlay drawn on top of the head
    try{
      const now = performance.now();
      if (headConfig.blinkEnabled && blinkLoaded && showImages){
        if (typeof _nextBlinkTime === 'undefined') {
          _nextBlinkTime = now + (headConfig.blinkMinMs + Math.random()*(headConfig.blinkMaxMs - headConfig.blinkMinMs));
          _blinkEndTime = 0;
        }
        if (now >= _nextBlinkTime && now >= (_blinkEndTime||0)){
          const dur = Number(headConfig.blinkDurationMs) || 120;
          _blinkEndTime = now + dur;
          // schedule next blink (allow occasional quick double-blink)
          const doubleProb = Math.random() < 0.12;
          const nextGap = doubleProb ? 150 + Math.random()*150 : (headConfig.blinkMinMs + Math.random()*(headConfig.blinkMaxMs - headConfig.blinkMinMs));
          _nextBlinkTime = now + nextGap;
        }
        if (now < (_blinkEndTime||0)){
          canvasCtx.globalAlpha = (typeof headConfig.alpha==='number')?headConfig.alpha:1.0;
          // Prefer directional blink overlays if available and head is using left/right image
          let blinkToUse = blinkImg;
          if (chosenImg === headLeftImg && blinkLeftLoaded) blinkToUse = blinkLeftImg;
          else if (chosenImg === headRightImg && blinkRightLoaded) blinkToUse = blinkRightImg;
          // Fallback: if config provides paths and images loaded, prefer them
          else if (chosenImg === headLeftImg && headConfig.blinkLeftImage && blinkLeftLoaded) blinkToUse = blinkLeftImg;
          else if (chosenImg === headRightImg && headConfig.blinkRightImage && blinkRightLoaded) blinkToUse = blinkRightImg;
          drawImageRotated(blinkToUse, cx, cy, headW, headH, adjAngle, flipX, flipY);
          canvasCtx.globalAlpha = 1.0;
        }
      }
    }catch(e){ /* performance may be unavailable in odd contexts; ignore */ }
  }

  // lower-arm drawing removed

  // height estimate
  const midHip = {x:(pts.lHip.x+pts.rHip.x)/2, y:(pts.lHip.y+pts.rHip.y)/2, v:(pts.lHip.v+pts.rHip.v)/2};
  if (pts.nose.v>0.2 && midHip.v>0.2){ const topHalf = Math.abs(midHip.y - pts.nose.y); if (topHeightLabel) topHeightLabel.textContent = Math.round(topHalf); if (estHeightLabel) estHeightLabel.textContent = Math.round(topHalf*2.1) + ' px (approx)'; }
}

function onResults(results){ if (!videoElement.videoWidth) return; if (results.poseLandmarks) drawUpperBody(results.poseLandmarks); }

const pose = new Pose({ locateFile: file=>`https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
pose.setOptions({modelComplexity:1,enableSegmentation:false,minDetectionConfidence:0.5,minTrackingConfidence:0.5});
pose.onResults(onResults);

async function startCamera(){
  if (stream) return;
  try{
    const preferredFacing = isMobile ? 'user' : 'environment';
    const constraints = { audio: false, video: {
      width: { ideal: isMobile ? 720 : 1280 },
      height: { ideal: isMobile ? 1280 : 720 },
      facingMode: preferredFacing
    }};
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = stream;
    videoElement.playsInline = true;
    videoElement.autoplay = true;
    await videoElement.play();
    // mirror preview for front camera by default for natural selfie feel
    if (preferredFacing === 'user') { flipHorizontal = true; updateFlip(); }
    if (startBtn) startBtn.disabled = true;

    // lower model complexity on mobile for performance
    try{ pose.setOptions({modelComplexity: isMobile?0:1, enableSegmentation:false, minDetectionConfidence:0.5, minTrackingConfidence:0.5}); }catch(e){ }

    _onLoadedMetadata = ()=>{ resizeCanvasToVideo(); };
    videoElement.addEventListener('loadedmetadata', _onLoadedMetadata);
    window.addEventListener('resize', resizeCanvasToVideo);
    window.addEventListener('orientationchange', resizeCanvasToVideo);

    const loop = async ()=>{ if (videoElement.readyState>=2) await pose.send({image:videoElement}); rafId = requestAnimationFrame(loop); };
    loop();
  }catch(e){ console.error('startCamera',e); if (stream){ try{ stream.getTracks().forEach(t=>t.stop()); }catch(_){} } stream=null; }
}

function stopCamera(){
  if (!stream) return;
  try{ stream.getTracks().forEach(t=>t.stop()); }catch(e){}
  stream=null;
  if (rafId) cancelAnimationFrame(rafId); rafId=null;
  videoElement.srcObject=null;
  if (startBtn) startBtn.disabled=false;
  if (_onLoadedMetadata) videoElement.removeEventListener('loadedmetadata', _onLoadedMetadata);
  _onLoadedMetadata = null;
  window.removeEventListener('resize', resizeCanvasToVideo);
  window.removeEventListener('orientationchange', resizeCanvasToVideo);
}

if (startBtn) startBtn.addEventListener('click', async ()=>{ await startCamera(); });
if (stopBtn) stopBtn.addEventListener('click', ()=>{ stopCamera(); });
if (snapBtn) snapBtn.addEventListener('click', ()=>{
  const tmp=document.createElement('canvas'); tmp.width=canvasElement.width; tmp.height=canvasElement.height; const t=tmp.getContext('2d');
  if (flipHorizontal){
    t.save();
    t.translate(tmp.width,0);
    t.scale(-1,1);
    t.drawImage(videoElement,0,0,tmp.width,tmp.height);
    t.restore();
  } else {
    t.drawImage(videoElement,0,0,tmp.width,tmp.height);
  }
  t.drawImage(canvasElement,0,0,tmp.width,tmp.height);
  const data=tmp.toDataURL('image/png'); const a=document.createElement('a'); a.href=data; a.download='pose_snapshot.png'; a.click();
});

// Start camera when user taps/clicks the video element (mobile-friendly)
if (videoElement){
  videoElement.addEventListener('click', async ()=>{ if (!stream) await startCamera(); });
  videoElement.addEventListener('touchstart', async (e)=>{ if (!stream){ e.preventDefault(); await startCamera(); } }, {passive:false});
}

function updateCameraVisibility(){ if (showCamera){ videoElement.style.visibility='visible'; videoElement.style.opacity='1'; } else { videoElement.style.visibility='hidden'; videoElement.style.opacity='0'; } }
if (hideCameraChk){ hideCameraChk.addEventListener('change', e=>{ showCamera = !e.target.checked; updateCameraVisibility(); }); }
if (hideSkeletonChk){ hideSkeletonChk.addEventListener('change', e=>{ showSkeleton = !e.target.checked; }); }
if (hideImagesChk){ hideImagesChk.addEventListener('change', e=>{ showImages = !e.target.checked; }); }
if (disableBlinkChk){
  // Checkbox label reads "Disable Blinking" — checked = disabled
  disableBlinkChk.checked = !headConfig.blinkEnabled;
  disableBlinkChk.addEventListener('change', e=>{ headConfig.blinkEnabled = !e.target.checked; });
}

function updateFlip(){
  // flip the visible video with CSS so preview matches mirrored landmarks
  videoElement.style.transform = flipHorizontal ? 'scaleX(-1)' : 'none';
}

// flip state is managed automatically for front camera; manual flip control removed

// enable start button if present
if (startBtn) startBtn.disabled = false;
