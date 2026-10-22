import Phaser from 'phaser';
import { MatchScene } from './render/MatchScene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: window.innerWidth,
  height: window.innerHeight,
  // Nearest-neighbour textures, but no forced rounding: the scene snaps to
  // screen pixels itself so movement is smooth at integer zoom.
  antialias: false,
  antialiasGL: false,
  roundPixels: false,
  backgroundColor: '#0d130d',
  scale: { mode: Phaser.Scale.RESIZE },
  input: { gamepad: true },
  scene: [MatchScene],
});

// Dev-only handle for debugging in the browser console.
if (import.meta.env.DEV) Object.assign(window, { __game: game });
