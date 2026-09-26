// Viewer page: receives the host's composed broadcast over WebRTC, shows
// live chat, and lets a viewer ask to join on camera. The viewer's own
// RTCPeerConnection to the host (see live-host.js's handleGuestOffer) is
// established immediately on request, NOT after approval -- this is what
// lets the host actually preview the requester's live camera/mic before
// deciding. Nothing reaches other viewers until the host approves; declining
// just tears this preview connection back down. Ported from the Msanii Media
// reference implementation.
(function () {
  const ROOM = window.LIVE_ROOM;
  const socket = io();

  const hostVideo = document.getElementById("host-video");
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const requestBtn = document.getElementById("request-camera-btn");
  const cameraStatus = document.getElementById("camera-status");
  const nameModal = document.getElementById("name-modal");
  const nameInput = document.getElementById("name-input");
  const nameSubmit = document.getElementById("name-submit");
  const statusBadge = document.getElementById("status-badge");
  const switchCameraBtn = document.getElementById("switch-camera-btn");
  const waitingOverlay = document.getElementById("waiting-overlay");

  let myName = sessionStorage.getItem("ks_viewer_name") || "";
  let broadcastPc = null;
  let hostSid = null;
  let guestPc = null;
  let localGuestStream = null;
  let guestFacingMode = "user";
  let pendingGuestIce = []; // ICE candidates generated before we learn the host's sid
  let connectionWatchdog = null; // see startConnectionWatchdog() below
  // True from the moment a camera-join request is sent until it's approved
  // or declined. Real bug this fixes: Socket.IO gives you a brand new sid on
  // every reconnect (screen lock, app backgrounding, a network blip -- all
  // routine on mobile), but the server stores the REQUESTING sid once, at
  // request time, in camera_requests.socket_id. If the socket reconnects
  // before the host clicks Approve, the eventual camera_response gets sent
  // to a socket that no longer exists -- the request silently goes nowhere,
  // with nothing on screen ever indicating why. Same problem hits the guest
  // RTCPeerConnection's signaling (ICE candidates are routed by sid too), so
  // even an already-progressing connection breaks the moment the socket
  // reconnects mid-handshake. This was previously not handled at all: this
  // page had no socket.on("connect") handler, so after any reconnect it
  // silently stopped being in the room too (no more chat/live_status).
  let awaitingCameraApproval = false;
  let hasConnectedBefore = false;

  // The overlay text used to only ever get RE-SHOWN (never updated or cleared)
  // outside of ontrack firing, so a viewer could see the badge correctly say
  // LIVE while the video area was stuck on stale "waiting for host" text --
  // and if WebRTC never connected (no TURN server configured, so anyone
  // behind a restrictive NAT can fail silently), there was zero feedback,
  // forever. setOverlay/hideOverlay + the watchdog below fix both.
  function setOverlay(text, opts) {
    if (!waitingOverlay) return;
    waitingOverlay.textContent = text;
    waitingOverlay.classList.toggle("error", !!(opts && opts.error));
    waitingOverlay.classList.remove("hidden");
  }
  function hideOverlay() {
    if (!waitingOverlay) return;
    waitingOverlay.classList.add("hidden");
  }
  function clearConnectionWatchdog() {
    if (connectionWatchdog) { clearTimeout(connectionWatchdog); connectionWatchdog = null; }
  }
  // If we haven't received actual video frames (ontrack) within ~15s of
  // expecting a live broadcast -- whether because ICE outright failed or
  // it's just stuck in "checking"/"connecting" -- stop leaving the viewer
  // staring at silent unchanging text and tell them something's wrong.
  function startConnectionWatchdog() {
    clearConnectionWatchdog();
    connectionWatchdog = setTimeout(() => {
      if (!hostVideo.srcObject) {
        setOverlay("Having trouble connecting to the stream — try refreshing.", { error: true });
      }
    }, 15000);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function appendChatLine(name, message) {
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `<strong>${escapeHtml(name)}</strong>${escapeHtml(message)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function joinRoom() {
    nameModal.style.display = "none";
    socket.emit("join_room", { room: ROOM, role: "viewer", name: myName });
  }

  if (myName) {
    joinRoom();
  } else {
    nameSubmit.onclick = () => {
      const v = nameInput.value.trim();
      if (!v) return;
      myName = v;
      sessionStorage.setItem("ks_viewer_name", v);
      joinRoom();
    };
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") nameSubmit.click(); });
  }

  // socket.io-client reconnects automatically after a drop, but a reconnect
  // is a NEW socket with a NEW sid on the server -- nothing about being "in"
  // the room or an in-flight request survives that on its own. Re-join on
  // every connection (first one included, harmlessly redundant with the
  // block above) and, if a camera-join request was in flight, redo it from
  // scratch so it's addressed to the server correctly this time.
  socket.on("connect", () => {
    if (!hasConnectedBefore) { hasConnectedBefore = true; return; }
    if (myName) joinRoom();
    if (awaitingCameraApproval && localGuestStream) {
      cameraStatus.textContent = "Reconnected — resending your camera request…";
      if (guestPc) { try { guestPc.close(); } catch (e) { /* already closed */ } guestPc = null; }
      hostSid = null;
      pendingGuestIce = [];
      startGuestConnection();
    }
  });

  socket.on("chat_history", (data) => {
    chatMessages.innerHTML = "";
    (data.messages || []).forEach((m) => appendChatLine(m.sender_name, m.message));
  });
  socket.on("chat_message", (data) => appendChatLine(data.name, data.message));

  socket.on("live_status", (data) => {
    statusBadge.textContent = data.status.toUpperCase();
    statusBadge.className = "status-badge " + data.status;
    if (data.status === "live") {
      setOverlay("Host is live — connecting video…");
      startConnectionWatchdog();
    } else if (data.status === "ended") {
      clearConnectionWatchdog();
      setOverlay("This broadcast has ended.");
      // Host ended the session -- nothing left to share, so stop holding
      // the guest's phone screen awake.
      releaseWakeLock();
    } else {
      clearConnectionWatchdog();
      setOverlay("Waiting for the host to go live…");
      // Host hasn't started (or session isn't live) -- nothing left to
      // share, so stop holding the guest's phone screen awake.
      releaseWakeLock();
    }
  });

  // If the room was already live when this page loaded, we won't get a
  // live_status event at all (the server only emits it on the go-live/end
  // transition, not to newly-joined sockets) -- so start the watchdog here
  // too, from the status baked into the initial render.
  if (window.LIVE_STATUS === "live") startConnectionWatchdog();

  // ---------------- Receiving the host's broadcast ----------------
  socket.on("webrtc_signal", (data) => {
    if (data.kind === "broadcast" && data.type === "offer") {
      hostSid = data.from;
      broadcastPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      broadcastPc.ontrack = (e) => {
        hostVideo.srcObject = e.streams[0];
        hideOverlay();
        clearConnectionWatchdog();
      };
      broadcastPc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("webrtc_signal", { to: hostSid, kind: "broadcast", type: "ice", candidate: e.candidate });
        }
      };
      // Belt-and-suspenders on top of the 15s watchdog: an explicit "failed"
      // ICE state is a stronger signal than a timeout and can fire sooner.
      broadcastPc.oniceconnectionstatechange = () => {
        if (broadcastPc.iceConnectionState === "failed" && !hostVideo.srcObject) {
          clearConnectionWatchdog();
          setOverlay("Having trouble connecting to the stream — try refreshing.", { error: true });
        }
      };
      startConnectionWatchdog();
      broadcastPc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
        return broadcastPc.createAnswer();
      }).then((answer) => {
        broadcastPc.setLocalDescription(answer);
        socket.emit("webrtc_signal", { to: hostSid, kind: "broadcast", type: "answer", sdp: answer });
      });
    } else if (data.kind === "broadcast" && data.type === "ice") {
      if (broadcastPc) broadcastPc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    } else if (data.kind === "guest" && data.type === "guest-answer") {
      if (guestPc) {
        guestPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (!hostSid) hostSid = data.from;
        if (pendingGuestIce.length) {
          pendingGuestIce.forEach((c) => socket.emit("webrtc_signal", { to: hostSid, kind: "guest", type: "ice", candidate: c }));
          pendingGuestIce = [];
        }
      }
    } else if (data.kind === "guest" && data.type === "ice") {
      if (guestPc) guestPc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  });

  // iOS Safari (and most mobile browsers) will dim then lock the screen on
  // its normal auto-lock timer even while a page is actively using the
  // camera -- once the screen locks, WebKit suspends the page and the
  // camera stream/WebRTC connection dies with it. The fix is the standard
  // Screen Wake Lock API (supported iOS Safari 16.4+): hold a lock for as
  // long as the person is sharing their camera (pending approval OR already
  // approved), release it the moment they stop sharing for any reason. A
  // wake lock is auto-released by the browser whenever the tab is
  // backgrounded/hidden, so it must be explicitly re-acquired on
  // visibilitychange if we're still supposed to be holding it.
  let wakeLock = null;
  let wantWakeLock = false;

  async function acquireWakeLock() {
    wantWakeLock = true;
    if (!("wakeLock" in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (e) {
      // Not supported, or denied (e.g. Low Power Mode) -- nothing else we
      // can do client-side; the camera still works, it just may sleep.
    }
  }

  function releaseWakeLock() {
    wantWakeLock = false;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wantWakeLock) acquireWakeLock();
  });

  // ---------------- Asking to join on camera ----------------
  requestBtn.onclick = async () => {
    requestBtn.disabled = true;
    cameraStatus.textContent = "Requesting access to your camera…";
    try {
      localGuestStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: guestFacingMode } },
        audio: true,
      });
    } catch (e) {
      cameraStatus.textContent = "Camera/mic access denied.";
      requestBtn.disabled = false;
      return;
    }
    acquireWakeLock();
    cameraStatus.textContent = "Connecting so the host can preview you…";
    awaitingCameraApproval = true;
    startGuestConnection();
  };

  socket.on("camera_response", (data) => {
    awaitingCameraApproval = false;
    if (!data.approve) {
      cameraStatus.textContent = "The host declined your request to join.";
      requestBtn.disabled = false;
      releaseWakeLock();
      if (guestPc) { try { guestPc.close(); } catch (e) { /* already closed */ } guestPc = null; }
      if (localGuestStream) { localGuestStream.getTracks().forEach((t) => t.stop()); localGuestStream = null; }
      return;
    }
    cameraStatus.textContent = "You're live! The host can now see and hear you.";
    if (switchCameraBtn) switchCameraBtn.classList.remove("hidden");
  });

  // Unlike the host's own camera (which only feeds a canvas the host redraws
  // locally), this stream is sent directly over guestPc -- so switching the
  // camera here means replacing the actual outgoing track on the connection,
  // not just swapping what a <video> element shows.
  if (switchCameraBtn) {
    switchCameraBtn.onclick = async () => {
      if (!guestPc || !localGuestStream) return;
      const nextFacing = guestFacingMode === "user" ? "environment" : "user";
      switchCameraBtn.disabled = true;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: nextFacing } },
        });
        const newTrack = newStream.getVideoTracks()[0];
        const sender = guestPc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) await sender.replaceTrack(newTrack);
        const oldTrack = localGuestStream.getVideoTracks()[0];
        localGuestStream.removeTrack(oldTrack);
        oldTrack.stop();
        localGuestStream.addTrack(newTrack);
        guestFacingMode = nextFacing;
      } catch (err) {
        alert("Couldn't switch camera: " + err.message);
      } finally {
        switchCameraBtn.disabled = false;
      }
    };
  }

  function startGuestConnection() {
    guestPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    localGuestStream.getTracks().forEach((track) => guestPc.addTrack(track, localGuestStream));
    guestPc.onicecandidate = (e) => {
      if (!e.candidate) return;
      // We may not know the host's sid yet (it arrives on the guest-answer,
      // not before) -- buffer until then instead of dropping candidates.
      if (hostSid) {
        socket.emit("webrtc_signal", { to: hostSid, kind: "guest", type: "ice", candidate: e.candidate });
      } else {
        pendingGuestIce.push(e.candidate);
      }
    };
    guestPc.createOffer().then((offer) => {
      guestPc.setLocalDescription(offer);
      socket.emit("camera_offer", { room: ROOM, name: myName, sdp: offer });
    });
  }

  chatSend.onclick = sendChat;
  chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  function sendChat() {
    const message = chatInput.value.trim();
    if (!message || !myName) return;
    socket.emit("chat_message", { room: ROOM, name: myName, message });
    chatInput.value = "";
  }
})();
