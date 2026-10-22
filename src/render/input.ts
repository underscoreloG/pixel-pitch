import Phaser from 'phaser';
import type { InputFrame } from '../sim/types';

const DEADZONE = 0.18;

// Standard gamepad mapping (Xbox layout): A=0, B=1, X=2, LB=4, RT=7.
const PAD = { pass: 0, shoot: 1, lob: 2, switch: 4, sprint: 7 } as const;

/** Merges keyboard and first gamepad into one InputFrame for the sim. */
export class InputReader {
  private keys: Record<string, Phaser.Input.Keyboard.Key>;
  private requireRelease = false;

  constructor(private scene: Phaser.Scene) {
    this.keys = scene.input.keyboard!.addKeys('UP,DOWN,LEFT,RIGHT,SHIFT,S,D,A,Q') as Record<
      string,
      Phaser.Input.Keyboard.Key
    >;
  }

  /** Ignores kick buttons until they are all released (e.g. the key that closed a menu). */
  disarm(): void {
    this.requireRelease = true;
  }

  read(): InputFrame {
    const k = this.keys;
    // Arrows move with the right hand, kicks sit under the left hand.
    let moveX = (k.RIGHT.isDown ? 1 : 0) - (k.LEFT.isDown ? 1 : 0);
    let moveY = (k.DOWN.isDown ? 1 : 0) - (k.UP.isDown ? 1 : 0);
    const len = Math.hypot(moveX, moveY);
    if (len > 1) {
      moveX /= len;
      moveY /= len;
    }
    const frame: InputFrame = {
      moveX,
      moveY,
      sprint: k.SHIFT.isDown,
      pass: k.S.isDown,
      shoot: k.D.isDown,
      lob: k.A.isDown,
      switch: k.Q.isDown,
    };

    const gp = this.scene.input.gamepad;
    const pad = gp && gp.total > 0 ? gp.getPad(0) : undefined;
    if (pad) {
      const sx = pad.leftStick.x;
      const sy = pad.leftStick.y;
      if (Math.hypot(sx, sy) > DEADZONE) {
        frame.moveX = sx;
        frame.moveY = sy;
      }
      const pressed = (i: number) => (pad.buttons[i]?.value ?? 0) > 0.3;
      frame.sprint ||= pressed(PAD.sprint);
      frame.pass ||= pressed(PAD.pass);
      frame.shoot ||= pressed(PAD.shoot);
      frame.lob ||= pressed(PAD.lob);
      frame.switch ||= pressed(PAD.switch);
    }
    if (this.requireRelease) {
      if (frame.pass || frame.shoot || frame.lob) frame.pass = frame.shoot = frame.lob = false;
      else this.requireRelease = false;
    }
    return frame;
  }
}
