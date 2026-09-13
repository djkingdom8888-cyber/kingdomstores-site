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

  let hostStream = null;
  let finalStream = null; // composed video (canvas) + mixed audio, sent to viewers & recorded
  let audioCtx = null;
  let mixDestination = null;
  // Every approved guest gets its own RTCPeerConnection + hidden <video> element,
  // keyed by socket id. The draw loop below tiles however many of these are
  // currently connected (plus the host) into a grid — this is what makes the
  // screen divide into two or more tiles depending on participants.
  const guestConnections = new Map(); // sid -> { pc, video, name }
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
    hostStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
        drawCover(tile.el, x, y, cellW, cellH);
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
  function handleGuestOffer(fromSid, sdp, name) {
    if (guestConnections.has(fromSid)) return; // duplicate offer, ignore

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;
    video.style.display = "none";
    document.body.appendChild(video);

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("webrtc_signal", { to: fromSid, kind: "guest", type: "ice", candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0];
      audioCtx.createMediaStreamSource(e.streams[0]).connect(mixDestination);
    };
    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        removeGuest(fromSid);
      }
    };

    guestConnections.set(fromSid, { pc, video, name });

    pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(() => {
      return pc.createAnswer();
    }).then((answer) => {
      pc.setLocalDescription(answer);
      socket.emit("webrtc_signal", { to: fromSid, kind: "guest", type: "guest-answer", sdp: answer });
    });
  }

  function removeGuest(sid) {
    const g = guestConnections.get(sid);
    if (!g) return;
    try { g.pc.close(); } catch (e) { /* already closed */ }
    if (g.video.parentNode) g.video.parentNode.removeChild(g.video);
    guestConnections.delete(sid);
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
    } else if (data.kind === "guest" && data.type === "guest-offer") {
      handleGuestOffer(data.from, data.sdp, data.name);
    } else if (data.kind === "guest" && data.type === "ice") {
      const g = guestConnections.get(data.from);
      if (g) g.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  });

  socket.on("chat_history", (data) => {
    chatMessages.innerHTML = "";
    (data.messages || []).forEach((m) => appendChatLine(m.sender_name, m.message));
  });
  socket.on("chat_message", (data) => appendChatLine(data.name, data.message));

  socket.on("camera_request", (data) => {
    const row = document.createElement("div");
    row.className = "camera-request-row";
    row.innerHTML = `<span>&#127909; <strong>${escapeHtml(data.name)}</strong> wants to join on camera</span>`;
    const approveBtn = document.createElement("button");
    approveBtn.className = "btn btn-red btn-sm";
    approveBtn.textContent = "Approve";
    approveBtn.onclick = () => {
      socket.emit("respond_camera", { room: ROOM, request_id: data.request_id, approve: true });
      row.remove();
    };
    const denyBtn = document.createElement("button");
    denyBtn.className = "btn btn-outline btn-sm";
    denyBtn.textContent = "Deny";
    denyBtn.style.marginLeft = "6px";
    denyBtn.onclick = () => {
      socket.emit("respond_camera", { room: ROOM, request_id: data.request_id, approve: false });
      row.remove();
    };
    const actions = document.createElement("span");
    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    row.appendChild(actions);
    camRequestsBox.appendChild(row);
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
