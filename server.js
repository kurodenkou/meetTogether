const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Room management: roomId -> Map of socketId -> { name }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId, userName) => {
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    rooms.get(roomId).set(socket.id, { name: userName });

    // Send existing users to the newly joined user
    const existingUsers = [];
    rooms.get(roomId).forEach((user, socketId) => {
      if (socketId !== socket.id) {
        existingUsers.push({ id: socketId, name: user.name });
      }
    });
    socket.emit('existing-users', existingUsers);

    // Notify existing users that a new peer has joined
    socket.to(roomId).emit('user-connected', socket.id, userName);

    console.log(`${userName} joined room ${roomId}. Users: ${rooms.get(roomId).size}`);

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

    // Chat relay: broadcast to everyone in the room
    socket.on('chat-message', (message) => {
      const user = rooms.get(roomId)?.get(socket.id);
      io.to(roomId).emit('chat-message', {
        userId: socket.id,
        name: user ? user.name : 'Unknown',
        message,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
    });

    socket.on('disconnect', () => {
      if (rooms.has(roomId)) {
        rooms.get(roomId).delete(socket.id);
        if (rooms.get(roomId).size === 0) {
          rooms.delete(roomId);
        }
      }
      socket.to(roomId).emit('user-disconnected', socket.id);
      console.log(`User ${socket.id} left room ${roomId}`);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`meetTogether server running at http://localhost:${PORT}`);
});
