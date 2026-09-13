// Host console: captures the host's camera, composites it (plus any approved
// guest cameras) onto a canvas, and broadcasts that composed stream to every
// viewer over its own RTCPeerConnection. Signaling is relayed through the
// Flask-SocketIO server (see backend/app.py's webrtc_signal handler) — the
// server never touches media, only forwards SDP/ICE JSON between socket ids.
// Ported from the Msanii Media reference implementation.
(function () {
  const ROOM = window.LIVE_ROOM;
  const socket = io();

  const canvas = document.getElementById("compose-canvas");
  const ctx = canvas.getContext("2d");
  const selfPreview = document.getElementById("self-preview");
  const goLiveBtn = document.getElementById("go-live-btn");
  const endLiveBtn = document.getElementById("end-live-btn");
  const camRequestsBox = document.getElementById("camera-requests");
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const statusBadge = document.getElementById("status-badge");
  const switchCameraBtn = document.getElementById("switch-camera-btn");
  const filterSelect = document.getElementById("filter-select");

  // Applied at canvas draw time, not to the raw camera feed -- this is why
  // guests get it too: everyone's tile is drawn through this same filter
  // before being broadcast, so there's nothing to apply on the guest side.
  const FILTERS = {
    none: "none",
    vivid: "saturate(1.5) contrast(1.12) brightness(1.03)",
    mono: "grayscale(1) contrast(1.1)",
    noir: "grayscale(1) contrast(1.45) brightness(0.92)",
    warm: "sepia(0.35) saturate(1.35) brightness(1.05)",
    cool: "saturate(1.15) hue-rotate(-8deg) brightness(1.02) contrast(1.05)",
    dreamy: "brightness(1.1) contrast(0.92) saturate(1.15) blur(0.4px)",
  };
  let currentFilter = filterSelect ? filterSelect.value : "vivid";
  let currentFacingMode = "user"; // "user" = front/selfie camera, "environment" = back camera

  let hostStream = null;
  let finalStream = null; // composed video (canvas) + mixed audio, sent to viewers & recorded
  let audioCtx = null;
  let mixDestination = null;
  // Every approved guest gets its own RTCPeerConnection + hidden <video> element,
  // keyed by socket id. The draw loop below tiles however many of these are
  // currently connected (plus the host) into a grid — this is what makes the
  // screen divide into two or more tiles depending on participants.
  const guestConnections = new Map(); // sid -> { pc, video, name }
  // A requester's peer connection is live (so the host can preview them)
  // before any approve/decline decision is made. Entries here are NOT drawn
  // to the canvas and their audio is NOT mixed into the broadcast -- only
  // approveGuest() promotes an entry into guestConnections, at which point it
  // starts appearing for viewers.
  const pendingGuests = new Map(); // sid -> { pc, video, name, requestId, stream }
  const viewerConnections = {}; // sid -> RTCPeerConnection (host is offerer, broadcasting finalStream)
  let mediaRecorder = null;
  let recordedChunks = [];
  let isLive = false;

  function appendChatLine(name, message) {
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `<strong>${escapeHtml(name)}</strong>${escapeHtml(message)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------- Camera + canvas compositing loop ----------------
  async function initCamera() {
    hostStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: currentFacingMode } },
      audio: true,
    });
    selfPreview.srcObject = hostStream;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    mixDestination = audioCtx.createMediaStreamDestination();
    audioCtx.createMediaStreamSource(hostStream).connect(mixDestination);

    const canvasStream = canvas.captureStream(30);
    finalStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...mixDestination.stream.getAudioTracks(),
    ]);

    drawLoop();
  }

  // Swaps the host's own camera between front/back. This never needs to touch
  // any RTCPeerConnection: what viewers actually receive is the CANVAS's
  // captured stream, and the canvas just draws whatever `selfPreview` shows
  // right now -- so re-pointing selfPreview at a new video track is the whole
  // fix. The mic (and the AudioContext node already wired to it) is left
  // completely alone.
  async function switchCamera() {
    if (!hostStream) return;
    const nextFacing = currentFacingMode === "user" ? "environment" : "user";
    switchCameraBtn.disabled = true;
    try {
      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacing } },
      });
      const newTrack = newVideoStream.getVideoTracks()[0];
      const oldTrack = hostStream.getVideoTracks()[0];
      hostStream.removeTrack(oldTrack);
      oldTrack.stop();
      hostStream.addTrack(newTrack);
      selfPreview.srcObject = hostStream; // re-assign so the element notices the swap
      currentFacingMode = nextFacing;
    } catch (err) {
      alert("Couldn't switch camera: " + err.message);
    } finally {
      switchCameraBtn.disabled = false;
    }
  }
  switchCameraBtn.onclick = switchCamera;

  if (filterSelect) {
    filterSelect.onchange = () => { currentFilter = filterSelect.value; };
  }

  // "Cover"-style draw (like CSS object-fit: cover): fills the target cell
  // without squishing the source video's aspect ratio, cropping instead.
  function drawCover(videoEl, x, y, w, h) {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale, sh = h / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.drawImage(videoEl, sx, sy, sw, sh, x, y, w, h);
  }

  function drawLoop() {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Tile 0 is always the host. Every connected guest adds another tile —
    // the grid reflows live as people join or leave, no fixed layout.
    const tiles = [{ el: selfPreview, name: window.HOST_NAME || "Host" }];
    guestConnections.forEach((g) => tiles.push({ el: g.video, name: g.name || "Guest" }));

    const total = tiles.length;
    const cols = Math.ceil(Math.sqrt(total));
    const rows = Math.ceil(total / cols);
    const cellW = canvas.width / cols;
    const cellH = canvas.height / rows;

    tiles.forEach((tile, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cellW;
      const y = row * cellH;
      if (tile.el.readyState >= 2) {
        ctx.save();
        ctx.filter = FILTERS[currentFilter] || "none";
        drawCover(tile.el, x, y, cellW, cellH);
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = i === 0 ? "rgba(255,255,255,0.25)" : "#c8102e";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
      ctx.font = "16px sans-serif";
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      const labelW = ctx.measureText(tile.name).width + 16;
      ctx.fillRect(x + 8, y + cellH - 32, labelW, 24);
      ctx.fillStyle = "#fff";
      ctx.fillText(tile.name, x + 16, y + cellH - 14);
      ctx.restore();
    });

    requestAnimationFrame(drawLoop);
  }

  // ---------------- Broadcasting to viewers ----------------
  function createViewerConnection(viewerSid) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    finalStream.getTracks().forEach((track) => pc.addTrack(track, finalStream));
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("webrtc_signal", { to: viewerSid, kind: "broadcast", type: "ice", candidate: e.candidate });
      }
    };
    viewerConnections[viewerSid] = pc;
    pc.createOffer().then((offer) => {
      pc.setLocalDescription(offer);
      socket.emit("webrtc_signal", { to: viewerSid, kind: "broadcast", type: "offer", sdp: offer });
    });
    return pc;
  }

  // ---------------- Guest cameras (viewer -> host), one connection per guest ----------------
  // The peer connection is established as soon as a request comes in, NOT on
  // approval -- this is what lets the host actually see/hear the requester
  // (via the visible preview video in the request row) before deciding.
  // Nothing here reaches viewers yet: the video element isn't drawn by
  // drawLoop and the audio isn't wired into mixDestination until approveGuest()
  // promotes the entry into guestConnections.
  function handleGuestOffer(fromSid, sdp, name, requestId) {
    if (pendingGuests.has(fromSid) || guestConnections.has(fromSid)) return; // duplicate offer, ignore

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false; // host can hear the requester too while deciding

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("webrtc_signal", { to: fromSid, kind: "guest", type: "ice", candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0];
      const entry = pendingGuests.get(fromSid) || guestConnections.get(fromSid);
      if (entry) entry.stream = e.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        removeAnyGuest(fromSid);
      }
    };

    pendingGuests.set(fromSid, { pc, video, name, requestId });

    pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(() => {
      return pc.createAnswer();
    }).then((answer) => {
      pc.setLocalDescription(answer);
      socket.emit("webrtc_signal", { to: fromSid, kind: "guest", type: "guest-answer", sdp: answer });
    });

    renderCameraRequestRow(fromSid, name, requestId, video);
  }

  // Host clicked "Approve": the connection is already live, so this just
  // promotes it into the set drawLoop composites and wires its audio into the
  // broadcast mix -- nothing needs to be renegotiated.
  function approveGuest(sid) {
    const entry = pendingGuests.get(sid);
    if (!entry) return;
    pendingGuests.delete(sid);
    entry.video.style.display = "none";
    document.body.appendChild(entry.video); // keep playing, out of the (removed) request row
    if (entry.stream) {
      audioCtx.createMediaStreamSource(entry.stream).connect(mixDestination);
    }
    guestConnections.set(sid, { pc: entry.pc, video: entry.video, name: entry.name });
  }

  // Host clicked "Deny": tear down the preview connection. Nothing was ever
  // broadcast, so there's nothing else to undo.
  function declineGuest(sid) {
    const entry = pendingGuests.get(sid);
    if (!entry) return;
    pendingGuests.delete(sid);
    try { entry.pc.close(); } catch (e) { /* already closed */ }
  }

  function removeGuest(sid) {
    const g = guestConnections.get(sid);
    if (!g) return;
    try { g.pc.close(); } catch (e) { /* already closed */ }
    if (g.video.parentNode) g.video.parentNode.removeChild(g.video);
    guestConnections.delete(sid);
  }

  // Connection dropped before a decision was ever made (pending) vs. after
  // approval (already live in the broadcast) need different cleanup.
  function removeAnyGuest(sid) {
    if (pendingGuests.has(sid)) {
      const entry = pendingGuests.get(sid);
      pendingGuests.delete(sid);
      try { entry.pc.close(); } catch (e) { /* already closed */ }
      const row = document.getElementById(`cam-req-${sid}`);
      if (row) row.remove();
    } else {
      removeGuest(sid);
    }
  }

  function renderCameraRequestRow(sid, name, requestId, videoEl) {
    const row = document.createElement("div");
    row.className = "camera-request-row";
    row.id = `cam-req-${sid}`;

    videoEl.className = "camera-preview-video";
    row.appendChild(videoEl);

    const info = document.createElement("span");
    info.className = "camera-request-info";
    info.innerHTML = `&#127909; <strong>${escapeHtml(name)}</strong> wants to join on camera`;
    row.appendChild(info);

    const actions = document.createElement("span");
    actions.className = "actions";

    const approveBtn = document.createElement("button");
    approveBtn.className = "btn btn-red btn-sm";
    approveBtn.textContent = "Approve";
    approveBtn.onclick = () => {
      socket.emit("respond_camera", { room: ROOM, request_id: requestId, approve: true });
      approveGuest(sid);
      row.remove();
    };

    const denyBtn = document.createElement("button");
    denyBtn.className = "btn btn-outline btn-sm";
    denyBtn.textContent = "Deny";
    denyBtn.style.marginLeft = "6px";
    denyBtn.onclick = () => {
      socket.emit("respond_camera", { room: ROOM, request_id: requestId, approve: false });
      declineGuest(sid);
      row.remove();
    };

    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    row.appendChild(actions);
    camRequestsBox.appendChild(row);
  }

  // ---------------- Socket events ----------------
  socket.on("connect", () => {
    socket.emit("join_room", { room: ROOM, role: "host", name: window.HOST_NAME });
  });

  socket.on("presence", (data) => {
    if (data.role === "viewer" && isLive && finalStream && data.sid && !viewerConnections[data.sid]) {
      createViewerConnection(data.sid);
    }
  });

  socket.on("webrtc_signal", (data) => {
    if (data.kind === "broadcast" && data.type === "answer") {
      const pc = viewerConnections[data.from];
      if (pc) pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.kind === "broadcast" && data.type === "ice") {
      const pc = viewerConnections[data.from];
      if (pc) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    } else if (data.kind === "guest" && data.type === "ice") {
      const entry = pendingGuests.get(data.from) || guestConnections.get(data.from);
      if (entry) entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  });

  socket.on("chat_history", (data) => {
    chatMessages.innerHTML = "";
    (data.messages || []).forEach((m) => appendChatLine(m.sender_name, m.message));
  });
  socket.on("chat_message", (data) => appendChatLine(data.name, data.message));

  socket.on("camera_offer", (data) => {
    handleGuestOffer(data.socket_id, data.sdp, data.name, data.request_id);
  });

  // ---------------- Controls ----------------
  chatSend.onclick = sendChat;
  chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  function sendChat() {
    const message = chatInput.value.trim();
    if (!message) return;
    socket.emit("chat_message", { room: ROOM, name: window.HOST_NAME, message });
    chatInput.value = "";
  }

  goLiveBtn.onclick = async () => {
    goLiveBtn.disabled = true;
    goLiveBtn.textContent = "Starting…";
    try {
      if (!hostStream) await initCamera();
      isLive = true;
      socket.emit("host_go_live", { room: ROOM });
      statusBadge.textContent = "LIVE";
      statusBadge.className = "status-badge live";
      goLiveBtn.style.display = "none";
      endLiveBtn.disabled = false;

      recordedChunks = [];
      mediaRecorder = new MediaRecorder(finalStream, { mimeType: "video/webm;codecs=vp8,opus" });
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.start(1000);
    } catch (err) {
      alert("Couldn't access camera/microphone: " + err.message);
      goLiveBtn.disabled = false;
      goLiveBtn.textContent = "▶ Go Live";
    }
  };

  endLiveBtn.onclick = async () => {
    endLiveBtn.disabled = true;
    endLiveBtn.textContent = "Saving…";
    isLive = false;
    socket.emit("host_end_live", { room: ROOM });
    statusBadge.textContent = "ENDED";
    statusBadge.className = "status-badge ended";
    Object.values(viewerConnections).forEach((pc) => pc.close());
    Array.from(guestConnections.keys()).forEach(removeGuest);
    Array.from(pendingGuests.keys()).forEach(declineGuest);
    camRequestsBox.innerHTML = "";

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      await new Promise((resolve) => {
        mediaRecorder.onstop = resolve;
        mediaRecorder.stop();
      });
    }
    if (recordedChunks.length) {
      const blob = new Blob(recordedChunks, { type: "video/webm" });
      const formData = new FormData();
      formData.append("recording", blob, "recording.webm");
      try {
        await fetch(`/live/${ROOM}/upload-recording`, { method: "POST", body: formData });
        endLiveBtn.textContent = "Saved ✓";
      } catch (e) {
        endLiveBtn.textContent = "Save failed";
      }
    } else {
      endLiveBtn.textContent = "Ended";
    }
  };
})();
