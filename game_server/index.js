// Prendo le librerie
const express    = require('express'  );   // Crea l'applicazione web (gestisce HTTP)
const http       = require('http'     );   
const { Server } = require('socket.io');

// Gestisco il server
const app    = express();                 // Centralino di ricevimento per i giocatori: fornisce le regole
const server = http.createServer(app);    // Porta (fisica) di inresso del server gestita da app
const io     = new Server(server, {cors: {origin: '*'}}); // Permette di fare più richieste al server

// ======================= CONFIGURAZIONE =======================
const ARENA_WIDTH      = 1280;
const ARENA_HEIGHT     = 720 ;
const LOBBY_DURATION   = 30  ; // secondi di attesa iscrizioni
const MATCH_DURATION   = 180 ; // secondi di partita (3 minuti)
const RESULTS_DURATION = 10  ; // secondi mostra podio

const PHASES = {LOBBY  : 'LOBBY'  ,
                PLAYING: 'PLAYING',
                RESULTS: 'RESULTS'};

// Mappa regalo -> effetto power-up (personalizza con gli ID veri di TikTok/YouTube)
const GIFT_EFFECTS = {rose  : {type: 'SPEED_BOOST', duration: 10},
                      lion  : {type: 'SIZE_UP'    , duration: 15},
                      galaxy: {type: 'EXTRA_LIFE' , duration: 0 }};

// ======================= STATO GLOBALE =======================
let state = {phase      : PHASES.LOBBY  ,
             timer      : LOBBY_DURATION,
             players    : new Map()     ,  // userId -> playerObject
             leaderboard: {}            }; // userId -> vittorie totali

// ======================= STATE MACHINE =======================
function tick() {
    state.timer = state.timer - 1;

    switch (state.phase) {
        case PHASES.LOBBY:
            if (state.timer <= 0)
                startMatch();
            break;

        case PHASES.PLAYING:
            updatePhysics();
            if (checkWinCondition() || state.timer <= 0)
                endMatch();
            break;

        case PHASES.RESULTS:
            if (state.timer <= 0)
                resetMatch();
            break;
    }

    io.emit('state_update', serializeState());
}

function startMatch() {
    // Nessuno si è iscritto: resta in lobby ancora un po'
    if (state.players.size === 0) {
      state.timer = LOBBY_DURATION;
      return;
    }

    state.phase = PHASES.PLAYING;
    state.timer = MATCH_DURATION;
    currentArenaMargin = 0;
    console.log(`Partita iniziata con ${state.players.size} giocatori`);
}

function endMatch() {
    const winner = computeWinner();
    if (winner) {
        state.leaderboard[winner.userId] = (state.leaderboard[winner.userId] || 0) + 1;
    }
    state.phase = PHASES.RESULTS;
    state.timer = RESULTS_DURATION;
    io.emit('match_ended', { winner, leaderboard: state.leaderboard });
    console.log(`Partita finita. Vincitore: ${winner ? winner.username : 'nessuno'}`);
}

function resetMatch() {
  state.players.clear();
  state.phase = PHASES.LOBBY;
  state.timer = LOBBY_DURATION;
}



function serializeState() {
    return {phase      : state.phase                       ,
            timer      : state.timer                       ,
            arenaMargin: currentArenaMargin                ,
            players    : Array.from(state.players.values())};
}



//----------------------------------------------------------------------------------
// Utile per riempire la chiave userId con i dati effettivi del giocatore
//----------------------------------------------------------------------------------
function createPlayer (userId, username, avatarUrl) {
    return {userId                                              ,
            username                                            ,
            avatarUrl                                           ,
            x        : Math.random() * (ARENA_WIDTH  - 100) + 50,
            y        : Math.random() * (ARENA_HEIGHT - 100) + 50,
            vx       : 0                                        ,
            vy       : 0                                        ,
            size     : 20                                       ,
            lives    : 1                                        ,
            alive    : true                                     ,
            powerUps : []                                       };
}

//----------------------------------------------------------------------------------
// Permette di gestire la creazione del giocatore
//
// Se la chat scrive "JOIN" devo:
// 1: verificare che mi trovo nella lobby
// 2: sa mi trovo nella lobby, il palyer non deve esistere per essere creato
//
// Se viene effettuato un altro comando, devo vedere se il player esiste, è vivo o sta giocando:
// 1: il player esegue il comando
//----------------------------------------------------------------------------------
function handleCommand ({userId, username, avatarUrl, command}) {

    if (command === 'JOIN') {
        // Il giocatore può entrare solo se sto in lobby, altrimenti termino la funzione
        if (state.phase !== PHASES.LOBBY)
            return;

        // Se sto in lobby, controllo che il giocatore sia nuovo prima lo inserisco
        if (!state.players.has(userId)) {
            state.players.set(userId, createPlayer(userId, username, avatarUrl));
            console.log(`${username} è entrato in partita`);
        }
        return;
    }


    const player = state.players.get(userId);
    if (!player || !player.alive || state.phase !== PHASES.PLAYING) 
        return;

    const SPEED = 4;
    if (command === 'LEFT' ) player.vx = -SPEED;
    if (command === 'RIGHT') player.vx =  SPEED;
    if (command === 'UP'   ) player.vy = -SPEED;
    if (command === 'DOWN' ) player.vy =  SPEED;
    if (command === 'BOOST') applyPowerUp(player, {type:'SPEED_BOOST', duration: 3});
}

//----------------------------------------------------------------------------------
// Controlla quale regalo assegnare se:
// 1: il player esiste
// 2: se esiste, gli assegno il regalo
//----------------------------------------------------------------------------------
function handleGift({userId, giftId}) {
    const player = state.players.get(userId);
    if (!player)
        return;

    const effect = GIFT_EFFECTS[giftId];
    if (!effect)
        return;

    applyPowerUp(player, effect);
    console.log(`${player.username} ha ricevuto power-up: ${effect.type}`);
}

//----------------------------------------------------------------------------------
function applyPowerUp(player, effect) {
    if (effect.type === 'SIZE_UP'    ) player.size            = 40;
    if (effect.type === 'EXTRA_LIFE' ) player.lives          += 1 ;
    if (effect.type === 'SPEED_BOOST') player.speedMultiplier = 2 ;

    player.powerUps.push({ ...effect, expiresAt: Date.now() + effect.duration * 1000 });
}
//----------------------------------------------------------------------------------

function expirePowerUps(player) {
    const now = Date.now();
    player.powerUps = player.powerUps.filter(p => {
        if (p.expiresAt <= now) {
            if (p.type === 'SIZE_UP'    ) player.size            = 20;
            if (p.type === 'SPEED_BOOST') player.speedMultiplier = 1 ;
            return false;
        }
        return true;
    });
}


// ======================= FISICA / LOGICA DI GIOCO =======================
function updatePhysics() {
    // Tra tutti i giocatori, prendo quelli vivi (p)
    const players = Array.from(state.players.values()).filter(p => p.alive);

    // Muovi ogni player: metto in mult il moltiplicatore di velocità attuale
    players.forEach(p => {
	    const mult = p.speedMultiplier || 1;
        p.x = p.x + p.vx * mult;
        p.y = p.y + p.vy * mult;

        // Impedisco al giocatore di uscire dall'arena
        p.x = Math.max(p.size, Math.min(ARENA_WIDTH  - p.size, p.x));
        p.y = Math.max(p.size, Math.min(ARENA_HEIGHT - p.size, p.y));

        // Se il powerup è scaduto, ripristino l'effetto
        expirePowerUps(p);
    });

    // Collisioni semplici: chi si scontra con uno più grande viene eliminato
    // per ogni giocatore vivo a coppia
    for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
            const a = players[i];
            const b = players[j];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            // Se si toccano, li elimino
            if (dist < (a.size + b.size) / 1.5) {
                eliminateSmaller(a, b);
            }
        }
    }

    // Restringimento arena progressivo
    shrinkArena();
}

//----------------------------------------------------------------------------------
// Elimino il giocatore più piccolo quando si scontrano
//----------------------------------------------------------------------------------
function eliminateSmaller(a, b) {
    // Prendo il più piccolo
    const loser = a.size <= b.size ? a : b;
    if (loser.lives > 1) {
        loser.lives = loser.lives - 1; // Diminuisco le vite
        loser.size  = 20;              // reset size dopo aver perso una vita
    } else {
        loser.alive = false;
    }
}

//----------------------------------------------------------------------------------
// Rimpicciolisco l'arena se sto in fase di gioco
//----------------------------------------------------------------------------------
let currentArenaMargin = 0;
function shrinkArena() {
    if (state.phase !== PHASES.PLAYING)
        return;

    const progress = 1 - (state.timer / MATCH_DURATION); // 0 -> 1 nel tempo
    currentArenaMargin = progress * (ARENA_WIDTH * 0.3);

    state.players.forEach(p => {
        if (p.alive && (p.x < currentArenaMargin || p.x > ARENA_WIDTH - currentArenaMargin)) {
            p.alive = false; // fuori dai bordi ristretti = eliminato
        }
    });
}

//----------------------------------------------------------------------------------
// Controllo che ci sia il vincitore
//----------------------------------------------------------------------------------
function checkWinCondition() {
    const alive = Array.from(state.players.values()).filter(p => p.alive);
    return state.players.size > 1 && alive.length <= 1;
}

function computeWinner() {
    const alive = Array.from(state.players.values()).filter(p => p.alive);
    if (alive.length > 0) return alive[0];
    // Se nessuno è sopravvissuto (raro), vince chi ha resistito di più (già eliminato per ultimo)
    return Array.from(state.players.values())[0] || null;
}





// ======================= CONNESSIONI SOCKET.IO =======================
// Ogni volta che un nuovo client si connette al server
io.on('connection', (socket) => {
    console.log('Client connesso:', socket.id);

    // Invia subito lo stato attuale al nuovo client (es. il frontend appena aperto)
    socket.emit('state_update', serializeState());

    socket.on('player_command', handleCommand);
    socket.on('player_gift'   , handleGift);

    socket.on('disconnect', () => {
    console.log('Client disconnesso:', socket.id);
    });
});

// ===== AVVIO =====
setInterval(tick, 1000);

server.listen(4000, () => {
  console.log('Game server attivo su porta 4000');
});