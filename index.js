require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
const CLIENT_URL = process.env.CLIENT_URL || "https://vechiron.com";
const VECB0T_API_BASE = (process.env.VECB0T_API_BASE || 'https://vechiron.com/api').replace(/\/+$/, '');
const SKETCHQUEST_GAME_SECRET = process.env.SKETCHQUEST_GAME_SECRET || 'vecbot-sketchquest-secret';

app.use(cors({
    origin: CLIENT_URL
}));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://192.168.3.2:5173", // Local Network
            "https://vechiron.com",    // Production Frontend
            "http://vechiron.com",
            "https://www.vechiron.com",
            "https://heumrage.com",
            "http://heumrage.com",
            "https://www.heumrage.com"
        ],
        methods: ["GET", "POST"]
    }
});

// --- Constants & Data ---
const PHASE = {
    LOBBY: 'lobby',
    VIEWING: 'viewing',
    WRITING: 'writing',
    DISCUSSING: 'discussing',
    VOTING: 'voting',
    RESULTS: 'results',
    MATCH_END: 'match_end'
};

const ART_PAIRS = [
    {
        innocent: "https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?q=80&w=600&auto=format&fit=crop",
        impostor: "https://images.unsplash.com/photo-1578301978693-85fa9c0320b9?q=80&w=600&auto=format&fit=crop"
    },
    {
        innocent: "https://images.unsplash.com/photo-1547891654-e66ed7ebb968?q=80&w=600&auto=format&fit=crop",
        impostor: "https://images.unsplash.com/photo-1549490349-8643362247b5?q=80&w=600&auto=format&fit=crop"
    },
    {
        innocent: "https://images.unsplash.com/photo-1561214115-f2f134cc4912?q=80&w=600&auto=format&fit=crop",
        impostor: "https://images.unsplash.com/photo-1541963463532-d68292c34b19?q=80&w=600&auto=format&fit=crop"
    }
];

// --- State ---
const rooms = {};

// --- Helpers ---
const generateRoomCode = () => Math.random().toString(36).substring(2, 7).toUpperCase();

const getPublicRooms = () => {
    return Object.values(rooms)
        .map(r => {
            const owner = r.players.find(p => p.id === r.ownerId);
            return {
                code: r.code,
                playerCount: r.players.length,
                isPublic: typeof r.isPublic !== 'undefined' ? r.isPublic : true,
                ownerName: owner ? owner.username : 'Bilinmiyor',
                phase: r.state.phase // Add phase info
            };
        });
};

const notifyVecbotWinner = async (username) => {
    if (!username) return;
    try {
        const resp = await fetch(`${VECB0T_API_BASE}/integrations/sketchquest-win`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-game-secret': SKETCHQUEST_GAME_SECRET,
            },
            body: JSON.stringify({ username }),
        });

        if (!resp.ok) {
            const text = await resp.text();
            console.error(`[SketchQuest] Vecbot puan güncelleme başarısız (${resp.status}): ${text}`);
            return;
        }
        const data = await resp.json().catch(() => ({}));
        console.log(`[SketchQuest] Vecbot puan +10 -> ${username}`, data);
    } catch (err) {
        console.error('[SketchQuest] Vecbot puan endpoint hatası:', err.message);
    }
};

const awardMatchWinners = (room) => {
    if (!room || room.state?.winnerAwardSent) return;
    if (!Array.isArray(room.players) || room.players.length === 0) return;

    const maxScore = Math.max(...room.players.map((p) => Number(p.score || 0)));
    const winners = room.players.filter((p) => Number(p.score || 0) === maxScore);
    if (!winners.length) return;

    room.state.winnerAwardSent = true;
    winners.forEach((winner) => {
        notifyVecbotWinner((winner.username || '').trim());
    });
};

const broadcastState = (room) => {
    const wordsToSend = room.players.filter(p => p.word).map(p => ({ username: p.username, word: p.word }));
    console.log('[DEBUG] Broadcasting words:', wordsToSend);

    io.to(room.code).emit('game_state_update', {
        phase: room.state.phase,
        timer: room.state.timer,
        currentRound: room.state.currentRound,
        totalRounds: room.rounds, // Send total rounds too
        // Send specific turn info
        turn: {
            writerId: room.state.turnOrder ? room.state.turnOrder[room.state.turnIndex] : null,
            writerName: room.state.turnOrder ? room.players.find(p => p.id === room.state.turnOrder[room.state.turnIndex])?.username : null
        },
        words: wordsToSend
    });
};

const broadcastPlayerList = (room) => {
    // Mask roles to prevent cheating/leaking, but indicate activity
    const safePlayers = room.players.map(p => ({
        ...p,
        role: p.role ? 'active' : null // 'active' is truthy, so client filter works
    }));
    io.to(room.code).emit('player_list_update', safePlayers);
};

const broadcastPublicRooms = () => {
    io.emit('public_rooms_update', getPublicRooms());
};

// --- Game Logic ---
const setPhase = (room, phase, duration) => {
    room.state.phase = phase;
    room.state.timer = duration;

    // Cleanup intervals
    if (room.timerInterval) clearInterval(room.timerInterval);

    broadcastState(room);

    // If transitioning out of lobby, update public rooms
    if (phase !== PHASE.LOBBY) broadcastPublicRooms();

    if (duration > 0) {
        room.timerInterval = setInterval(() => {
            room.state.timer--;

            if (room.state.timer <= 0) {
                clearInterval(room.timerInterval);
                handlePhaseTimeout(room);
            } else {
                // Optimization: Emit timer every second? Or let client handle?
                // For sync, best to emit.
                io.to(room.code).emit('timer_update', room.state.timer);
            }
        }, 1000);
    }
};

const handlePhaseTimeout = (room) => {
    switch (room.state.phase) {
        case PHASE.WRITING:
            // If checking turns, timeout means skip turn
            advanceTurn(room);
            break;
        case PHASE.DISCUSSING:
            setPhase(room, PHASE.VOTING, 30);
            break;
        case PHASE.VOTING:
            calculateResults(room);
            break;
        case PHASE.RESULTS:
            if (room.state.currentRound < room.rounds) {
                // Next round
                nextRound(room);
            } else {
                // Match match end
                awardMatchWinners(room);
                setPhase(room, PHASE.MATCH_END, 30);
                room.players.forEach(p => p.hasSkipped = false); // Reset skip flags
            }
            break;
        case PHASE.MATCH_END:
            setPhase(room, PHASE.LOBBY, 0);
            resetMatch(room);
            break;
        case PHASE.LOBBY:
            // Countdown finished, start game
            startGame(room);
            break;
    }
};

const fetchArtFromMet = async (theme) => {
    try {
        // Enforce Public Domain & Paintings classification to avoid random objects/architecture
        const searchUrl = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&isPublicDomain=true&classification=Paintings&q=${theme}`;
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();

        if (!searchData.total || searchData.total < 10) throw new Error('Not enough results');

        // Get pool of random IDs (fetch more to ensure we find valid images)
        const ids = searchData.objectIDs;
        const randomIds = [];
        while (randomIds.length < 5) {
            const rid = ids[Math.floor(Math.random() * ids.length)];
            if (!randomIds.includes(rid)) randomIds.push(rid);
        }

        // Fetch details in parallel
        const potentialArt = await Promise.all(randomIds.map(async (id) => {
            try {
                const detailRes = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
                const detailData = await detailRes.json();
                // Prefer small image for speed, valid URL check
                return detailData.primaryImageSmall || null;
            } catch (e) {
                return null;
            }
        }));

        const validImages = potentialArt.filter(img => img && img.startsWith('http'));

        if (validImages.length < 2) throw new Error('Not enough valid images found');

        return {
            innocent: validImages[0],
            impostor: validImages[1]
        };
    } catch (error) {
        console.error('Met API Error, falling back to LoremFlickr:', error.message);
        // Fallback Logic
        const searchKeywords = theme.replace(' ', ',');
        let seed1 = Math.floor(Math.random() * 100000);
        let seed2 = Math.floor(Math.random() * 100000);
        while (seed1 === seed2) seed2 = Math.floor(Math.random() * 100000);

        return {
            innocent: `https://loremflickr.com/800/600/${searchKeywords}?lock=${seed1}`,
            impostor: `https://loremflickr.com/800/600/${searchKeywords}?lock=${seed2}`
        };
    }
};

const nextRound = (room) => {
    // Cleanup Offline players from previous round
    room.players = room.players.filter(p => !p.isOffline);
    broadcastPlayerList(room); // Update client lists immediately

    if (room.players.length < 2) {
        console.log(`Not enough players to start Round ${room.state.currentRound + 1}. Resetting to Lobby.`);
        setPhase(room, PHASE.LOBBY, 0);
        resetMatch(room);
        return;
    }

    room.state.currentRound++;

    // Reset Round-specific player data
    room.players.forEach(p => {
        p.role = null;
        p.word = null;
        p.vote = null;
        p.isReady = true; // Auto-ready for next round
    });

    // 1. Art Logic (The Met API)
    // Strictly Paintings / Art Genres
    const THEMES = [
        'Portrait', 'Self-portrait', 'Still Life', 'Landscape',
        'Oil painting', 'Watercolor', 'Impressionism', 'Surrealism',
        'Flowers', 'Animals', 'Genre painting', 'Mythology'
    ];
    const randomTheme = THEMES[Math.floor(Math.random() * THEMES.length)];

    console.log(`[Round ${room.state.currentRound}] Fetching art for theme: ${randomTheme}`);
    // 1. Art Logic (From Pre-calculated Cache)
    let artData = room.state.matchArtCache ? room.state.matchArtCache[room.state.currentRound - 1] : null;

    // Fallback if cache missed
    if (!artData) {
        console.error("Art Cache Miss! Fetching emergency art...");
        const fallbackThemes = ['Portrait', 'Landscape', 'Still Life'];
        const randomTheme = fallbackThemes[Math.floor(Math.random() * fallbackThemes.length)];
        const searchKeywords = randomTheme.replace(' ', ',');
        let seed1 = Math.floor(Math.random() * 100000);
        let seed2 = Math.floor(Math.random() * 100000);
        while (seed1 === seed2) seed2 = Math.floor(Math.random() * 100000);
        artData = {
            innocent: `https://loremflickr.com/800/600/${searchKeywords}?lock=${seed1}`,
            impostor: `https://loremflickr.com/800/600/${searchKeywords}?lock=${seed2}`,
            theme: randomTheme
        };
    }

    room.state.artPair = artData;

    console.log(`[Round ${room.state.currentRound}] Using Cached Art:`);
    console.log(`Theme: ${artData.theme}`);
    console.log(`Innocent URL: ${room.state.artPair.innocent}`);
    console.log(`Impostor URL: ${room.state.artPair.impostor}`);

    // Assign Roles
    // Dynamic Impostor Count:
    // If players >= 8, then 2 Impostors. Else 1.
    const impostorCount = room.players.length >= 8 ? 2 : 1;

    // Shuffle players to assign roles randomly
    const shuffledPlayers = [...room.players].sort(() => Math.random() - 0.5);

    // First, set everyone to innocent
    room.players.forEach(p => p.role = 'innocent');

    // Assign Impostors
    for (let i = 0; i < impostorCount; i++) {
        if (shuffledPlayers[i]) {
            shuffledPlayers[i].role = 'impostor';
        }
    }

    console.log(`[Round ${room.state.currentRound}] Art Generation:`);
    console.log(`Theme: ${randomTheme}`);
    console.log(`Innocent URL: ${room.state.artPair.innocent}`);
    console.log(`Impostor URL: ${room.state.artPair.impostor}`);
    console.log('Roles:', room.players.map(p => `${p.username}:${p.role}`).join(', '));

    // Broadcast Round Init
    room.players.forEach(p => {
        // Correctly handling multiple impostors:
        // If I am impostor -> I see impostor image
        // If I am innocent -> I see innocent image
        const img = p.role === 'impostor' ? room.state.artPair.impostor : room.state.artPair.innocent;
        io.to(p.id).emit('round_init', { role: p.role, imageUrl: img });
    });

    // Broadcast masked active player list so everyone knows who is playing
    broadcastPlayerList(room);

    startWritingPhase(room); // Reuse writing phase starter
};

const startWritingPhase = (room) => {
    room.state.phase = PHASE.WRITING;
    broadcastPublicRooms(); // Update lobby to show "In Game"
    // Helper to shuffle
    const shuffle = (array) => array.sort(() => Math.random() - 0.5);
    room.state.turnOrder = shuffle(room.players.map(p => p.id));
    room.state.turnIndex = 0;

    // Clear words
    room.players.forEach(p => p.word = null);

    startTurn(room);
};

const startTurn = (room) => {
    if (room.state.turnIndex >= room.state.turnOrder.length) {
        // All turns done
        setPhase(room, PHASE.DISCUSSING, 120);
        // Reset discussion skip flags
        room.players.forEach(p => p.hasSkippedDiscussion = false);
        broadcastPlayerList(room);
        return;
    }

    const currentWriterId = room.state.turnOrder[room.state.turnIndex];
    const currentWriter = room.players.find(p => p.id === currentWriterId);

    // Skip if player left or is offline
    if (!currentWriter || currentWriter.isOffline) {
        console.log(`Skipping offline writer: ${currentWriterId}`);
        advanceTurn(room);
        return;
    }

    // 30 Seconds per turn
    room.state.timer = 30;
    // Update current turn info for client
    room.state.turn = {
        writerId: currentWriterId,
        writerName: currentWriter.username
    };
    broadcastState(room); // Updates who is writing

    if (room.timerInterval) clearInterval(room.timerInterval);
    room.timerInterval = setInterval(() => {
        room.state.timer--;
        if (room.state.timer <= 0) {
            clearInterval(room.timerInterval);
            advanceTurn(room);
        } else {
            io.to(room.code).emit('timer_update', room.state.timer);
        }
    }, 1000);
};

const advanceTurn = (room) => {
    room.state.turnIndex++;
    startTurn(room);
};

const calculateResults = (room) => {
    // Tally votes
    const votes = {};
    let maxVotes = 0;
    let votedPlayerId = null;

    room.players.forEach(p => {
        if (p.vote) {
            votes[p.vote] = (votes[p.vote] || 0) + 1;
            if (votes[p.vote] > maxVotes) {
                maxVotes = votes[p.vote];
                votedPlayerId = p.vote;
            }
        }
    });

    const votedPlayer = room.players.find(p => p.id === votedPlayerId);
    const impostor = room.players.find(p => p.role === 'impostor');

    let winner = 'impostor';
    let message = "Impostor Kazandı!";
    let impostorName = impostor ? impostor.username : "Unknown";

    if (votedPlayer && votedPlayer.role === 'impostor') {
        winner = 'innocents';
        message = `Tebrikler! Impostor (${impostorName}) yakalandı!`;
        // Score: +20 to correct voters
        room.players.forEach(p => {
            if (impostor && p.vote === impostor.id) p.score += 20;
        });
    } else {
        winner = 'impostor';
        message = `Impostor kaçtı! (Impostor: ${impostorName})`;
        // Score: Impostor gets 30 + 10 * playerCount
        if (impostor) {
            impostor.score += 30 + (room.players.length * 10);
        }
    }

    io.to(room.code).emit('game_over', {
        winner,
        message,
        impostorName,
        images: room.state.artPair
    });
    broadcastPlayerList(room); // Update scores
    setPhase(room, PHASE.RESULTS, 5);
};

const resetMatch = (room) => {
    // Remove Offline players before resetting
    room.players = room.players.filter(p => !p.isOffline);

    room.players.forEach(p => {
        p.role = null;
        p.word = null;
        p.vote = null;
        p.isReady = false; // Force re-ready only after FULL MATCH
        p.score = 0; // Reset Scores for new match
        p.hasSkipped = false;
    });
    room.state.turnOrder = null;
    room.state.turnIndex = 0;
    room.state.currentRound = 0;
    room.state.winnerAwardSent = false;
    broadcastState(room);
    broadcastPlayerList(room);
    broadcastPublicRooms();
};

const startGame = async (room) => {
    room.state.currentRound = 0;
    room.state.totalRounds = room.rounds || 5;
    room.state.winnerAwardSent = false;

    // Pre-fetch art for ALL rounds to avoid delays mid-game
    console.log(`[StartGame] Pre-fetching art for ${room.state.totalRounds} rounds...`);
    room.state.matchArtCache = [];

    const THEMES = [
        'Portrait', 'Still Life', 'Landscape',
        'Oil painting', 'Watercolor', 'Impressionism', 'Surrealism',
        'Flowers', 'Mythological painting'
    ];

    // Create an array of promises to fetch art sequentially or in parallel
    // Sequentially is safer for Met API rate limits
    for (let i = 0; i < room.state.totalRounds; i++) {
        const randomTheme = THEMES[Math.floor(Math.random() * THEMES.length)];
        try {
            const pair = await fetchArtFromMet(randomTheme);
            room.state.matchArtCache.push({ ...pair, theme: randomTheme });
            console.log(`[StartGame] Cached round ${i + 1}/${room.state.totalRounds}`);
        } catch (err) {
            console.error(`[StartGame] Cached round ${i + 1} failed`, err.message);
            // fetchArtFromMet has internal fallback to LoremFlickr, so this shouldn't crash
        }
    }

    console.log(`[StartGame] Successfully cached ${room.state.matchArtCache.length} art pairs.`);
    nextRound(room);
};

// --- Socket Handling ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Helper to find player's room
    const getMyRoom = () => {
        // Inefficient lookup but works for small scale
        const code = Object.keys(rooms).find(c => rooms[c].players.find(p => p.id === socket.id));
        return code ? rooms[code] : null;
    };

    socket.on('create_room', ({ username, isPublic = true, rounds = 5 }) => {
        const code = generateRoomCode();
        rooms[code] = {
            code,
            players: [],
            ownerId: socket.id,
            isPublic: isPublic,
            rounds: parseInt(rounds) || 5,
            state: { phase: PHASE.LOBBY, timer: 0, turnIndex: 0, turnOrder: [], winnerAwardSent: false }
        };

        socket.join(code);
        const player = { id: socket.id, username, score: 0, role: null, word: null, vote: null, isReady: false, isOwner: true };
        rooms[code].players.push(player);

        socket.emit('room_joined', {
            room: code,
            user: username,
            players: rooms[code].players,
            isOwner: true,
            isPublic: isPublic
        });
        broadcastPlayerList(rooms[code]);
        broadcastPublicRooms();
        console.log(`Room created: ${code} by ${username}`);
    });

    socket.on('join_room', ({ username, room: code }) => {
        if (!code) return socket.emit('error', { message: 'Oda kodu gerçersiz.' });
        code = code.toUpperCase();

        const room = rooms[code];
        if (room) {
            if (room.players.length >= 12) {
                return socket.emit('error', { message: 'Oda dolu! (Maksimum 12 Kişi)' });
            }

            // Check for unique username
            // Case-insensitive check to be safe: 'Ahmet' vs 'ahmet'
            const isTaken = room.players.some(p => p.username.toLowerCase() === username.trim().toLowerCase());
            if (isTaken) {
                return socket.emit('error', { message: 'Bu isimde bir oyuncu zaten odada var. Lütfen isminizi değiştirin.' });
            }

            socket.join(code);
            const player = { id: socket.id, username, score: 0, role: null, word: null, vote: null };
            room.players.push(player);

            socket.emit('room_joined', {
                room: code,
                user: username,
                players: room.players,
                isOwner: false,
                isPublic: room.isPublic
            });
            broadcastPlayerList(room);
            broadcastPublicRooms();
            broadcastState(room); // Sync game state to new player
            console.log(`${username} joined ${code}`);
        } else {
            socket.emit('error', { message: 'Oda bulunamadı!' });
        }
    });

    socket.on('get_public_rooms', () => {
        socket.emit('public_rooms_update', getPublicRooms());
    });

    socket.on('start_game', ({ room: code }) => {
        const room = rooms[code];
        if (room) startGame(room);
    });

    socket.on('kick_player', ({ room: code, targetId }) => {
        const room = rooms[code];
        if (!room) return;

        // Only owner can kick
        if (room.ownerId !== socket.id) return;
        if (targetId === socket.id) return; // Can't kick self

        const targetPlayer = room.players.find(p => p.id === targetId);
        if (targetPlayer) {
            io.to(targetId).emit('kicked');
            // Force disconnect logic
            io.sockets.sockets.get(targetId)?.leave(code);

            room.players = room.players.filter(p => p.id !== targetId);

            // Handle Mid-Game Kick Logic
            if (room.state.phase === PHASE.WRITING) {
                const currentWriterId = room.state.turnOrder?.[room.state.turnIndex];
                if (currentWriterId === targetId) {
                    console.log(`Kicked player was active writer (${targetPlayer.username}). Advancing turn...`);
                    if (room.timerInterval) clearInterval(room.timerInterval);
                    advanceTurn(room);
                }
            }

            broadcastPlayerList(room);
            broadcastPublicRooms();
        }
    });

    socket.on('submit_word', ({ room: code, word }) => {
        const room = rooms[code];
        if (!room) return;

        // Validation: Must be WRITING phase + My Turn
        if (room.state.phase !== PHASE.WRITING) return;

        const currentWriterId = room.state.turnOrder[room.state.turnIndex];
        if (socket.id !== currentWriterId) return; // Not your turn

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.word = word;
            advanceTurn(room);
        }
    });

    socket.on('submit_vote', ({ room: code, targetId }) => {
        const room = rooms[code];
        if (room && room.state.phase === PHASE.VOTING) {
            const player = room.players.find(p => p.id === socket.id);
            player.vote = targetId;
            // If all ACTIVE and ONLINE players voted
            const activeOnlinePlayers = room.players.filter(p => p.role && !p.isOffline);

            // Also check if we have enough votes (e.g. if everyone left, force end?)
            // For now, just check if all online active players voted
            if (activeOnlinePlayers.length > 0 && activeOnlinePlayers.every(p => p.vote)) {
                calculateResults(room);
            } else if (activeOnlinePlayers.length === 0) {
                // Everyone offline? End phase immediately
                calculateResults(room);
            }
        }
    });

    socket.on('skip_discussion', ({ room: code }) => {
        const room = rooms[code];
        if (room && room.state.phase === PHASE.DISCUSSING) {
            const player = room.players.find(p => p.id === socket.id);
            if (player && !player.hasSkippedDiscussion) {
                player.hasSkippedDiscussion = true;

                // Check if ALL ACTIVE and ONLINE players skipped
                const activeOnlinePlayers = room.players.filter(p => p.role && !p.isOffline);

                // Broadcast the change so clients can update their counters
                broadcastPlayerList(room);

                if (activeOnlinePlayers.length > 0 && activeOnlinePlayers.every(p => p.hasSkippedDiscussion)) {
                    setPhase(room, PHASE.VOTING, 30);
                } else if (activeOnlinePlayers.length === 0) {
                    // Failsafe if everyone left/offline
                    setPhase(room, PHASE.VOTING, 30);
                }
            }
        }
    });

    socket.on('skip_match_end', ({ room: code }) => {
        const room = rooms[code];
        if (room && room.state.phase === PHASE.MATCH_END) {
            const player = room.players.find(p => p.id === socket.id);
            if (player && !player.hasSkipped) {
                player.hasSkipped = true;

                // Check if ALL ACTIVE and ONLINE players skipped
                const activeOnlinePlayers = room.players.filter(p => p.role && !p.isOffline);

                broadcastPlayerList(room);

                if (activeOnlinePlayers.length > 0 && activeOnlinePlayers.every(p => p.hasSkipped)) {
                    setPhase(room, PHASE.LOBBY, 0);
                    resetMatch(room);
                } else if (activeOnlinePlayers.length === 0) {
                    // Failsafe
                    setPhase(room, PHASE.LOBBY, 0);
                    resetMatch(room);
                }
            }
        }
    });

    socket.on('toggle_ready', ({ room: code }) => {
        const room = rooms[code];
        if (!room || room.state.phase !== PHASE.LOBBY) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = !player.isReady;
            broadcastPlayerList(room);

            // Check start conditions
            const allReady = room.players.length >= 2 && room.players.every(p => p.isReady);

            if (allReady) {
                // Start countdown
                console.log(`All players ready in room ${code}. Starting countdown...`);
                setPhase(room, PHASE.LOBBY, 4);
            } else {
                // Cancel countdown if it was running
                if (room.state.timer > 0) {
                    console.log(`Readiness broken in room ${code}. Cancelling countdown.`);
                    setPhase(room, PHASE.LOBBY, 0);
                }
            }
        }
    });

    socket.on('chat_message', ({ room: code, message, username }) => {
        if (code) io.to(code).emit('chat_message', { username, message });
    });

    socket.on('admin_skip_phase', ({ room: roomCode, password }) => {
        if (password !== 'Obi4amkebap4etatanamaykami') return;
        const room = rooms[roomCode];
        if (!room) return;

        console.log(`[ADMIN] Skipping phase in room ${roomCode} (Current: ${room.state.phase})`);

        // Clear existing timer to prevent double-firing
        if (room.timerInterval) clearInterval(room.timerInterval);

        if (room.state.phase === PHASE.LOBBY) {
            startGame(room);
        } else {
            handlePhaseTimeout(room);
        }
    });

    socket.on('disconnect', () => {
        const room = getMyRoom();
        if (room) {
            const player = room.players.find(p => p.id === socket.id);

            if (room.state.phase === PHASE.LOBBY) {
                // In Lobby: Remove completely
                room.players = room.players.filter(p => p.id !== socket.id);

                // Auto-Start Check with Countdown
                const allReady = room.players.length >= 2 && room.players.every(p => p.isReady);

                if (allReady) {
                    console.log(`Unready player disconnected. Starting countdown in room ${room.code}...`);
                    setPhase(room, PHASE.LOBBY, 4);
                } else {
                    // Cancel if conditions not met (and timer was running)
                    if (room.state.timer > 0) {
                        setPhase(room, PHASE.LOBBY, 0);
                    }
                }
            } else {
                if (player) player.isOffline = true;

                // If the player who just disconnected was the current writer, skip them immediately!
                if (room.state.phase === PHASE.WRITING) {
                    const currentWriterId = room.state.turnOrder?.[room.state.turnIndex];
                    if (currentWriterId === socket.id) {
                        console.log(`Current writer ${player?.username} disconnected. Skipping turn...`);
                        if (room.timerInterval) clearInterval(room.timerInterval);
                        advanceTurn(room);
                    }
                }
            }

            // If all players are gone (or all offline?), close room?
            // For now, if 0 players remain in array, delete.
            // If we keep offline players, array length > 0.
            // Let's check if there are any online players left.
            const onlinePlayers = room.players.filter(p => !p.isOffline);

            if (onlinePlayers.length === 0) {
                delete rooms[room.code];
            } else {
                // Owner transfer logic (if owner left/offline)
                if (room.ownerId === socket.id) {
                    room.ownerId = onlinePlayers[0].id;
                    onlinePlayers[0].isOwner = true;
                    if (player) player.isOwner = false;
                    console.log(`Room ${room.code} owner transferred to ${onlinePlayers[0].username}`);
                }

                // Only broadcast to room if it still exists
                broadcastPlayerList(room);
            }
            // Always update public lobby after changes
            broadcastPublicRooms();
        }
    });
});

const PORT = process.env.PORT || 3000;
// Force restart
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
