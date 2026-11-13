// Sub-commanders, the part of them that is game state: which units answer to which
// commander, what each has been told to do, and what it is to be kept at. How a mission is
// carried out is not decided here: that is the staff (src/sim/staff.ts), which reads this
// table and hands in ordinary commands, exactly like a computer player does.
import { CMD_ASSIGN, CMD_MISSION, CMD_REINFORCE, type Command } from './commands';
import { clampInt } from './fixed';
import { KIND_COUNT } from './units';
import {
  CF_AUTO,
  KIND_SLOTS,
  MAP_SIZE_FX,
  MAX_COMMANDERS,
  MAX_TEAMS,
  MISSION_COUNT,
  STATE_ALIVE,
  type World,
} from './world';

const have = new Int32Array(MAX_COMMANDERS * KIND_SLOTS);

/** Count, per commander and kind, the living units of `team` that answer to one. */
function muster(w: World, team: number): void {
  have.fill(0);
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] !== STATE_ALIVE || w.team[i] !== team || w.cmdr[i] < 0) continue;
    have[w.cmdr[i] * KIND_SLOTS + w.kind[i]]++;
  }
}

/** A commander is never kept below what it has: its establishment follows its roll up. */
function raise(w: World, team: number, slot: number): void {
  const base = (team * MAX_COMMANDERS + slot) * KIND_SLOTS;
  for (let k = 0; k < KIND_COUNT; k++) {
    if (have[slot * KIND_SLOTS + k] > w.cEst[base + k])
      w.cEst[base + k] = have[slot * KIND_SLOTS + k];
  }
}

function release(w: World, id: number): void {
  const slot = w.cmdr[id];
  if (slot < 0) return;
  const e = (w.team[id] * MAX_COMMANDERS + slot) * KIND_SLOTS + w.kind[id];
  if (w.cEst[e] > 0) w.cEst[e]--;
  w.cmdr[id] = -1;
}

const validSlot = (team: number, slot: number) =>
  Number.isInteger(team) &&
  team >= 0 &&
  team < MAX_TEAMS &&
  Number.isInteger(slot) &&
  slot >= 0 &&
  slot < MAX_COMMANDERS;

/** Apply a commander command. False if `cmd` is not one. */
export function applyCommanderCommand(w: World, cmd: Command): boolean {
  switch (cmd.type) {
    case CMD_ASSIGN: {
      const slot = cmd.slot | 0;
      if (slot < -1 || slot >= MAX_COMMANDERS || !Array.isArray(cmd.units)) return true;
      const teams = [false, false, false];
      for (const raw of cmd.units) {
        const id = raw | 0;
        if (id < 0 || id >= w.count || w.state[id] !== STATE_ALIVE || w.cmdr[id] === slot) continue;
        release(w, id);
        w.cmdr[id] = slot;
        teams[w.team[id]] = true;
      }
      if (slot < 0) return true;
      for (let team = 0; team < MAX_TEAMS; team++) {
        if (!teams[team]) continue;
        muster(w, team);
        raise(w, team, slot);
      }
      return true;
    }
    case CMD_MISSION: {
      if (!validSlot(cmd.team, cmd.slot)) return true;
      const c = cmd.team * MAX_COMMANDERS + cmd.slot;
      const mission = cmd.mission | 0;
      if (mission >= MISSION_COUNT || mission < -1) return true;
      // Where its troops stand now: the near end of a patrol, the place to fall back on.
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < w.count; i++) {
        if (w.state[i] !== STATE_ALIVE || w.team[i] !== cmd.team || w.cmdr[i] !== cmd.slot)
          continue;
        if (mission < 0) w.cmdr[i] = -1;
        sx += w.posX[i] >> 4;
        sy += w.posY[i] >> 4;
        n++;
      }
      w.cSeq[c]++;
      if (mission < 0) {
        w.cMission[c] = 0;
        w.cFlags[c] = 0;
        w.cEst.fill(0, c * KIND_SLOTS, (c + 1) * KIND_SLOTS);
        return true;
      }
      w.cMission[c] = mission;
      w.cX[c] = clampInt(cmd.x | 0, 0, MAP_SIZE_FX - 1);
      w.cY[c] = clampInt(cmd.y | 0, 0, MAP_SIZE_FX - 1);
      w.cAX[c] = n === 0 ? w.cX[c] : Math.trunc(sx / n) << 4;
      w.cAY[c] = n === 0 ? w.cY[c] : Math.trunc(sy / n) << 4;
      return true;
    }
    case CMD_REINFORCE: {
      if (!validSlot(cmd.team, cmd.slot)) return true;
      const c = cmd.team * MAX_COMMANDERS + cmd.slot;
      if (cmd.on) w.cFlags[c] |= CF_AUTO;
      else w.cFlags[c] &= ~CF_AUTO;
      return true;
    }
    default:
      return false;
  }
}

/** Hand a unit to commander `slot` of its army: the production centre's "send to". */
export function joinCommander(w: World, id: number, slot: number): boolean {
  if (slot < 0 || slot >= MAX_COMMANDERS) return false;
  release(w, id);
  w.cmdr[id] = slot;
  muster(w, w.team[id]);
  raise(w, w.team[id], slot);
  return true;
}

/**
 * A unit fresh from the factory, bound for no commander in particular: the first commander
 * with reinforcements switched on who is short of its kind takes it. True if one did.
 */
export function claimReinforcement(w: World, id: number): boolean {
  const team = w.team[id];
  const kind = w.kind[id];
  let any = false;
  for (let s = 0; s < MAX_COMMANDERS && !any; s++) {
    any = (w.cFlags[team * MAX_COMMANDERS + s] & CF_AUTO) !== 0;
  }
  if (!any) return false;
  muster(w, team);
  for (let s = 0; s < MAX_COMMANDERS; s++) {
    const c = team * MAX_COMMANDERS + s;
    if ((w.cFlags[c] & CF_AUTO) === 0) continue;
    if (have[s * KIND_SLOTS + kind] < w.cEst[c * KIND_SLOTS + kind]) {
      w.cmdr[id] = s;
      return true;
    }
  }
  return false;
}

/**
 * What the commanders with reinforcements switched on are short of, added per kind to
 * `short` (indexed team * KIND_SLOTS + kind). True if any commander has them switched on.
 */
export function reinforcementsWanted(w: World, short: Int32Array): boolean {
  let any = false;
  for (let c = 0; c < MAX_TEAMS * MAX_COMMANDERS && !any; c++) any = (w.cFlags[c] & CF_AUTO) !== 0;
  if (!any) return false;
  for (let team = 0; team < MAX_TEAMS; team++) {
    let on = false;
    for (let s = 0; s < MAX_COMMANDERS; s++)
      on ||= (w.cFlags[team * MAX_COMMANDERS + s] & CF_AUTO) !== 0;
    if (!on) continue;
    muster(w, team);
    for (let s = 0; s < MAX_COMMANDERS; s++) {
      const c = team * MAX_COMMANDERS + s;
      if ((w.cFlags[c] & CF_AUTO) === 0) continue;
      for (let k = 0; k < KIND_COUNT; k++) {
        const d = w.cEst[c * KIND_SLOTS + k] - have[s * KIND_SLOTS + k];
        if (d > 0) short[team * KIND_SLOTS + k] += d;
      }
    }
  }
  return true;
}
