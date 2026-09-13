// Viewer page: receives the host's composed broadcast over WebRTC, shows
// live chat, and lets a viewer ask to join on camera — if the host approves,
// this becomes a second, separate RTCPeerConnection sending the viewer's own
// camera INTO the host (see live-host.js's handleGuestOffer). Request-then-
// approve, never host-initiated invites. Ported from the Msanii Media
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

  let myName = sessionStorage.getItem("ks_viewer_name") || "";
  let broadcastPc = null;
  let hostSid = null;
  let guestPc = null;
  let localGuestStream = null;
  let guestFacingMode = "user";

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

  socket.on("chat_history", (data) => {
    chatMessages.innerHTML = "";
    (data.messages || []).forEach((m) => appendChatLine(m.sender_name, m.message));
  });
  socket.on("chat_message", (data) => appendChatLine(data.name, data.message));

  socket.on("live_status", (data) => {
    statusBadge.textContent = data.status.toUpperCase();
    statusBadge.className = "status-badge " + data.status;
  });

  // ---------------- Receiving the host's broadcast ----------------
  socket.on("webrtc_signal", (data) => {
    if (data.kind === "broadcast" && data.type === "offer") {
      hostSid = data.from;
      broadcastPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      broadcastPc.ontrack = (e) => { hostVideo.srcObject = e.streams[0]; };
      broadcastPc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("webrtc_signal", { to: hostSid, kind: "broadcast", type: "ice", candidate: e.candidate });
        }
      };
      broadcastPc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
        return broadcastPc.createAnswer();
      }).then((answer) => {
        broadcastPc.setLocalDescription(answer);
        socket.emit("webrtc_signal", { to: hostSid, kind: "broadcast", type: "answer", sdp: answer });
      });
    } else if (data.kind === "broadcast" && data.type === "ice") {
      if (broadcastPc) broadcastPc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    } else if (data.kind === "guest" && data.type === "guest-answer") {
      if (guestPc) guestPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.kind === "guest" && data.type === "ice") {
      if (guestPc) guestPc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
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
    cameraStatus.textContent = "Waiting for the host to approve your request…";
    socket.emit("request_camera", { room: ROOM, name: myName });
  };

  socket.on("camera_response", (data) => {
    if (!data.approve) {
      cameraStatus.textContent = "The host declined your request to join.";
      requestBtn.disabled = false;
      if (localGuestStream) localGuestStream.getTracks().forEach((t) => t.stop());
      return;
    }
    cameraStatus.textContent = "You're live! The host can now see and hear you.";
    if (switchCameraBtn) switchCameraBtn.classList.remove("hidden");
    startGuestConnection(data.host_sid);
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

  function startGuestConnection(hostSidForGuest) {
    guestPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    localGuestStream.getTracks().forEach((track) => guestPc.addTrack(track, localGuestStream));
    guestPc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("webrtc_signal", { to: hostSidForGuest, kind: "guest", type: "ice", candidate: e.candidate });
      }
    };
    guestPc.createOffer().then((offer) => {
      guestPc.setLocalDescription(offer);
      socket.emit("webrtc_signal", { to: hostSidForGuest, kind: "guest", type: "guest-offer", sdp: offer, name: myName });
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
