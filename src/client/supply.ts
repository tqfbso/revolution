// The player's supply area, worked out on the client from what the snapshot already
// carries (base buildings, towns, trucks) with the same stamp the simulation uses, so the
// minimap can show where the army is fed without the worker sending a map every second.
import { BUILDINGS } from '../sim/economy';
import { fx } from '../sim/fixed';
import {
  SUPPLY_BASE,
  SUPPLY_CELLS,
  SUPPLY_DIM,
  SUPPLY_LINK,
  SUPPLY_TOWN,
  SUPPLY_TRUCK,
  stampSupply,
} from '../sim/logistics';
import type { GameMap } from '../sim/map';
import { KIND_TRUCK } from '../sim/units';
import { TICK_RATE } from '../sim/world';
import { BASE_STRIDE, TASK_HUNGRY, type Snapshot } from '../worker/protocol';
import type { UnitView } from './units';

const ME = 0;

export class SupplyView {
  /** 1 per 16 m square of the map where the player's army is in supply. */
  readonly area = new Uint8Array(SUPPLY_CELLS);
  /** Counts changes, for whoever draws the area. */
  version = 0;
  /** The player's units that are out of rations, and where the first of them stands. */
  hungry: number[] = [];
  private last = -1000;

  constructor(
    private readonly map: GameMap,
    private readonly units: UnitView,
  ) {}

  /** Is the ground at world (x, z) in the player's supply? */
  covers(x: number, z: number): boolean {
    const cx = Math.min(SUPPLY_DIM - 1, Math.max(0, x >> 4));
    const cy = Math.min(SUPPLY_DIM - 1, Math.max(0, z >> 4));
    return this.area[cy * SUPPLY_DIM + cx] !== 0;
  }

  applySnapshot(s: Snapshot): void {
    // Once a second is as often as the simulation looks.
    if (s.tick - this.last < TICK_RATE && s.tick >= this.last) return;
    this.last = s.tick;
    const u = this.units;
    this.hungry = [];
    for (let i = 0; i < s.count; i++) {
      if (u.isMine(i) && (s.task[i] & TASK_HUNGRY) !== 0) this.hungry.push(i);
    }
    const out = this.area;
    out.fill(0);
    const fixed: number[] = [];
    for (let o = 0; o < s.bases.length; o += BASE_STRIDE) {
      const b = BUILDINGS[s.bases[o + 1]];
      if (s.bases[o + 2] !== ME || !b.dropOff || s.bases[o + 5] < 100) continue;
      if (s.structHp[s.bases[o]] === 0) continue;
      fixed.push(
        fx((s.bases[o + 3] + b.w / 2) * 4),
        fx((s.bases[o + 4] + b.h / 2) * 4),
        SUPPLY_BASE,
      );
    }
    for (let t = 0; t < this.map.townCount; t++) {
      if (s.townOwner[t] !== ME) continue;
      fixed.push(this.map.townX[t], this.map.townY[t], this.map.townR[t] + SUPPLY_TOWN);
    }
    for (let k = 0; k < fixed.length; k += 3) {
      stampSupply(out, 0, fixed[k], fixed[k + 1], fixed[k + 2]);
    }
    for (let i = 0; i < s.count; i++) {
      if (!u.isMine(i) || u.kindOf(i) !== KIND_TRUCK) continue;
      const x = fx(s.positions[2 * i]);
      const y = fx(s.positions[2 * i + 1]);
      for (let k = 0; k < fixed.length; k += 3) {
        const dx = fixed[k] - x;
        const dy = fixed[k + 1] - y;
        if (dx * dx + dy * dy > SUPPLY_LINK * SUPPLY_LINK) continue;
        stampSupply(out, 0, x, y, SUPPLY_TRUCK);
        break;
      }
    }
    // No depot and no town: the army is not on the supply system (see the logistics).
    if (fixed.length === 0) out.fill(1);
    this.version++;
  }
}
