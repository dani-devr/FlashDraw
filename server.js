// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};

function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

const THEMES = [
    "Cat", "Pirate Ship", "Dragon", "Castle", "Robot", "Banana", "Wizard", "Treasure Chest", "Alien", "Astronaut",
    "Guitar", "Ninja", "Dinosaur", "Vampire", "Unicorn", "Mermaid", "Volcano", "Spaceship", "Zombie", "Ghost",
    "Pizza", "Hamburger", "Sushi", "Octopus", "Monkey", "Elephant", "Tiger", "Lion", "Penguin", "Kangaroo",
    "Hot Air Balloon", "Submarine", "Helicopter", "Train", "Motorcycle", "Bicycle"
];

io.on('connection', (socket) => {
    socket.on('create_room', (data) => {
        const roomCode = generateCode();
        rooms[roomCode] = {
            code: roomCode,
            owner: socket.id,
            status: 'lobby',
            settings: { roundTime: 3, maxPlayers: 8, voteTime: 10 },
            players: {},
            theme: '',
            drawings: {},
            votes: {},
            currentVoteIndex: 0,
            drawingOrder: [],
            serverTimer: null
        };
        joinRoom(socket, roomCode, data.name);
    });

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
        rooms[code].players[socket.id] = { id: socket.id, name, ready: false, score: 0, submitted: false };
        socket.emit('room_joined', { code, isOwner: rooms[code].owner === socket.id, settings: rooms[code].settings });
        io.to(code).emit('update_players', Object.values(rooms[code].players));
    }

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

    socket.on('start_game', (code) => {
        const room = rooms[code];
        if(room && room.owner === socket.id) {
            room.status = 'playing';
            room.theme = THEMES[Math.floor(Math.random() * THEMES.length)];
            room.drawings = {};
            room.votes = {};
            Object.values(room.players).forEach(p => { p.score = 0; p.submitted = false; });
            
            const duration = room.settings.roundTime * 60;
            io.to(code).emit('game_started', { theme: room.theme, time: duration });

            room.serverTimer = setTimeout(() => {
                if (rooms[code] && rooms[code].status === 'playing') forceSubmitRemaining(code);
            }, duration * 1000 + 2000);
        }
    });

    socket.on('submit_drawing', (data) => {
        const room = rooms[data.code];
        if(room && room.status === 'playing') {
            room.drawings[socket.id] = data.image;
            if(room.players[socket.id]) room.players[socket.id].submitted = true;
            io.to(data.code).emit('player_submitted', socket.id);
            checkAllSubmitted(data.code);
        }
    });

    function forceSubmitRemaining(code) {
        io.to(code).emit('force_submit');
        setTimeout(() => {
            if(rooms[code] && rooms[code].status === 'playing') startVotingPhase(code);
        }, 3000);
    }

    function checkAllSubmitted(code) {
        const room = rooms[code];
        const allSubmitted = Object.values(room.players).every(p => p.submitted);
        if(allSubmitted) {
            clearTimeout(room.serverTimer);
            startVotingPhase(code);
        }
    }

    function startVotingPhase(code) {
        const room = rooms[code];
        room.status = 'voting';
        room.drawingOrder = Object.keys(room.drawings);
        room.currentVoteIndex = 0;
        
        if(room.drawingOrder.length === 0) return showResults(code);

        room.drawingOrder.forEach(id => room.votes[id] = 0);
        sendNextVote(code);
    }

    function sendNextVote(code) {
        const room = rooms[code];
        if(room.currentVoteIndex >= room.drawingOrder.length) return showResults(code);

        const currentAuthorId = room.drawingOrder[room.currentVoteIndex];
        io.to(code).emit('start_vote', { authorId: currentAuthorId, image: room.drawings[currentAuthorId], time: room.settings.voteTime });

        room.voteTimer = setTimeout(() => {
            room.currentVoteIndex++;
            sendNextVote(code);
        }, room.settings.voteTime * 1000 + 1000);
    }

    socket.on('submit_vote', (data) => {
        const room = rooms[data.code];
        if(room && room.status === 'voting' && data.authorId !== socket.id) {
            room.votes[data.authorId] += data.stars;
        }
    });

    function showResults(code) {
        const room = rooms[code];
        room.status = 'results';
        
        Object.keys(room.votes).forEach(id => {
            if(room.players[id]) room.players[id].score = room.votes[id];
        });

        const sortedPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);
        const top3 = sortedPlayers.slice(0, 3).map(p => ({
            name: p.name, score: p.score, image: room.drawings[p.id] || ''
        }));

        io.to(code).emit('show_results', top3);

        setTimeout(() => {
            if(rooms[code]) {
                rooms[code].status = 'lobby';
                Object.values(rooms[code].players).forEach(p => p.ready = false);
                io.to(code).emit('return_to_lobby');
            }
        }, 12000);
    }

    socket.on('disconnect', () => {
        for (const code in rooms) {
            if (rooms[code].players[socket.id]) {
                delete rooms[code].players[socket.id];
                io.to(code).emit('update_players', Object.values(rooms[code].players));
                
                if(Object.keys(rooms[code].players).length === 0) {
                    clearTimeout(rooms[code].serverTimer);
                    delete rooms[code];
                } else if (rooms[code].owner === socket.id) {
                    rooms[code].owner = Object.keys(rooms[code].players)[0];
                    io.to(code).emit('new_owner', rooms[code].owner);
                }
                if(rooms[code] && rooms[code].status === 'playing') checkAllSubmitted(code);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Flash Draw! Server running on port ${PORT}`));
