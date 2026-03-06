const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000, // send ping every 10 s
  pingTimeout: 5000,   // drop if no pong within 5 s → dead tabs detected in ~15 s
});

app.use(express.static(path.join(__dirname, 'public')));

// Room management: roomId -> Map of socketId -> { name }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Track which room this socket is in
  let currentRoomId = null;

  socket.on('join-room', (roomId, userName) => {
    currentRoomId = roomId;
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    rooms.get(roomId).set(socket.id, { name: userName });

    // Send existing users to the newly joined user
    const existingUsers = [];
    rooms.get(roomId).forEach((user, socketId) => {
      if (socketId !== socket.id) {
        existingUsers.push({ id: socketId, name: user.name, isScreenSharing: user.isScreenSharing || false });
      }
    });
    socket.emit('existing-users', existingUsers);

    // Notify existing users that a new peer has joined
    socket.to(roomId).emit('user-connected', socket.id, userName);

    console.log(`${userName} joined room ${roomId}. Users: ${rooms.get(roomId).size}`);
  });

  // WebRTC signaling: relay offer/answer/ICE between peers
  socket.on('offer', (offer, targetId) => {
    io.to(targetId).emit('offer', offer, socket.id);
  });

  socket.on('answer', (answer, targetId) => {
    io.to(targetId).emit('answer', answer, socket.id);
  });

  socket.on('ice-candidate', (candidate, targetId) => {
    io.to(targetId).emit('ice-candidate', candidate, socket.id);
  });

  // Screen share state relay: broadcast to everyone else in the room
  socket.on('screen-share-started', () => {
    if (currentRoomId) {
      const user = rooms.get(currentRoomId)?.get(socket.id);
      if (user) user.isScreenSharing = true;
      socket.to(currentRoomId).emit('screen-share-started', socket.id);
    }
  });

  socket.on('screen-share-stopped', () => {
    if (currentRoomId) {
      const user = rooms.get(currentRoomId)?.get(socket.id);
      if (user) user.isScreenSharing = false;
      socket.to(currentRoomId).emit('screen-share-stopped', socket.id);
    }
  });

  // Chat relay: broadcast to everyone in the room
  socket.on('chat-message', (message) => {
    if (!currentRoomId) return;
    const user = rooms.get(currentRoomId)?.get(socket.id);
    io.to(currentRoomId).emit('chat-message', {
      userId: socket.id,
      name: user ? user.name : 'Unknown',
      message,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    if (rooms.has(currentRoomId)) {
      rooms.get(currentRoomId).delete(socket.id);
      if (rooms.get(currentRoomId).size === 0) {
        rooms.delete(currentRoomId);
      }
    }
    socket.to(currentRoomId).emit('user-disconnected', socket.id);
    console.log(`User ${socket.id} left room ${currentRoomId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`meetTogether server running at http://localhost:${PORT}`);
});
