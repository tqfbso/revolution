// Crew drills (models phase 2, decision 157). Drawing only.
//
// A mortar or missile team used to be two riflemen kneeling near a weapon. Now the men
// serve it: the mortar's gunner kneels at the sight and the loader at the muzzle, who drops
// the bomb, ducks away from the blast with his hands to his helmet, and comes back up with
// the next one; the missile gunner kneels behind his launcher with his hands on its grips.
// On the move the weapon is packed up and the first man carries the tube on his back.
//
// Places are worked out once from where the weapon's parts are (models.ts), so the hands
// meet the model. `serve` only chooses where a man's hands go; the rig does the rest.
import { LAUNCHER_AT, LAUNCHER_GRIP, MORTAR_AT, MORTAR_MUZZLE } from './models';
import { MAN_SCALE, type Soldiers } from './soldiers';

export const WEAPON_LAUNCHER = 1;
export const WEAPON_MORTAR = 2;

/** A kneeling man's hips are this far off the ground, metres. */
const HIPS = 0.5;
const S = MAN_SCALE;

/** One man's place in a team: where he kneels (map units from the unit's centre) and how far he turns from the team's facing to face the weapon. */
export interface Place {
  x: number;
  z: number;
  turn: number;
}

/**
 * The crew of each weapon, first man first. The mortar's gunner is on its left facing
 * across it, the loader on its right level with the muzzle; the missile gunner is straight
 * behind the launcher and his mate back and to the side with his rifle, watching.
 */
export const CREW: readonly (readonly Place[])[] = [
  [],
  [
    { x: LAUNCHER_AT[0], z: LAUNCHER_AT[1] - 0.75 * S, turn: 0 },
    { x: 0.42, z: -0.3, turn: 0 },
  ],
  [
    { x: MORTAR_AT[0] - 0.65 * S, z: MORTAR_AT[1] + 0.2 * S, turn: Math.PI / 2 },
    { x: MORTAR_AT[0] + 0.65 * S, z: MORTAR_AT[1] + 0.55 * S, turn: -Math.PI / 2 },
  ],
];

const step = (a: number, b: number, t: number) => {
  const k = t <= a ? 0 : t >= b ? 1 : (t - a) / (b - a);
  return k * k * (3 - 2 * k);
};

/**
 * Put the hands of man `man` of a team on its `weapon` for the next `soldiers.man`. `since`
 * is seconds since the weapon fired, `reload` the seconds between its shots. False when
 * this man keeps his rifle (the missile team's second man).
 */
export function serve(
  soldiers: Soldiers,
  weapon: number,
  man: number,
  since: number,
  reload: number,
): boolean {
  if (weapon === WEAPON_LAUNCHER) {
    if (man !== 0) return false;
    const y = LAUNCHER_GRIP[0] - 0.12 - HIPS;
    const z = 0.75 + LAUNCHER_GRIP[1];
    // He rides the kick of the launch for a moment.
    const kick = step(0, 0.08, since) * (1 - step(0.15, 0.6, since));
    soldiers.drill(0.13, y, z - 0.05 * kick, -0.13, y, z - 0.05 * kick, 0.12 + 0.1 * kick);
    return true;
  }
  // Away from the blast: bowed, hands to the helmet.
  const duck = step(0.12, 0.3, since) * (1 - step(1.0, 1.5, since));
  if (man === 0) {
    // The gunner, at the sight on the bipod.
    const y = MORTAR_MUZZLE[0] * 0.62 + 0.03 - HIPS;
    const k = 1 - duck;
    soldiers.drill(
      -0.08 * k + 0.12 * duck,
      y * k + 0.45 * duck,
      0.5 * k + 0.34 * duck,
      -0.22 * k - 0.12 * duck,
      y * k + 0.45 * duck,
      0.5 * k + 0.34 * duck,
      0.1 + 0.4 * duck,
    );
    return true;
  }
  // The loader: hands at the muzzle as the bomb goes down and again as the next shot comes
  // due, the next bomb held ready at his chest between.
  const next =
    step(reload - 0.9, reload - 0.35, since) * (1 - step(reload + 0.5, reload + 1.2, since));
  const drop = Math.min(1, 1 - step(0.12, 0.3, since) + next);
  const d = Math.min(duck, 1 - drop);
  const hold = 1 - drop - d;
  const my = MORTAR_MUZZLE[0] + 0.04 - HIPS;
  soldiers.drill(
    0.11 * drop + 0.12 * d + 0.08 * hold,
    my * drop + 0.45 * d + 0.2 * hold,
    0.58 * drop + 0.34 * d + 0.3 * hold,
    -0.01 * drop - 0.12 * d - 0.08 * hold,
    my * drop + 0.45 * d + 0.2 * hold,
    0.58 * drop + 0.34 * d + 0.3 * hold,
    0.3 * drop + 0.42 * d + 0.05 * hold,
  );
  return true;
}
