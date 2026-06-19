const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// The 50 Themes you requested
const THEMES = [
  "Cat", "Dog", "House", "Tree", "Car", "Bicycle", "Pizza", "Hamburger", "Ice Cream", 
  "Cupcake", "Apple", "Banana", "Sun", "Moon", "Cloud", "Rainbow", "Flower", "Cactus", 
  "Fish", "Bird", "Butterfly", "Frog", "Turtle", "Rabbit", "Panda", "Penguin", "Monkey", 
  "Lion", "Shark", "Octopus", "Castle", "Rocket", "Airplane", "Boat", "Treasure Chest", 
  "Pirate", "Robot", "Alien", "Ghost", "Wizard", "Knight", "Crown", "Sword", "Dragon", 
  "Campfire", "Mountain", "Beach", "Lighthouse", "Snowman", "Hot Air Balloon"
];

// In-memory storage for rooms
const rooms = {};

// Helper to generate a 6-digit code
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // CREATE ROOM
  socket.on('create_room', (data) => {
    const roomCode = generateCode();
    rooms[roomCode] = {
      id: roomCode,
      host: socket.id,
      status: 'lobby', // lobby, drawing, voting, results
      theme: '',
      players: [{ id: socket.id, name: data.name, score: 0, drawing: null }],
      votes: {}, // To track votes per drawing
      currentDrawingIndex: 0,
      endTime: 0
    };
    
    socket.join(roomCode);
    socket.emit('room_joined', { roomCode, isHost: true });
    io.to(roomCode).emit('update_players', rooms[roomCode].players);
  });

  // JOIN ROOM
  socket.on('join_room', (data) => {
    const roomCode = data.roomCode.toUpperCase();
    const room = rooms[roomCode];

    if (!room) {
      socket.emit('error_msg', 'Room not found!');
      return;
    }
    if (room.status !== 'lobby') {
      socket.emit('error_msg', 'Game is already in progress!');
      return;
    }

    room.players.push({ id: socket.id, name: data.name, score: 0, drawing: null });
    socket.join(roomCode);
    socket.emit('room_joined', { roomCode, isHost: false });
    io.to(roomCode).emit('update_players', room.players);
  });

  // START GAME
  socket.on('start_game', (roomCode) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id) {
      room.status = 'drawing';
      room.theme = THEMES[Math.floor(Math.random() * THEMES.length)];
      // 5 minutes = 300 seconds
      room.endTime = Date.now() + (300 * 1000); 

      // Reset previous game state if restarting
      room.players.forEach(p => p.drawing = null);
      
      io.to(roomCode).emit('game_started', { theme: room.theme, endTime: room.endTime });

      // Automatically end drawing phase after 5 mins if not triggered manually
      room.gameTimer = setTimeout(() => {
        if (rooms[roomCode] && rooms[roomCode].status === 'drawing') {
          startVotingPhase(roomCode);
        }
      }, 300 * 1000);
    }
  });

  // SUBMIT DRAWING
  socket.on('submit_drawing', (data) => {
    const room = rooms[data.roomCode];
    if (room && room.status === 'drawing') {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.drawing = data.image;
      }

      // Check if all players have submitted
      const allSubmitted = room.players.every(p => p.drawing !== null);
      if (allSubmitted) {
        clearTimeout(room.gameTimer); // Fix: clear the timer so it moves immediately
        startVotingPhase(data.roomCode);
      }
    }
  });

  // VOTING LOGIC
  function startVotingPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    room.status = 'voting';
    room.currentDrawingIndex = 0;
    
    // Filter out players who didn't submit a drawing
    room.playersWithDrawings = room.players.filter(p => p.drawing !== null);
    
    if (room.playersWithDrawings.length === 0) {
      room.status = 'results';
      io.to(roomCode).emit('show_results', room.players);
      return;
    }

    sendNextDrawing(roomCode);
  }

  function sendNextDrawing(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.currentDrawingIndex >= room.playersWithDrawings.length) {
      // Voting finished
      tallyScores(roomCode);
      room.status = 'results';
      io.to(roomCode).emit('show_results', room.players);
      return;
    }

    const currentArt = room.playersWithDrawings[room.currentDrawingIndex];
    io.to(roomCode).emit('show_drawing_vote', {
      artistId: currentArt.id,
      artistName: currentArt.name,
      drawing: currentArt.drawing,
      index: room.currentDrawingIndex + 1,
      total: room.playersWithDrawings.length
    });

    // Automatically move to next drawing after 15 seconds
    room.voteTimer = setTimeout(() => {
      room.currentDrawingIndex++;
      sendNextDrawing(roomCode);
    }, 15000);
  }

  // SUBMIT VOTE
  socket.on('submit_vote', (data) => {
    const room = rooms[data.roomCode];
    if (room && room.status === 'voting') {
      const currentArt = room.playersWithDrawings[room.currentDrawingIndex];
      // Prevent self-voting
      if (socket.id !== currentArt.id) {
        if (!room.votes[currentArt.id]) room.votes[currentArt.id] = [];
        room.votes[currentArt.id].push(data.stars);
      }
    }
  });

  function tallyScores(roomCode) {
    const room = rooms[roomCode];
    room.players.forEach(p => {
      const playerVotes = room.votes[p.id] || [];
      const totalStars = playerVotes.reduce((a, b) => a + b, 0);
      p.score = totalStars;
    });
    // Sort players by score
    room.players.sort((a, b) => b.score - a.score);
  }

  // RETURN TO LOBBY
  socket.on('return_to_lobby', (roomCode) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id) {
      room.status = 'lobby';
      room.votes = {};
      room.players.forEach(p => { p.drawing = null; p.score = 0; });
      io.to(roomCode).emit('returned_to_lobby');
      io.to(roomCode).emit('update_players', room.players);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        // If room is empty, delete it
        if (room.players.length === 0) {
          delete rooms[roomCode];
        } else {
          // If host left, assign new host
          if (room.host === socket.id) {
            room.host = room.players[0].id;
            io.to(room.host).emit('you_are_host');
          }
          io.to(roomCode).emit('update_players', room.players);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
