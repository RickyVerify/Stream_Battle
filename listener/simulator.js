// Libreria
const { io } = require('socket.io-client');
// Mi collego al server di gioco
const socket = io('http://localhost:4000');

const comandi     = ['JOIN', 'LEFT', 'RIGHT'];
const utentiFinti = ['mario_rossi', 'anna_v', 'giulio99'];

// Ogni 1.5s invio un comando casuale
setInterval(() => {
    const utente  = utentiFinti[Math.floor(Math.random() * utentiFinti.length)];
    const comando = comandi    [Math.floor(Math.random() * comandi.length)];

    // Invio l'evento
    socket.emit('player_command', {userId   : utente,
                                   username : utente,
                                   avatarUrl: 'https://placehold.co/64x64',
                                   command  : comando });
    console.log(`Simulato: ${utente} -> ${comando}`);
    }, 1500);