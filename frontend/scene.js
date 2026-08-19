class ArenaScene extends Phaser.Scene {
  constructor() {
    super('ArenaScene');
    this.avatarSprites = new Map();  // userId -> { container, circle, label }
    this.loadedTextures = new Set(); // per non ricaricare due volte la stessa immagine
    this.currentPhase = 'LOBBY';
  }

  preload() {
    // Texture di fallback nel caso una foto profilo non si carichi
    this.load.image('default_avatar', 'https://placehold.co/64x64/png');
  }

  create() {
    // Testi di stato in alto
    this.phaseText = this.add.text(20, 20, '', { fontSize: '28px', color: '#ffffff', fontStyle: 'bold' });
    this.timerText = this.add.text(20, 60, '', { fontSize: '22px', color: '#ffff00' });
    this.countText = this.add.text(20, 90, '', { fontSize: '18px', color: '#aaaaaa' });

    // Testo podio (nascosto finché non serve)
    this.winnerText = this.add.text(640, 300, '', {
      fontSize: '48px', color: '#00ff00', fontStyle: 'bold'
    }).setOrigin(0.5).setVisible(false);

    // Rettangolo per mostrare visivamente l'arena che si restringe
    this.arenaBoundsGraphics = this.add.graphics();

    // Connessione al game-server
    this.socket = io('http://localhost:4000');

    this.socket.on('state_update', (state) => this.syncState(state));
    this.socket.on('match_ended', (result) => this.showWinner(result));
  }

  syncState(state) {
    this.currentPhase = state.phase;
    this.phaseText.setText(this.phaseLabel(state.phase));
    this.timerText.setText(`Tempo: ${state.timer}s`);
    this.countText.setText(`Giocatori: ${state.players.length}`);

    if (state.phase === 'PLAYING') {
      this.winnerText.setVisible(false);
      this.drawArenaBounds(state.arenaMargin);
    } else {
      this.arenaBoundsGraphics.clear();
    }

    this.updateAvatars(state.players);
  }

  phaseLabel(phase) {
    if (phase === 'LOBBY') return '🕐 Iscrizioni aperte! Scrivi !join';
    if (phase === 'PLAYING') return '⚔️ Battaglia in corso!';
    if (phase === 'RESULTS') return '🏆 Risultati';
    return phase;
  }

  drawArenaBounds(margin) {
    this.arenaBoundsGraphics.clear();
    this.arenaBoundsGraphics.lineStyle(4, 0xff0000, 0.8);
    this.arenaBoundsGraphics.strokeRect(margin, 0, 1280 - margin * 2, 720);
  }

  updateAvatars(players) {
    const currentIds = new Set(players.map(p => p.userId));

    // Rimuovi sprite di player non più presenti (eliminati o dopo un reset)
    for (const [userId, obj] of this.avatarSprites) {
      if (!currentIds.has(userId)) {
        obj.container.destroy();
        this.avatarSprites.delete(userId);
      }
    }

    players.forEach(p => {
      let obj = this.avatarSprites.get(p.userId);

      if (!obj) {
        obj = this.createAvatarSprite(p);
        this.avatarSprites.set(p.userId, obj);
      }

      // Aggiorna posizione e dimensione in base allo stato ricevuto dal server
      obj.container.setPosition(p.x, p.y);
      obj.circle.setRadius(p.size);
      obj.circle.setVisible(p.alive);
      obj.label.setVisible(p.alive);
      obj.label.setText(p.username);

      // Effetto visivo se ha un power-up attivo
      obj.circle.setStrokeStyle(p.powerUps && p.powerUps.length > 0 ? 4 : 0, 0xffff00);
    });
  }

  createAvatarSprite(p) {
    const container = this.add.container(p.x, p.y);

    const circle = this.add.circle(0, 0, p.size, 0x3399ff);
    const label = this.add.text(0, p.size + 10, p.username, {
      fontSize: '14px', color: '#ffffff'
    }).setOrigin(0.5, 0);

    container.add([circle, label]);

    return { container, circle, label };
  }

  showWinner(result) {
    if (!result.winner) return;
    this.winnerText.setText(`🏆 Vince ${result.winner.username}!`);
    this.winnerText.setVisible(true);
  }
}

const config = {
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: 'game',
  backgroundColor: '#1a1a2e',
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 0 }, debug: false }
  },
  scene: ArenaScene
};

new Phaser.Game(config);