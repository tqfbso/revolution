// The economy: what things cost, the trucks that pay for them, base buildings and what
// they produce. Three resources with three different shapes (see decision 035):
// supplies scale with trucks and run out, fuel scales with wells held, credits with towns.
import {
  CMD_ASSIST,
  CMD_BUILD,
  CMD_CANCEL,
  CMD_FOUND,
  CMD_GATHER,
  CMD_DEST,
  CMD_KEEP,
  CMD_ORDER,
  CMD_RALLY,
  CMD_REPEAT,
  CMD_RESEARCH,
  CMD_STANCE,
  CMD_TRAIN,
  type Command,
} from './commands';
import { clampInt, fx } from './fixed';
import {
  CELL_FX,
  CELL_SHIFT,
  MAP_CELLS,
  MAX_STRUCTS,
  SITE_FUEL,
  SITE_SUPPLIES,
  S_BASE,
  addStructure,
  canPlace,
  findCell,
} from './map';
import { markTopology, sendTo, spawnUnit, structDist2, validUnits } from './sim';
import {
  KINDS,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_COUNT,
  KIND_DRONE,
  KIND_ENGINEER,
  KIND_EW,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
  POINTS,
} from './units';
import {
  DEST_COMMANDER,
  MAX_COMMANDERS,
  DEST_RALLY,
  DEST_TOWN,
  KIND_SLOTS,
  ORDER_MAX,
  EV_BUILT,
  EV_TIER,
  EV_TRAINED,
  FLAG_AMOVE,
  FLAG_MOVING,
  JOB_BUILD,
  JOB_GATHER,
  JOB_LOAD,
  JOB_NONE,
  JOB_RETURN,
  JOB_WORK,
  MAP_SIZE_FX,
  MAX_TEAMS,
  NO_TEAM,
  QUEUE_MAX,
  STANCE_HOLD_FIRE,
  STATE_ALIVE,
  TICK_RATE,
  type World,
} from './world';

export const B_HQ = 0;
export const B_DEPOT = 1;
export const B_BARRACKS = 2;
export const B_WORKS = 3;
export const B_DRONES = 4;
export const B_COUNT = 5;

export interface Price {
  supplies: number;
  fuel: number;
  credits: number;
  /** Ticks of work: for a building, of one truck. */
  ticks: number;
  /** Technology tier needed. */
  tier: number;
}

export interface Building extends Price {
  name: string;
  /** Footprint in cells. */
  w: number;
  h: number;
  hp: number;
  floors: number;
  /** Trucks unload here. */
  dropOff: boolean;
  /** Units it lets the army field. */
  cap: number;
}

export const BUILDINGS: readonly Building[] = [
  {
    name: 'Headquarters',
    w: 3,
    h: 3,
    hp: 3000,
    floors: 3,
    dropOff: true,
    cap: 60,
    supplies: 600,
    fuel: 0,
    credits: 300,
    ticks: 2400,
    tier: 2,
  },
  {
    name: 'Supply depot',
    w: 2,
    h: 2,
    hp: 900,
    floors: 2,
    dropOff: true,
    cap: 40,
    supplies: 150,
    fuel: 0,
    credits: 0,
    ticks: 400,
    tier: 1,
  },
  {
    name: 'Barracks',
    w: 3,
    h: 2,
    hp: 1200,
    floors: 2,
    dropOff: false,
    cap: 0,
    supplies: 200,
    fuel: 0,
    credits: 0,
    ticks: 600,
    tier: 1,
  },
  {
    name: 'Motor pool',
    w: 3,
    h: 3,
    hp: 1800,
    floors: 3,
    dropOff: false,
    cap: 0,
    supplies: 300,
    fuel: 100,
    credits: 0,
    ticks: 900,
    tier: 1,
  },
  {
    name: 'Drone workshop',
    w: 2,
    h: 2,
    hp: 800,
    floors: 2,
    dropOff: false,
    cap: 0,
    supplies: 200,
    fuel: 0,
    credits: 150,
    ticks: 600,
    tier: 1,
  },
];

export interface UnitPrice extends Price {
  /** Building type that produces it. */
  from: number;
}

const price = (
  from: number,
  tier: number,
  supplies: number,
  fuel: number,
  credits: number,
  seconds: number,
): UnitPrice => ({ from, tier, supplies, fuel, credits, ticks: seconds * TICK_RATE });

/** Per unit type (KIND_*): what it costs, how long it takes, where and from which tier. */
export const UNIT_PRICE: readonly UnitPrice[] = (() => {
  const t = new Array<UnitPrice>(KIND_COUNT);
  t[KIND_TRUCK] = price(B_HQ, 1, 60, 0, 0, 10);
  t[KIND_INFANTRY] = price(B_BARRACKS, 1, 40, 0, 0, 5);
  t[KIND_RECON] = price(B_BARRACKS, 1, 40, 0, 20, 8);
  t[KIND_ATGM] = price(B_BARRACKS, 1, 70, 0, 10, 8);
  t[KIND_ENGINEER] = price(B_BARRACKS, 1, 50, 0, 0, 7);
  t[KIND_IFV] = price(B_WORKS, 1, 150, 60, 0, 25);
  t[KIND_TANK] = price(B_WORKS, 2, 320, 160, 0, 55);
  t[KIND_AD] = price(B_WORKS, 2, 160, 60, 60, 28);
  t[KIND_ARTILLERY] = price(B_WORKS, 3, 240, 100, 120, 50);
  t[KIND_EW] = price(B_WORKS, 3, 150, 60, 200, 35);
  t[KIND_DRONE] = price(B_DRONES, 1, 30, 0, 30, 6);
  t[KIND_STRIKE] = price(B_DRONES, 2, 50, 0, 60, 8);
  return t;
})();

/** The price of the step up from tier 1 and from tier 2 (index: the tier the army has). */
export const TIER_PRICE: readonly (Price | null)[] = [
  null,
  { supplies: 400, fuel: 0, credits: 300, ticks: 40 * TICK_RATE, tier: 1 },
  { supplies: 800, fuel: 200, credits: 800, ticks: 60 * TICK_RATE, tier: 2 },
];
export const MAX_TIER = 3;
/** Queue entry that stands for the next technology tier instead of a unit. */
export const TIER_ITEM = 255;

/** What a truck carries per trip and how long it takes to load. */
export const TRUCK_LOAD = 20;
export const LOAD_TICKS = 100;
/** A well pumps this much a second into a tank this big; trucks take what is in it. */
export const WELL_RATE = 3;
export const WELL_TANK = 300;
/** No army fields more than this many army points (see POINTS), however many depots it builds. */
export const POP_MAX = 800;
/** Trucks that can usefully work on one building at once. */
export const MAX_BUILDERS = 5;
/** Health a truck restores per tick on a finished building of its own army. */
const REPAIR_RATE = 2;
const SITE_REACH = fx(6);
const DROP_REACH = fx(5);
/** A truck whose stockpile ran dry looks this far for another. */
const SITE_SEARCH = fx(160);

const builders = new Uint8Array(MAX_STRUCTS);
const priceOf = (item: number, tier: number): Price | null =>
  (item === TIER_ITEM ? TIER_PRICE[tier] : UNIT_PRICE[item]) ?? null;

function canPay(w: World, team: number, p: Price): boolean {
  return w.supplies[team] >= p.supplies && w.fuel[team] >= p.fuel && w.credits[team] >= p.credits;
}

function pay(w: World, team: number, p: Price, sign: number): void {
  w.supplies[team] -= sign * p.supplies;
  w.fuel[team] -= sign * p.fuel;
  w.credits[team] -= sign * p.credits;
}

/** A base building `team` owns that stands and (if `finished`) is complete, else false. */
function ownBase(w: World, s: number, finished: boolean): boolean {
  if (!Number.isInteger(s) || s < 0 || s >= w.map.structCount) return false;
  if (w.sTeam[s] === NO_TEAM || w.sHp[s] <= 0) return false;
  return !finished || w.sBuild[s] >= BUILDINGS[w.sType[s]].ticks;
}

/** Put a base building on the map. Returns its structure id, or -1 if it cannot stand there. */
function place(w: World, team: number, type: number, x: number, y: number, done: boolean): number {
  const b = BUILDINGS[type];
  const map = w.map;
  if (map.structCount >= MAX_STRUCTS || !canPlace(map, x, y, b.w, b.h)) return -1;
  const s = addStructure(map, S_BASE, x, y, b.w, b.h, -1, b.floors);
  map.sMaxHp[s] = b.hp;
  w.sHp[s] = done ? b.hp : Math.trunc(b.hp / 10);
  w.sRepair[s] = 0;
  w.sOcc[s] = 0;
  w.sTeam[s] = team;
  w.sType[s] = type;
  w.sBuild[s] = done ? b.ticks : 0;
  w.sQueueLen[s] = 0;
  w.sRepeat[s] = 0;
  w.sLast[s] = 255;
  w.sProgress[s] = 0;
  // New units gather just south of the building until the player says otherwise.
  w.sRallyX[s] = ((2 * x + b.w) << CELL_SHIFT) >> 1;
  w.sRallyY[s] = clampInt(((y + b.h) << CELL_SHIFT) + fx(9), 0, MAP_SIZE_FX - 1);
  markTopology();
  return s;
}

function trucks(w: World, ids: readonly number[]): number[] {
  return validUnits(w, ids).filter((id) => w.kind[id] === KIND_TRUCK);
}

function startGather(w: World, i: number, site: number): void {
  w.job[i] = JOB_GATHER;
  w.jobSite[i] = site;
  if (w.cargo[i] > 0 && w.cargoKind[i] !== w.map.siteKind[site]) w.cargo[i] = 0;
  sendTo(w, i, w.map.siteX[site], w.map.siteY[site]);
}

function startBuild(w: World, i: number, s: number): void {
  const map = w.map;
  w.job[i] = JOB_BUILD;
  w.jobStruct[i] = s;
  sendTo(
    w,
    i,
    ((2 * map.sX[s] + map.sW[s]) << CELL_SHIFT) >> 1,
    ((2 * map.sY[s] + map.sH[s]) << CELL_SHIFT) >> 1,
  );
}

/** Economy commands. Returns false for a command that is not one of them. */
export function applyEconomyCommand(w: World, cmd: Command): boolean {
  switch (cmd.type) {
    case CMD_GATHER: {
      const site = cmd.site;
      if (!Number.isInteger(site) || site < 0 || site >= w.map.siteCount) return true;
      for (const id of trucks(w, cmd.units)) startGather(w, id, site);
      return true;
    }
    case CMD_BUILD: {
      const crew = trucks(w, cmd.units);
      const type = cmd.building;
      if (crew.length === 0 || !Number.isInteger(type) || type < 0 || type >= B_COUNT) return true;
      const team = w.team[crew[0]];
      const b = BUILDINGS[type];
      if (w.tier[team] < b.tier || !canPay(w, team, b)) return true;
      const s = place(w, team, type, cmd.x | 0, cmd.y | 0, false);
      if (s < 0) return true;
      pay(w, team, b, 1);
      for (const id of crew) if (w.team[id] === team) startBuild(w, id, s);
      return true;
    }
    case CMD_ASSIST: {
      const s = cmd.structure;
      if (!ownBase(w, s, false)) return true;
      for (const id of trucks(w, cmd.units)) if (w.team[id] === w.sTeam[s]) startBuild(w, id, s);
      return true;
    }
    case CMD_TRAIN: {
      const s = cmd.structure;
      const kind = cmd.kind;
      if (!ownBase(w, s, true) || !Number.isInteger(kind) || kind < 0 || kind >= KIND_COUNT) {
        return true;
      }
      const p = UNIT_PRICE[kind];
      const team = w.sTeam[s];
      if (p.from !== w.sType[s] || w.tier[team] < p.tier || w.sQueueLen[s] >= QUEUE_MAX)
        return true;
      if (!canPay(w, team, p)) return true;
      pay(w, team, p, 1);
      w.sQueue[s * QUEUE_MAX + w.sQueueLen[s]++] = kind;
      w.sLast[s] = kind;
      return true;
    }
    case CMD_REPEAT: {
      if (ownBase(w, cmd.structure, true)) w.sRepeat[cmd.structure] = cmd.on ? 1 : 0;
      return true;
    }
    case CMD_RESEARCH: {
      const s = cmd.structure;
      if (!ownBase(w, s, true) || w.sType[s] !== B_HQ || w.sQueueLen[s] >= QUEUE_MAX) return true;
      const team = w.sTeam[s];
      const p = priceOf(TIER_ITEM, w.tier[team]);
      if (w.tier[team] >= MAX_TIER || p === null || !canPay(w, team, p)) return true;
      // One step at a time, in one headquarters.
      for (let o = 0; o < w.map.structCount; o++) {
        if (w.sTeam[o] !== team || w.sHp[o] <= 0) continue;
        for (let q = 0; q < w.sQueueLen[o]; q++) {
          if (w.sQueue[o * QUEUE_MAX + q] === TIER_ITEM) return true;
        }
      }
      pay(w, team, p, 1);
      w.sQueue[s * QUEUE_MAX + w.sQueueLen[s]++] = TIER_ITEM;
      return true;
    }
    case CMD_CANCEL: {
      const s = cmd.structure;
      if (!ownBase(w, s, true) || w.sQueueLen[s] === 0) return true;
      const team = w.sTeam[s];
      const p = priceOf(w.sQueue[s * QUEUE_MAX + --w.sQueueLen[s]], w.tier[team]);
      if (p !== null) pay(w, team, p, -1);
      if (w.sQueueLen[s] === 0) w.sProgress[s] = 0;
      return true;
    }
    case CMD_RALLY: {
      const s = cmd.structure;
      if (!ownBase(w, s, false)) return true;
      w.sRallyX[s] = clampInt(cmd.x | 0, 0, MAP_SIZE_FX - 1);
      w.sRallyY[s] = clampInt(cmd.y | 0, 0, MAP_SIZE_FX - 1);
      return true;
    }
    case CMD_STANCE: {
      const stance = clampInt(cmd.stance | 0, 0, STANCE_HOLD_FIRE);
      for (const id of validUnits(w, cmd.units)) w.stance[id] = stance;
      return true;
    }
    case CMD_ORDER:
    case CMD_KEEP:
    case CMD_DEST: {
      const team = cmd.team;
      const kind = cmd.kind;
      if (!Number.isInteger(team) || team < 0 || team >= MAX_TEAMS) return true;
      if (!Number.isInteger(kind) || kind < 0 || kind >= KIND_COUNT) return true;
      const k = team * KIND_SLOTS + kind;
      if (cmd.type === CMD_ORDER)
        w.orders[k] = clampInt(w.orders[k] + (cmd.count | 0), 0, ORDER_MAX);
      else if (cmd.type === CMD_KEEP) {
        w.keep[k] = clampInt(cmd.count | 0, 0, ORDER_MAX);
        // Ending a standing order also drops what it had asked for and not yet started.
        if (w.keep[k] === 0) w.orders[k] = 0;
      } else {
        const d = cmd.dest | 0;
        const town = d >= DEST_TOWN && d < DEST_TOWN + w.map.townCount;
        const commander = d >= DEST_COMMANDER && d < DEST_COMMANDER + MAX_COMMANDERS;
        w.dest[k] = town || commander ? d : DEST_RALLY;
      }
      return true;
    }
    case CMD_FOUND: {
      const type = clampInt(cmd.building | 0, 0, B_COUNT - 1);
      const team = clampInt(cmd.team | 0, 0, MAX_TEAMS - 1);
      const b = BUILDINGS[type];
      const c = findCell(cmd.x | 0, cmd.y | 0, 40, (x, y) => canPlace(w.map, x, y, b.w, b.h));
      if (c >= 0) place(w, team, type, c % MAP_CELLS, Math.trunc(c / MAP_CELLS), true);
      countForces(w);
      return true;
    }
  }
  return false;
}

/** The nearest standing, finished depot or headquarters of `team`, or -1. */
function nearestDropOff(w: World, team: number, x: number, y: number): number {
  let best = -1;
  let bestD = 0;
  for (let s = 0; s < w.map.structCount; s++) {
    if (w.sTeam[s] !== team || w.sHp[s] <= 0) continue;
    const b = BUILDINGS[w.sType[s]];
    if (!b.dropOff || w.sBuild[s] < b.ticks) continue;
    const d = structDist2(w, s, x, y);
    if (best < 0 || d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** The nearest site of the same kind that still has something, within reach, or -1. */
function nextSite(w: World, like: number, x: number, y: number): number {
  const map = w.map;
  let best = -1;
  let bestD = SITE_SEARCH * SITE_SEARCH;
  for (let k = 0; k < map.siteCount; k++) {
    if (map.siteKind[k] !== map.siteKind[like] || w.siteStock[k] <= 0) continue;
    const dx = map.siteX[k] - x;
    const dy = map.siteY[k] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

function halt(w: World, i: number): void {
  w.flags[i] &= ~(FLAG_MOVING | FLAG_AMOVE);
}

function headHome(w: World, i: number): void {
  const map = w.map;
  const s = nearestDropOff(w, w.team[i], w.posX[i], w.posY[i]);
  w.job[i] = JOB_RETURN;
  w.jobStruct[i] = s;
  if (s < 0) return; // nowhere to unload: wait, and look again
  sendTo(
    w,
    i,
    ((2 * map.sX[s] + map.sW[s]) << CELL_SHIFT) >> 1,
    ((2 * map.sY[s] + map.sH[s]) << CELL_SHIFT) >> 1,
  );
}

function updateTrucks(w: World): void {
  const map = w.map;
  const n = w.count;
  builders.fill(0, 0, map.structCount);
  for (let i = 0; i < n; i++) {
    const job = w.job[i];
    // (Field works are another module's job: see updateWorks.)
    if (job === JOB_NONE || job === JOB_WORK) continue;
    if (w.state[i] !== STATE_ALIVE) {
      w.job[i] = JOB_NONE;
      continue;
    }
    const x = w.posX[i];
    const y = w.posY[i];
    const retry = (w.tick + i) % TICK_RATE === 0;
    if (job === JOB_GATHER || job === JOB_LOAD) {
      const k = w.jobSite[i];
      if (w.siteStock[k] <= 0 && map.siteKind[k] === SITE_SUPPLIES) {
        // Cleaned out. On to the next stockpile, or home with what is aboard.
        const next = nextSite(w, k, x, y);
        if (next >= 0) startGather(w, i, next);
        else if (w.cargo[i] > 0) headHome(w, i);
        else {
          w.job[i] = JOB_NONE;
          halt(w, i);
        }
        continue;
      }
      if (job === JOB_GATHER) {
        const dx = map.siteX[k] - x;
        const dy = map.siteY[k] - y;
        if (dx * dx + dy * dy <= SITE_REACH * SITE_REACH) {
          halt(w, i);
          w.job[i] = JOB_LOAD;
          w.jobTimer[i] = LOAD_TICKS;
        } else if (retry && (w.flags[i] & FLAG_MOVING) === 0) {
          sendTo(w, i, map.siteX[k], map.siteY[k]);
        }
      } else if (--w.jobTimer[i] <= 0) {
        const room = TRUCK_LOAD - w.cargo[i];
        const take = w.siteStock[k] < room ? w.siteStock[k] : room;
        if (take <= 0 && w.cargo[i] === 0) {
          w.jobTimer[i] = TICK_RATE; // a dry well: wait for the pump
          continue;
        }
        w.siteStock[k] -= take;
        w.cargo[i] += take;
        w.cargoKind[i] = map.siteKind[k];
        headHome(w, i);
      }
    } else if (job === JOB_RETURN) {
      const s = w.jobStruct[i];
      if (s < 0 || w.sHp[s] <= 0) {
        if (retry || s >= 0) headHome(w, i);
        continue;
      }
      if (structDist2(w, s, x, y) <= DROP_REACH * DROP_REACH) {
        const team = w.team[i];
        if (w.cargoKind[i] === SITE_FUEL) w.fuel[team] += w.cargo[i];
        else w.supplies[team] += w.cargo[i];
        w.cargo[i] = 0;
        startGather(w, i, w.jobSite[i]);
      } else if (retry && (w.flags[i] & FLAG_MOVING) === 0) {
        headHome(w, i);
      }
    } else {
      const s = w.jobStruct[i];
      const b = BUILDINGS[w.sType[s]];
      if (w.sHp[s] <= 0 || (w.sBuild[s] >= b.ticks && w.sHp[s] >= b.hp)) {
        w.job[i] = JOB_NONE;
        halt(w, i);
        continue;
      }
      if (structDist2(w, s, x, y) > DROP_REACH * DROP_REACH) {
        if (retry && (w.flags[i] & FLAG_MOVING) === 0) startBuild(w, i, s);
        continue;
      }
      halt(w, i);
      if (builders[s] >= MAX_BUILDERS) continue;
      builders[s]++;
      if (w.sBuild[s] < b.ticks) {
        // Walls go up with the work: a tenth of the health at the start, all of it at the end.
        const grown = (at: number) => Math.trunc((b.hp * (b.ticks + 9 * at)) / (10 * b.ticks));
        w.sHp[s] += grown(w.sBuild[s] + 1) - grown(w.sBuild[s]);
        if (++w.sBuild[s] >= b.ticks) {
          if (w.sHp[s] > b.hp) w.sHp[s] = b.hp;
          w.events.push(EV_BUILT, s, w.sTeam[s]);
          countForces(w);
        }
      } else {
        w.sHp[s] = w.sHp[s] + REPAIR_RATE > b.hp ? b.hp : w.sHp[s] + REPAIR_RATE;
      }
    }
  }
}

/** A building on repeat puts its last unit on the queue again, if the army can pay for it. */
function repeatTrain(w: World, s: number): void {
  const p = UNIT_PRICE[w.sLast[s]];
  const team = w.sTeam[s];
  if (p === undefined || p.from !== w.sType[s] || w.tier[team] < p.tier) return;
  if (!canPay(w, team, p)) return;
  pay(w, team, p, 1);
  w.sQueue[s * QUEUE_MAX + w.sQueueLen[s]++] = w.sLast[s];
}

/** Factories take orders from the centre only while their own queue is this short. */
const DISPATCH_QUEUE = 2;
/** Bulk orders handed out per team each time (twice a second). */
const DISPATCH_BATCH = 4;
/** Rounds a kind the army cannot pay for holds the others up before it lets them pass. */
const DISPATCH_PATIENCE = 40;

/** The finished factory of `team` and `type` with the shortest queue under the limit, or -1. */
function freeFactory(w: World, team: number, type: number): number {
  let best = -1;
  let bestLen = DISPATCH_QUEUE;
  for (let s = 0; s < w.map.structCount; s++) {
    if (w.sTeam[s] !== team || w.sType[s] !== type || w.sHp[s] <= 0) continue;
    if (w.sBuild[s] < BUILDINGS[type].ticks || w.sQueueLen[s] >= bestLen) continue;
    best = s;
    bestLen = w.sQueueLen[s];
  }
  return best;
}

/**
 * The war production centre: bulk orders go to whichever factory has room, one unit at a
 * time and each paid for as it goes on a queue. The kinds on order take turns, so a
 * hundred cheap squads cannot starve one tank of its money: a kind the army cannot afford
 * holds the line until it can (or, after a while, lets the others through for a round).
 */
function dispatchOrders(w: World): void {
  for (let team = 0; team < MAX_TEAMS; team++) {
    const base = team * KIND_SLOTS;
    for (let n = 0; n < DISPATCH_BATCH; n++) {
      // The next kind, from whose turn it is, that is on order and has a factory free.
      let kind = -1;
      let s = -1;
      for (let step = 0; step < KIND_COUNT && kind < 0; step++) {
        const k = (w.orderTurn[team] + step) % KIND_COUNT;
        if (w.orders[base + k] <= 0 || w.tier[team] < UNIT_PRICE[k].tier) continue;
        s = freeFactory(w, team, UNIT_PRICE[k].from);
        if (s >= 0) kind = k;
      }
      if (kind < 0) {
        w.orderWait[team] = 0;
        break;
      }
      const p = UNIT_PRICE[kind];
      if (!canPay(w, team, p)) {
        w.orderTurn[team] = kind;
        if (++w.orderWait[team] >= DISPATCH_PATIENCE) {
          w.orderWait[team] = 0;
          w.orderTurn[team] = (kind + 1) % KIND_COUNT;
        }
        break;
      }
      pay(w, team, p, 1);
      w.sQueue[s * QUEUE_MAX + w.sQueueLen[s]++] = kind;
      w.orders[base + kind]--;
      w.orderTurn[team] = (kind + 1) % KIND_COUNT;
      w.orderWait[team] = 0;
    }
  }
}

const fielded = new Int32Array(MAX_TEAMS * KIND_SLOTS);

/** Standing orders: whatever a "keep N" is short of, counting what is being built, is ordered. */
function standingOrders(w: World): void {
  let any = false;
  for (let k = 0; k < MAX_TEAMS * KIND_SLOTS && !any; k++) any = w.keep[k] > 0;
  if (!any) return;
  fielded.fill(0);
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE) fielded[w.team[i] * KIND_SLOTS + w.kind[i]]++;
  }
  for (let s = 0; s < w.map.structCount; s++) {
    const team = w.sTeam[s];
    if (team === NO_TEAM || w.sHp[s] <= 0) continue;
    for (let q = 0; q < w.sQueueLen[s]; q++) {
      const item = w.sQueue[s * QUEUE_MAX + q];
      if (item !== TIER_ITEM) fielded[team * KIND_SLOTS + item]++;
    }
  }
  for (let k = 0; k < MAX_TEAMS * KIND_SLOTS; k++) {
    if (w.keep[k] === 0) continue;
    const short = w.keep[k] - fielded[k];
    if (short > w.orders[k]) w.orders[k] = short;
  }
}

function updateProduction(w: World): void {
  const map = w.map;
  if (w.tick % 10 === 0) dispatchOrders(w);
  for (let s = 0; s < map.structCount; s++) {
    if (w.sTeam[s] === NO_TEAM) continue;
    if (w.sQueueLen[s] === 0) {
      if (w.sRepeat[s] === 1 && w.sHp[s] > 0 && w.sLast[s] !== 255) repeatTrain(w, s);
      continue;
    }
    if (w.sHp[s] <= 0) {
      w.sQueueLen[s] = 0;
      continue;
    }
    const team = w.sTeam[s];
    const item = w.sQueue[s * QUEUE_MAX];
    const p = priceOf(item, w.tier[team]);
    if (p === null) {
      w.sQueueLen[s] = 0;
      continue;
    }
    const unit = item !== TIER_ITEM;
    // An army at its limit builds nothing more until it has lost something or grown.
    if (unit && w.pop[team] + POINTS[item] > w.popCap[team]) continue;
    if (w.sProgress[s] < p.ticks) w.sProgress[s]++;
    if (w.sProgress[s] < p.ticks) continue;
    if (unit) {
      // Out of the south side, onto the strip of ground every building keeps free.
      const ox = ((2 * map.sX[s] + map.sW[s]) << CELL_SHIFT) >> 1;
      const oy = ((map.sY[s] + map.sH[s]) << CELL_SHIFT) + (CELL_FX >> 1);
      const id = spawnUnit(w, item, team, ox, oy);
      if (id < 0) continue;
      w.pop[team] += POINTS[item];
      w.events.push(EV_TRAINED, id, s);
      rally(w, id, s);
    } else {
      w.tier[team]++;
      w.events.push(EV_TIER, team, w.tier[team]);
    }
    w.sProgress[s] = 0;
    w.sQueueLen[s]--;
    for (let q = 0; q < w.sQueueLen[s]; q++) {
      w.sQueue[s * QUEUE_MAX + q] = w.sQueue[s * QUEUE_MAX + q + 1];
    }
  }
}

/** Hand a new unit to commander `c` of its army. False if there is no such commander. */
function joinCommander(w: World, id: number, c: number): boolean {
  void w;
  void id;
  void c;
  return false;
}

/** A new unit goes to its building's rally point; a truck rallied onto a site starts hauling. */
function rally(w: World, id: number, s: number): void {
  const map = w.map;
  let rx = w.sRallyX[s];
  let ry = w.sRallyY[s];
  // The production centre may send this kind somewhere else: to a town (to a commander
  // is the staff's business, see the commanders).
  const dest = w.dest[w.team[id] * KIND_SLOTS + w.kind[id]];
  if (dest >= DEST_TOWN && dest < DEST_TOWN + map.townCount) {
    rx = map.townX[dest - DEST_TOWN];
    ry = map.townY[dest - DEST_TOWN];
  } else if (dest >= DEST_COMMANDER && joinCommander(w, id, dest - DEST_COMMANDER)) return;
  if (w.kind[id] === KIND_TRUCK) {
    for (let k = 0; k < map.siteCount; k++) {
      const dx = map.siteX[k] - rx;
      const dy = map.siteY[k] - ry;
      if (dx * dx + dy * dy <= fx(8) * fx(8)) {
        startGather(w, id, k);
        return;
      }
    }
  }
  sendTo(w, id, rx, ry);
  if (KINDS[w.kind[id]].damage.some((d) => d > 0)) w.flags[id] |= FLAG_AMOVE;
}

/** How many units each army has, and how many its buildings let it have. */
function countForces(w: World): void {
  w.pop.fill(0);
  w.popCap.fill(0);
  for (let i = 0; i < w.count; i++)
    if (w.state[i] === STATE_ALIVE) w.pop[w.team[i]] += POINTS[w.kind[i]];
  for (let s = 0; s < w.map.structCount; s++) {
    const team = w.sTeam[s];
    if (team === NO_TEAM || w.sHp[s] <= 0) continue;
    const b = BUILDINGS[w.sType[s]];
    if (w.sBuild[s] >= b.ticks) w.popCap[team] += b.cap;
  }
  for (let t = 0; t < MAX_TEAMS; t++) if (w.popCap[t] > POP_MAX) w.popCap[t] = POP_MAX;
}

/** One tick of the economy: trucks, production, and once a second the wells and the count. */
export function updateEconomy(w: World): void {
  updateTrucks(w);
  updateProduction(w);
  if (w.tick % TICK_RATE !== 0) return;
  const map = w.map;
  for (let k = 0; k < map.siteCount; k++) {
    if (map.siteKind[k] !== SITE_FUEL) continue;
    const v = w.siteStock[k] + WELL_RATE;
    w.siteStock[k] = v > WELL_TANK ? WELL_TANK : v;
  }
  countForces(w);
  standingOrders(w);
}
