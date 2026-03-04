/* =====================================================
   meetTogether — WebRTC + Socket.io client
   ===================================================== */

// ---- Parse URL params ----
const params = new URLSearchParams(window.location.search);
const ROOM_ID = params.get('room') || 'default';
const USER_NAME = params.get('name') || 'Guest';

// ---- ICE / STUN config ----
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ---- State ----
let localStream = null;
let screenStream = null;
let isAudioMuted = false;
let isVideoOff = false;
let isScreenSharing = false;
let isChatOpen = false;
let unreadMessages = 0;
let callStartTime = null;
let timerInterval = null;

// peerId -> RTCPeerConnection
const peers = {};
// peerId -> { name, videoEl, tileEl }
const peerMeta = {};

// ---- DOM refs ----
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');
const localNameLabel = document.getElementById('local-name-label');
const localBadges = document.getElementById('local-badges');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatBadge = document.getElementById('chat-badge');
const chatSidebar = document.getElementById('chat-sidebar');
const participantCount = document.getElementById('participant-count');
const connectionStatus = document.getElementById('connection-status');
const permOverlay = document.getElementById('perm-overlay');
const copyBtn = document.getElementById('copy-btn');
const roomNameDisplay = document.getElementById('room-name-display');

// ---- Socket.io ----
const socket = io();

// =====================================================
// Initialization
// =====================================================

async function init() {
  // Update header
  roomNameDisplay.textContent = ROOM_ID;
  localNameLabel.textContent = USER_NAME + ' (You)';

  // Set page title
  document.title = `${ROOM_ID} — meetTogether`;

  // Get local media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    localVideo.srcObject = localStream;
  } catch (err) {
    console.warn('Could not get user media:', err);
    // Join without media — show overlay briefly then hide
    permOverlay.classList.remove('hidden');
    return;
  }

  // Join the room
  socket.emit('join-room', ROOM_ID, USER_NAME);
  startTimer();
  updateGridLayout();
}

// Allow joining without camera/mic
window.joinWithoutMedia = function () {
  permOverlay.classList.add('hidden');
  localStream = new MediaStream(); // empty stream
  socket.emit('join-room', ROOM_ID, USER_NAME);
  startTimer();
  updateGridLayout();
};

// =====================================================
// Socket.io Events
// =====================================================

socket.on('connect', () => {
  setStatus('connected', 'Connected');
});

socket.on('disconnect', () => {
  setStatus('error', 'Disconnected');
});

// Server sends us the list of users already in the room
socket.on('existing-users', (users) => {
  users.forEach(({ id, name }) => {
    // We are the newcomer — they will send us offers after receiving user-connected
    // Just register their meta; peer connection created when offer arrives
    peerMeta[id] = { name };
  });
});

// A new user joined — we (existing user) initiate the offer
socket.on('user-connected', async (peerId, peerName) => {
  peerMeta[peerId] = { name: peerName };
  await createPeerConnection(peerId, true); // true = we are the initiator
  updateGridLayout();
});

// A user left
socket.on('user-disconnected', (peerId) => {
  removePeer(peerId);
  updateGridLayout();
});

// Receive an offer (we are the responder)
socket.on('offer', async (offer, fromId) => {
  if (!peers[fromId]) {
    await createPeerConnection(fromId, false);
  }
  const pc = peers[fromId];
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', answer, fromId);
});

// Receive an answer (we sent the offer earlier)
socket.on('answer', async (answer, fromId) => {
  const pc = peers[fromId];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

// Receive ICE candidate
socket.on('ice-candidate', async (candidate, fromId) => {
  const pc = peers[fromId];
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      // Ignore benign ICE errors
    }
  }
});

// Chat message
socket.on('chat-message', ({ userId, name, message, timestamp }) => {
  const isSelf = userId === socket.id;
  appendChatMessage(name, message, timestamp, isSelf);
  if (!isChatOpen && !isSelf) {
    unreadMessages++;
    chatBadge.textContent = unreadMessages;
    chatBadge.classList.remove('hidden');
  }
});

// =====================================================
// WebRTC Peer Connections
// =====================================================

async function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[peerId] = pc;

  // Add local tracks to the connection
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  // ICE candidate → send to peer
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', event.candidate, peerId);
    }
  };

  // Remote track arrives → show in video grid
  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (peerMeta[peerId] && peerMeta[peerId].videoEl) {
      peerMeta[peerId].videoEl.srcObject = stream;
    } else {
      addRemoteVideoTile(peerId, stream);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      removePeer(peerId);
      updateGridLayout();
    }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', offer, peerId);
  }

  return pc;
}

function removePeer(peerId) {
  if (peers[peerId]) {
    peers[peerId].close();
    delete peers[peerId];
  }
  if (peerMeta[peerId] && peerMeta[peerId].tileEl) {
    peerMeta[peerId].tileEl.remove();
  }
  delete peerMeta[peerId];
  updateParticipantCount();
}

// =====================================================
// Video Tile Management
// =====================================================

function addRemoteVideoTile(peerId, stream) {
  const name = (peerMeta[peerId] && peerMeta[peerId].name) || 'Guest';

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${peerId}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsinline = true;
  video.srcObject = stream;

  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar hidden';
  avatar.textContent = name.charAt(0).toUpperCase();

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.innerHTML = `<span>${escapeHtml(name)}</span><span class="tile-badges" id="badges-${peerId}"></span>`;

  tile.appendChild(video);
  tile.appendChild(avatar);
  tile.appendChild(label);
  videoGrid.appendChild(tile);

  if (!peerMeta[peerId]) peerMeta[peerId] = {};
  peerMeta[peerId].videoEl = video;
  peerMeta[peerId].tileEl = tile;
  peerMeta[peerId].avatarEl = avatar;

  updateParticipantCount();
}

function updateGridLayout() {
  updateParticipantCount();
}

function updateParticipantCount() {
  const total = 1 + Object.keys(peerMeta).filter((id) => peerMeta[id].tileEl).length;
  participantCount.textContent = total === 1 ? '1 participant' : `${total} participants`;
}

// =====================================================
// Controls
// =====================================================

window.toggleAudio = function () {
  if (!localStream) return;
  isAudioMuted = !isAudioMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isAudioMuted));

  const btn = document.getElementById('mic-btn');
  const label = document.getElementById('mic-label');
  const icon = document.getElementById('mic-icon');

  if (isAudioMuted) {
    btn.classList.add('muted');
    label.textContent = 'Unmute';
    icon.textContent = '🔇';
    showLocalBadge('mic-muted', '🔇');
  } else {
    btn.classList.remove('muted');
    label.textContent = 'Mute';
    icon.textContent = '🎙';
    removeLocalBadge('mic-muted');
  }
};

window.toggleVideo = function () {
  if (!localStream) return;
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach((t) => (t.enabled = !isVideoOff));

  const btn = document.getElementById('cam-btn');
  const label = document.getElementById('cam-label');
  const icon = document.getElementById('cam-icon');
  const localTile = document.getElementById('local-tile');
  const avatar = localTile.querySelector('.tile-avatar') || createLocalAvatar(localTile);

  if (isVideoOff) {
    btn.classList.add('muted');
    label.textContent = 'Start Video';
    icon.textContent = '📵';
    localVideo.classList.add('hidden');
    avatar.classList.remove('hidden');
  } else {
    btn.classList.remove('muted');
    label.textContent = 'Stop Video';
    icon.textContent = '📹';
    localVideo.classList.remove('hidden');
    avatar.classList.add('hidden');
  }
};

function createLocalAvatar(tile) {
  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar hidden';
  avatar.textContent = USER_NAME.charAt(0).toUpperCase();
  tile.insertBefore(avatar, tile.querySelector('.tile-label'));
  return avatar;
}

window.toggleScreenShare = async function () {
  const btn = document.getElementById('screen-btn');
  const label = document.getElementById('screen-label');
  const icon = document.getElementById('screen-icon');

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true,
      });
    } catch (err) {
      console.warn('Screen share cancelled or denied:', err);
      return;
    }

    const screenTrack = screenStream.getVideoTracks()[0];

    // Replace video track in all peer connections
    Object.values(peers).forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack);
    });

    // Show a placeholder on the local tile instead of the screen itself
    const localVid = document.getElementById('local-tile').querySelector('video');
    localVid.classList.add('hidden');
    showScreenShareIndicator();

    isScreenSharing = true;
    btn.classList.add('active');
    label.textContent = 'Stop Share';
    icon.textContent = '🖥';

    // When user stops via browser native button
    screenTrack.onended = () => stopScreenShare();
  } else {
    stopScreenShare();
  }
};

async function stopScreenShare() {
  if (!isScreenSharing) return;

  const videoTrack = localStream ? localStream.getVideoTracks()[0] : null;

  // Restore camera track in all peer connections
  Object.values(peers).forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && videoTrack) sender.replaceTrack(videoTrack);
  });

  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  // Restore local video view
  const localVid = document.getElementById('local-tile').querySelector('video');
  localVid.classList.remove('hidden');
  hideScreenShareIndicator();

  isScreenSharing = false;
  const btn = document.getElementById('screen-btn');
  const label = document.getElementById('screen-label');
  const icon = document.getElementById('screen-icon');
  btn.classList.remove('active');
  label.textContent = 'Share Screen';
  icon.textContent = '🖥';
}

function showScreenShareIndicator() {
  let el = document.getElementById('screen-share-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'screen-share-indicator';
    el.className = 'screen-share-indicator';
    el.innerHTML = '<span>🖥</span><span>Sharing your screen</span>';
    document.getElementById('local-tile').appendChild(el);
  }
  el.classList.remove('hidden');
}

function hideScreenShareIndicator() {
  const el = document.getElementById('screen-share-indicator');
  if (el) el.classList.add('hidden');
}

// =====================================================
// Chat
// =====================================================

window.toggleChat = function () {
  isChatOpen = !isChatOpen;
  chatSidebar.classList.toggle('open', isChatOpen);
  document.getElementById('chat-btn').classList.toggle('active', isChatOpen);

  if (isChatOpen) {
    unreadMessages = 0;
    chatBadge.classList.add('hidden');
    chatBadge.textContent = '0';
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
    chatInput.focus();
  }
};

window.sendMessage = function () {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', text);
  chatInput.value = '';
};

window.handleChatKey = function (e) {
  if (e.key === 'Enter') sendMessage();
};

function appendChatMessage(name, message, timestamp, isSelf) {
  const div = document.createElement('div');
  div.className = `chat-msg${isSelf ? ' self' : ''}`;
  div.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-name${isSelf ? ' self' : ''}">${escapeHtml(isSelf ? 'You' : name)}</span>
      <span class="chat-msg-time">${timestamp}</span>
    </div>
    <div class="chat-msg-text">${escapeHtml(message)}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// =====================================================
// Leave Room
// =====================================================

window.leaveRoom = function () {
  // Stop all streams
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (screenStream) screenStream.getTracks().forEach((t) => t.stop());

  // Close peer connections
  Object.values(peers).forEach((pc) => pc.close());

  socket.disconnect();
  window.location.href = '/';
};

// =====================================================
// Copy Room Link
// =====================================================

window.copyRoomLink = function () {
  const url = `${window.location.origin}/room.html?room=${encodeURIComponent(ROOM_ID)}`;
  navigator.clipboard.writeText(url).then(() => {
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => (copyBtn.innerHTML = '&#128279; Copy Link'), 2000);
  });
};

// =====================================================
// Timer
// =====================================================

function startTimer() {
  callStartTime = Date.now();
  const timerEl = document.getElementById('call-timer');
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    timerEl.textContent = elapsed >= 3600
      ? `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${m}:${s}`
      : `${m}:${s}`;
  }, 1000);
}

// =====================================================
// Helpers
// =====================================================

function setStatus(type, text) {
  connectionStatus.className = `status-dot ${type}`;
  connectionStatus.textContent = text;
}

function showLocalBadge(id, icon) {
  let badge = localBadges.querySelector(`[data-badge="${id}"]`);
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'badge badge-muted';
    badge.dataset.badge = id;
    localBadges.appendChild(badge);
  }
  badge.textContent = icon;
}

function removeLocalBadge(id) {
  const badge = localBadges.querySelector(`[data-badge="${id}"]`);
  if (badge) badge.remove();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =====================================================
// Boot
// =====================================================

init();
