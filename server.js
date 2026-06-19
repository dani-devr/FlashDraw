// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Increase buffer size to handle high-quality canvas base64 images
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Game State Storage
const rooms = {};

// Helper: Generate 6-char room code
function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

// 130 Random Themes
const THEMES = [
    "Cat", "Pirate Ship", "Dragon", "Castle", "Robot", "Banana", "Wizard", "Treasure Chest", "Alien", "Astronaut",
    "Guitar", "Ninja", "Dinosaur", "Vampire", "Unicorn", "Mermaid", "Volcano", "Spaceship", "Zombie", "Ghost",
    "Pizza", "Hamburger", "Sushi", "Octopus", "Monkey", "Elephant", "Tiger", "Lion", "Penguin", "Kangaroo",
    "Hot Air Balloon", "Submarine", "Helicopter", "Train", "Motorcycle", "Bicycle", "Rollercoaster", "Ferris Wheel",
    "Tornado", "Snowman", "Sandcastle", "Lighthouse", "Windmill", "Telescope", "Microscope", "Camera", "Smartphone",
    "Laptop", "Headphones", "Microphone", "Crown", "Sword", "Shield", "Magic Wand", "Crystal Ball", "Book",
    "Clock", "Watch", "Glasses", "Umbrella", "Key", "Lock", "Door", "Window", "Chair", "Table", "Bed", "Sofa",
    "Lamp", "Television", "Radio", "Refrigerator", "Oven", "Toaster", "Blender", "Coffee Maker", "Teapot",
    "Cup", "Plate", "Fork", "Knife", "Spoon", "Apple", "Orange", "Grapes", "Watermelon", "Strawberry", "Pineapple",
    "Carrot", "Broccoli", "Tomato", "Potato", "Onion", "Garlic", "Mushroom", "Tree", "Flower", "Cactus",
    "Rose", "Sunflower", "Tulip", "Daisy", "Leaf", "Cloud", "Sun", "Moon", "Star", "Planet", "Comet", "Meteor",
    "Galaxy", "Black Hole", "Mountain", "River", "Lake", "Ocean", "Waterfall", "Island", "Desert", "Forest",
    "Jungle", "Cave", "Bridge", "City", "Village", "Farm", "Barn", "Tractor", "Scarecrow", "Campfire", "Tent", "67"
];

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create a new lobby
    socket.on('create_room', (data) => {
        const roomCode = generateCode();
        rooms[roomCode] = {
            code: roomCode,
            owner: socket.id,
            status: 'lobby', // lobby, playing, voting, results
            settings: { roundTime: 5, maxPlayers: 8, voteTime: 15 },
            players: {},
            theme: '',
            drawings: {},
            votes: {},
            currentVoteIndex: 0,
            drawingOrder: []
        };
        
        joinRoom(socket, roomCode, data.name);
    });

    // Join existing lobby
    socket.on('join_room', (data) => {
        const code = data.code.toUpperCase();
        if (rooms[code]) {
            if(Object.keys(rooms[code].players).length >= rooms[code].settings.maxPlayers) {
                return socket.emit('error_msg', 'Room is full!');
            }
            if(rooms[code].status !== 'lobby') {
                return socket.emit('error_msg', 'Game already in progress!');
            }
            joinRoom(socket, code, data.name);
        } else {
            socket.emit('error_msg', 'Room not found!');
        }
    });

    function joinRoom(socket, code, name) {
        socket.join(code);
        rooms[code].players[socket.id] = { id: socket.id, name, ready: false, score: 0 };
        socket.emit('room_joined', { code, isOwner: rooms[code].owner === socket.id, settings: rooms[code].settings });
        io.to(code).emit('update_players', Object.values(rooms[code].players));
        io.to(code).emit('chat_msg', { sender: 'System', text: `${name} joined the lobby.`, sys: true });
    }

    // Lobby Interactions
    socket.on('toggle_ready', (code) => {
        if(rooms[code] && rooms[code].players[socket.id]) {
            rooms[code].players[socket.id].ready = !rooms[code].players[socket.id].ready;
            io.to(code).emit('update_players', Object.values(rooms[code].players));
        }
    });

    socket.on('update_settings', (data) => {
        if(rooms[data.code] && rooms[data.code].owner === socket.id) {
            rooms[data.code].settings = data.settings;
            io.to(data.code).emit('settings_updated', data.settings);
        }
    });

    socket.on('chat_msg', (data) => {
        if(rooms[data.code]) {
            const name = rooms[data.code].players[socket.id]?.name || 'Spectator';
            io.to(data.code).emit('chat_msg', { sender: name, text: data.msg });
        }
    });

    // Game Loop
    socket.on('start_game', (code) => {
        const room = rooms[code];
        if(room && room.owner === socket.id) {
            room.status = 'playing';
            room.theme = THEMES[Math.floor(Math.random() * THEMES.length)];
            room.drawings = {};
            room.votes = {};
            Object.values(room.players).forEach(p => p.score = 0);
            io.to(code).emit('game_started', { theme: room.theme, time: room.settings.roundTime * 60 });
        }
    });

    // Receive drawings when time is up
    socket.on('submit_drawing', (data) => {
        const room = rooms[data.code];
        if(room && room.status === 'playing') {
            room.drawings[socket.id] = data.image;
            
            // If everyone submitted
            if(Object.keys(room.drawings).length === Object.keys(room.players).length) {
                startVotingPhase(data.code);
            }
        }
    });

    function startVotingPhase(code) {
        const room = rooms[code];
        room.status = 'voting';
        room.drawingOrder = Object.keys(room.drawings);
        room.currentVoteIndex = 0;
        
        // Initialize scores
        room.drawingOrder.forEach(id => room.votes[id] = 0);
        
        sendNextVote(code);
    }

    function sendNextVote(code) {
        const room = rooms[code];
        if(room.currentVoteIndex >= room.drawingOrder.length) {
            return showResults(code);
        }

        const currentAuthorId = room.drawingOrder[room.currentVoteIndex];
        io.to(code).emit('start_vote', {
            authorId: currentAuthorId,
            image: room.drawings[currentAuthorId],
            time: room.settings.voteTime
        });

        // Auto advance vote if time runs out
        room.voteTimer = setTimeout(() => {
            room.currentVoteIndex++;
            sendNextVote(code);
        }, room.settings.voteTime * 1000 + 2000);
    }

    socket.on('submit_vote', (data) => {
        const room = rooms[data.code];
        if(room && room.status === 'voting') {
            // Cannot vote for self
            if(data.authorId !== socket.id) {
                room.votes[data.authorId] += data.stars;
            }
        }
    });

    function showResults(code) {
        const room = rooms[code];
        room.status = 'results';
        
        // Apply scores
        Object.keys(room.votes).forEach(id => {
            if(room.players[id]) room.players[id].score = room.votes[id];
        });

        const sortedPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);
        
        // Map top 3 with images
        const top3 = sortedPlayers.slice(0, 3).map(p => ({
            name: p.name,
            score: p.score,
            image: room.drawings[p.id]
        }));

        io.to(code).emit('show_results', top3);

        // Reset to lobby after 15 seconds
        setTimeout(() => {
            if(rooms[code]) {
                rooms[code].status = 'lobby';
                Object.values(rooms[code].players).forEach(p => p.ready = false);
                io.to(code).emit('return_to_lobby');
            }
        }, 15000);
    }

    socket.on('disconnect', () => {
        // Handle player leaving
        for (const code in rooms) {
            if (rooms[code].players[socket.id]) {
                const name = rooms[code].players[socket.id].name;
                delete rooms[code].players[socket.id];
                io.to(code).emit('chat_msg', { sender: 'System', text: `${name} disconnected.`, sys: true });
                io.to(code).emit('update_players', Object.values(rooms[code].players));
                
                // If room empty, delete it
                if(Object.keys(rooms[code].players).length === 0) {
                    delete rooms[code];
                } else if (rooms[code].owner === socket.id) {
                    // Assign new owner
                    rooms[code].owner = Object.keys(rooms[code].players)[0];
                    io.to(code).emit('new_owner', rooms[code].owner);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Flash Draw! Server running on port ${PORT}`);
});
