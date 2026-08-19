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
const MAX_PLAYERS      = 100 ; // numero dei giocatori

let currentArenaMarginX = 0;
let currentArenaMarginY = 0;

const PHASES        = {LOBBY  : 'LOBBY'  ,
                       PLAYING: 'PLAYING',
                       RESULTS: 'RESULTS'};

// Mappa regalo -> effetto power-up (personalizza con gli ID veri di TikTok/YouTube)
const GIFT_EFFECTS  = {rose  : {type: 'SPEED_BOOST', duration: 10},
                       lion  : {type: 'SIZE_UP'    , duration: 15},
                       galaxy: {type: 'EXTRA_LIFE' , duration: 0 }};

let state           = {phase      : PHASES.LOBBY  ,
                       timer      : LOBBY_DURATION,
                       leaderboard: {}            }; // userId -> vittorie totali

// Restituisce un player vuoto
function createEmptyPlayer() {
    return {active         : false,  // true = slot occupato da un giocatore reale
            userId         : null ,
            username       : null ,
            avatarUrl      : null ,
            x              : 0    ,
            y              : 0    ,
            vx             : 0    ,
            vy             : 0    ,
            size           : 20   ,
            lives          : 1    ,
            alive          : false,
            speedMultiplier: 1    ,
            powerUps       : []   };
}

// Inizializzo array di 100 player
const players = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
    players[i] = createEmptyPlayer();
}


// ======================= STATE MACHINE =======================
// Viene chiamata ogni secondo
function tick() {
    state.timer = state.timer - 1;

    switch (state.phase) {

        // ---------------- STATO: LOBBY ----------------
        case PHASES.LOBBY:
            if (state.timer <= 0) {
                // Conto quanti giocatori si sono iscritti
                let activeCount = 0;
                for (let i = 0; i < players.length; i++) {
                    if (players[i].active) {
                        activeCount = activeCount + 1;
                    }
                }

                if (activeCount === 0) {
                    // Nessuno iscritto: rimango in LOBBY, ricarico il timer
                    state.timer         = LOBBY_DURATION;
                    state.phase         = PHASES.LOBBY;
                } else {
                    // Transizione LOBBY -> PLAYING
                    state.phase         = PHASES.PLAYING;
                    state.timer         = MATCH_DURATION;
                    currentArenaMarginX = 0;
                    currentArenaMarginY = 0;
                    console.log(`Partita iniziata con ${activeCount} giocatori`);
                }
            }
            break;

        // ---------------- STATO: PLAYING ----------------
        case PHASES.PLAYING:
            updatePhysics();

            if (checkWinCondition() || state.timer <= 0) {
                // Cerco il vincitore: primo slot attivo e ancora vivo
                let winner = null;
                for (let i = 0; i < players.length; i++) {
                    if (players[i].active && players[i].alive) {
                        winner = players[i];
                        break;
                    }
                }

                // Se nessuno è sopravvissuto, prendo il primo slot ancora attivo trovato
                if (winner === null) {
                    for (let i = 0; i < players.length; i++) {
                        if (players[i].active) {
                            winner = players[i];
                            break;
                        }
                    }
                }

                if (winner !== null) {
                    state.leaderboard[winner.userId] = (state.leaderboard[winner.userId] || 0) + 1;
                }

                // Transizione PLAYING -> RESULTS
                state.phase = PHASES.RESULTS;
                state.timer = RESULTS_DURATION;
                io.emit('match_ended', { winner: winner, leaderboard: state.leaderboard });
                console.log(`Partita finita. Vincitore: ${winner ? winner.username : 'nessuno'}`);
            }
            break;

        // ---------------- STATO: RESULTS ----------------
        case PHASES.RESULTS:
            if (state.timer <= 0) {
                // Libero tutti gli slot occupati, il pool resta sempre di MAX_PLAYERS elementi
                for (let i = 0; i < players.length; i++) {
                    players[i].active = false;
                    players[i].userId = null;
                    players[i].alive  = false;
                }
                // Transizione RESULTS -> LOBBY
                state.phase = PHASES.LOBBY;
                state.timer = LOBBY_DURATION;
            }
            break;
    }

    // Ogni secondo
    io.emit('state_update', serializeState());
}


function checkWinCondition() {
    // Conto quanti slot sono occupati (active) e quanti tra questi sono ancora vivi (alive)
    let activeCount = 0;
    let aliveCount  = 0;

    for (let i = 0; i < players.length; i++) {
        if (players[i].active) {
            activeCount = activeCount + 1;

            if (players[i].alive) {
                aliveCount = aliveCount + 1;
            }
        }
    }

    // La partita finisce quando c'erano almeno 2 iscritti ma ne è rimasto vivo al massimo 1
    return activeCount > 1 && aliveCount <= 1;
}

function serializeState() {
    // Costruisco l'elenco dei soli giocatori attivi, così il frontend riceve solo i dati necessari
    let activePlayers = [];
    for (let i = 0; i < players.length; i++) {
        if (players[i].active) {
            activePlayers.push(players[i]);
        }
    }

    return {
        phase       : state.phase,
        timer       : state.timer,
        arenaMarginX: currentArenaMarginX,
        arenaMarginY: currentArenaMarginY,
        players     : activePlayers  // mando al frontend solo gli slot occupati
    };
}

// ======================= GESTIONE COMANDI DALLA CHAT =======================
//----------------------------------------------------------------------------
//---------------------       Funzioni di supporto       ---------------------
//----------------------------------------------------------------------------
// Cerca uno slot già occupato da userId
function findPlayerById(userId) {
    for (let i = 0; i < players.length; i++) {
        if (players[i].active && players[i].userId === userId) {
            return players[i];
        }
    }
    return undefined; // nessuno trovato
}

// Trova il primo slot non occupato
function findFreeSlot() {
    for (let i = 0; i < players.length; i++) {
        if (!players[i].active) {
            return players[i];
        }
    }
    return undefined; // nessuno slot libero
}

// "Attiva" uno slot libero riempiendolo con i dati del nuovo giocatore
function activatePlayer(slot, userId, username, avatarUrl) {
    slot.active          = true;
    slot.userId          = userId;
    slot.username        = username;
    slot.avatarUrl       = avatarUrl;
    slot.x               = Math.random() * (ARENA_WIDTH  - 100) + 50;
    slot.y               = Math.random() * (ARENA_HEIGHT - 100) + 50;
    slot.vx              = 0;
    slot.vy              = 0;
    slot.size            = 20;
    slot.lives           = 1;
    slot.alive           = true;
    slot.speedMultiplier = 1;
    slot.powerUps        = [];
}

// "Libera" uno slot: torna disponibile per un futuro giocatore
function deactivatePlayer(slot) {
    slot.active = false;
    slot.userId = null;
    slot.alive  = false;
}
//----------------------------------------------------------------------------
//----------------------------------------------------------------------------
//----------------------------------------------------------------------------

function handleCommand({ userId, username, avatarUrl, command }) {

    // ---- Comando JOIN: valido SOLO in fase LOBBY ----
    if (command === 'JOIN' && state.phase === PHASES.LOBBY) {

        // Se il player non esiste lo creo
        if (!findPlayerById(userId)) {
            const slot = findFreeSlot(); // Individuo la prima posizione non occupata (passaggio per riferimento)

            if (!slot) {
                // Spazio esaurito: nessuno slot libero su MAX_PLAYERS
                console.log('Pool pieno: nessuno slot libero (100/100)');
                return;
            } else {
                // Slot trovato: attivo il giocatore
                activatePlayer(slot, userId, username, avatarUrl);
                console.log(`${username} è entrato in partita`);
                return;
            }
        } else {
            return; // Player già iscritto: ignoro il doppio JOIN
        }

    } else if (command !== 'JOIN') {
        // ---- Ogni altro comando: valido SOLO in fase PLAYING, con player esistente e vivo ----
        const player = findPlayerById(userId);

        if (player && player.alive && state.phase === PHASES.PLAYING) {
            const SPEED = 4;
            if (command === 'LEFT' ) player.vx = -SPEED;
            if (command === 'RIGHT') player.vx =  SPEED;
            if (command === 'UP'   ) player.vy = -SPEED;
            if (command === 'DOWN' ) player.vy =  SPEED;
            if (command === 'BOOST') applyPowerUp(player, {type:'SPEED_BOOST', duration: 3});
        } else {
            return; // Player inesistente, eliminato, oppure siamo fuori dalla fase PLAYING: ignoro
        }

    } else {
        return; // JOIN ricevuto ma fuori da LOBBY (PLAYING o RESULTS): iscrizioni chiuse, ignoro
    }
}



function handleGift({ userId, giftId }) {

    const player = findPlayerById(userId);
    if (!player) {
        // Nessuno slot attivo per questo userId: il regalo non ha un player a cui applicarsi
        return;
    } else {
        const effect = GIFT_EFFECTS[giftId];

        if (!effect) {
            // giftId non mappato in GIFT_EFFECTS: regalo non riconosciuto, ignoro
            return;
        } else {

            // ---- Applico l'effetto direttamente al player ----
            if (effect.type === 'SIZE_UP'    ) player.size            = 40;
            if (effect.type === 'EXTRA_LIFE' ) player.lives          += 1 ;
            if (effect.type === 'SPEED_BOOST') player.speedMultiplier = 2 ;

            // Registro il power-up con la sua scadenza, così expirePowerUps() potrà ripristinarlo
            player.powerUps.push({type      : effect.type,
                                  duration  : effect.duration,
                                  expiresAt : Date.now() + effect.duration * 1000
                                });

            console.log(`${player.username} ha ricevuto power-up: ${effect.type}`);
        }
    }
}


// ======================= FISICA / LOGICA DI GIOCO =======================
function updatePhysics() {

    // ---- Costruisco l'elenco dei soli giocatori attivi e ancora vivi ----
    let activePlayers = [];
    for (let i = 0; i < players.length; i++) {
        if (players[i].active && players[i].alive) {
            activePlayers.push(players[i]);
        }
    }

    // ---- Aggiorno posizione, bordi arena e scadenza power-up di ognuno ----
    for (let i = 0; i < activePlayers.length; i++) {
        const p = activePlayers[i];

        const mult = p.speedMultiplier || 1;
        p.x = p.x + p.vx * mult;
        p.y = p.y + p.vy * mult;

        // Impedisco al giocatore di uscire dai bordi fissi dell'arena
        p.x = Math.max(p.size, Math.min(ARENA_WIDTH  - p.size, p.x));
        p.y = Math.max(p.size, Math.min(ARENA_HEIGHT - p.size, p.y));

        // ---- Scadenza power-up ----
        const now = Date.now();
        let stillActivePowerUps = [];

        for (let k = 0; k < p.powerUps.length; k++) {
            const powerUp = p.powerUps[k];

            if (powerUp.expiresAt <= now) {
                // Power-up scaduto: ripristino l'effetto, non lo tengo nell'elenco
                if (powerUp.type === 'SIZE_UP'    ) p.size            = 20;
                if (powerUp.type === 'SPEED_BOOST') p.speedMultiplier = 1 ;

            } else {
                // Power-up ancora attivo: lo mantengo
                stillActivePowerUps.push(powerUp);
            }
        }

        p.powerUps = stillActivePowerUps;
    }

    // ---- Collisioni: ogni coppia di giocatori attivi viene confrontata una sola volta ----
    for (let i = 0; i < activePlayers.length; i++) {
        for (let j = i + 1; j < activePlayers.length; j++) {
            const a = activePlayers[i];
            const b = activePlayers[j];

            const dist = Math.hypot(a.x - b.x, a.y - b.y);

            if (dist < (a.size + b.size) / 1.5) {
                // ---- Elimino il più piccolo ----
                let loser;
                if (a.size <= b.size) {
                    loser = a;
                } else {
                    loser = b;
                }

                if (loser.lives > 1) {
                    loser.lives = loser.lives - 1;
                    loser.size  = 20;
                } else {
                    loser.alive = false; // lo slot resta 'active' ma non più 'alive' fino al reset
                }
            }
        }
    }

    shrinkArena();
}


function shrinkArena() {
    if (state.phase === PHASES.PLAYING) {

        const progress = 1 - (state.timer / MATCH_DURATION); // 0 all'inizio -> 1 a fine partita

        currentArenaMarginX = progress * (ARENA_WIDTH  * 0.3);
        currentArenaMarginY = progress * (ARENA_HEIGHT * 0.3);

        // ---- Controllo ogni giocatore attivo e vivo: se è fuori dai nuovi bordi, lo elimino ----
        for (let i = 0; i < players.length; i++) {
            const p = players[i];

            if (!p.active || !p.alive) {
                // Slot vuoto o giocatore già eliminato: salto al successivo
                continue;
            } else {

                const fuoriX = p.x < currentArenaMarginX || p.x > ARENA_WIDTH  - currentArenaMarginX;
                const fuoriY = p.y < currentArenaMarginY || p.y > ARENA_HEIGHT - currentArenaMarginY;

                if (fuoriX || fuoriY) {
                    p.alive = false;
                }
            }
        }
    } else {
        return; // fuori dalla fase PLAYING l'arena non si restringe
    }
}


function computeWinner() {
    // Primo tentativo: cerco il primo slot che sia sia active che alive
    for (let i = 0; i < players.length; i++) {
        if (players[i].active && players[i].alive) {
            return players[i];
        }
    }

    // Se nessuno è sopravvissuto, prendo comunque il primo slot ancora active
    // (caso raro: tutti eliminati nello stesso istante)
    for (let i = 0; i < players.length; i++) {
        if (players[i].active) {
            return players[i];
        }
    }

    // Nessuno slot occupato: non c'è nessun vincitore possibile
    return null;
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