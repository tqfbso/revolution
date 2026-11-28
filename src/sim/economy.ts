// The economy: what things cost, the trucks that pay for them, base buildings and what
// they produce. Three resources with three different shapes (see decision 035):
// supplies scale with trucks and run out, fuel scales with wells held, credits with towns.
import { FACTIONS, kindOf, pointsOf } from './factions';
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
import { claimReinforcement, joinCommander, reinforcementsWanted } from './commanders';
import { clampInt, fx } from './fixed';
import { ON_BUILDINGS, ON_OTHER, ON_UNITS, book } from './spend';
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
  HELIS_PER_PAD,
  KIND_HELI,
  KIND_IFV,
  KIND_LIFT,
  KIND_PARA,
  KIND_PLANE,
  PARA_RESERVE_MAX,
  KIND_INFANTRY,
  KIND_RECON,
  KIND_MORTAR,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
} from './units';
import {
  DEST_COMMANDER,
  MAX_COMMANDERS,
  DEST_RALLY,
  DEST_TOWN,
  KIND_SLOTS,
  ORDER_MAX,
  NO_SEAT,
  STAT_SEATS,
  EV_BUILT,
  EV_RESERVE,
  EV_TIER,
  EV_TRAINED,
  FLAG_AMOVE,
  FLAG_MOVING,
  BUILD_QUEUE,
  JOB_BUILD,
  JOB_GATHER,
  JOB_LOAD,
  JOB_NONE,
  JOB_RETURN,
  JOB_WORK,
  JOB_ENTRENCH,
  JOB_HOLE,
  JOB_FELL,
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
/** Where helicopters are built and land: each holds HELIS_PER_PAD of them. */
export const B_HELIPAD = 5;
export const B_COUNT = 6;

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
  {
    name: 'Helipad',
    w: 3,
    h: 3,
    hp: 700,
    floors: 1,
    dropOff: false,
    cap: 0,
    supplies: 250,
    fuel: 150,
    credits: 100,
    ticks: 700,
    tier: 2,
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
  // Three men and a tube (I6): dearer than a rifle squad, far cheaper than a gun.
  t[KIND_MORTAR] = price(B_BARRACKS, 1, 60, 0, 20, 9);
  t[KIND_IFV] = price(B_WORKS, 1, 150, 60, 0, 25);
  t[KIND_TANK] = price(B_WORKS, 2, 320, 160, 0, 55);
  t[KIND_AD] = price(B_WORKS, 2, 160, 60, 60, 28);
  t[KIND_ARTILLERY] = price(B_WORKS, 3, 240, 100, 120, 50);
  t[KIND_EW] = price(B_WORKS, 3, 150, 60, 200, 35);
  t[KIND_DRONE] = price(B_DRONES, 1, 30, 0, 30, 6);
  t[KIND_STRIKE] = price(B_DRONES, 2, 50, 0, 60, 8);
  // Aircraft are the slowest things an army builds. A helicopter is not dear so much as
  // rare: the pad it lands on is the limit. Paratroops are dear, in money above all.
  t[KIND_HELI] = price(B_HELIPAD, 2, 220, 160, 80, 60);
  t[KIND_LIFT] = price(B_HELIPAD, 2, 160, 120, 40, 45);
  t[KIND_PARA] = price(B_BARRACKS, 2, 90, 0, 90, 14);
  // Never built: the plane comes with the drop.
  t[KIND_PLANE] = price(B_COUNT, 99, 0, 0, 0, 1);
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
export const TRUCK_LOAD = 40;
export const LOAD_TICKS = 100;
/** A well pumps this much a second into a tank this big; trucks take what is in it. */
export const WELL_RATE = 6;
export const WELL_TANK = 600;
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
const IS_HELI = KINDS.map((_, k) => k === KIND_HELI || k === KIND_LIFT);
/** What nobody can build: the transport plane, and whatever a faction does without. */
const NEVER: UnitPrice = { from: B_COUNT, tier: 99, supplies: 0, fuel: 0, credits: 0, ticks: 1 };
const factionPrices: (readonly UnitPrice[])[] = [];

/** The price list of a faction: the table's, scaled kind by kind (factions.ts). */
export function pricesOf(faction: number): readonly UnitPrice[] {
  if (faction === 0) return UNIT_PRICE;
  let t = factionPrices[faction];
  if (!t) {
    const f = FACTIONS[faction];
    // Prices stay in fives, so the purse never shows odd change.
    const five = (n: number, p: number): number =>
      n === 0 ? 0 : Math.max(5, Math.round((n * p) / 500) * 5);
    t = factionPrices[faction] = UNIT_PRICE.map((p, k) =>
      !f.roster[k]
        ? NEVER
        : {
            ...p,
            supplies: five(p.supplies, f.cost[k]),
            fuel: five(p.fuel, f.cost[k]),
            credits: five(p.credits, f.cost[k]),
            ticks: Math.max(1, Math.round((p.ticks * f.time[k]) / 100)),
          },
    );
  }
  return t;
}

/** What a unit of `kind` costs the army of `team`. */
export function unitPrice(w: World, team: number, kind: number): UnitPrice {
  return pricesOf(w.faction[team])[kind];
}

const priceOf = (w: World, team: number, item: number): Price | null =>
  (item === TIER_ITEM ? TIER_PRICE[w.tier[team]] : unitPrice(w, team, item)) ?? null;

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
  markTopology(w);
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

/** A building of its army that still wants work: unfinished, or damaged. */
function wantsWork(w: World, s: number): boolean {
  if (s < 0 || w.sHp[s] <= 0 || w.sTeam[s] === NO_TEAM) return false;
  const b = BUILDINGS[w.sType[s]];
  return w.sBuild[s] < b.ticks || w.sHp[s] < b.hp;
}

/**
 * Truck `i` is told to work on building `s`. Queued, and at work on another that still
 * wants it: `s` goes on the truck's list (dropped when the list is full, and not twice).
 * Otherwise it starts on `s` now; a list is kept only by a queued order.
 */
function build(w: World, i: number, s: number, queue: boolean): void {
  const at = i * BUILD_QUEUE;
  if (!queue) w.buildLen[i] = 0;
  else if (w.job[i] === JOB_BUILD && w.jobStruct[i] !== s && wantsWork(w, w.jobStruct[i])) {
    const n = w.buildLen[i];
    for (let q = 0; q < n; q++) if (w.buildNext[at + q] === s) return;
    if (n < BUILD_QUEUE) w.buildNext[at + w.buildLen[i]++] = s;
    return;
  }
  startBuild(w, i, s);
}

/** The next building on truck `i`'s list that still wants work: it goes there. False if none. */
function nextBuild(w: World, i: number): boolean {
  const at = i * BUILD_QUEUE;
  while (w.buildLen[i] > 0) {
    const s = w.buildNext[at];
    const n = --w.buildLen[i];
    for (let q = 0; q < n; q++) w.buildNext[at + q] = w.buildNext[at + q + 1];
    if (s < w.map.structCount && w.sTeam[s] === w.team[i] && wantsWork(w, s)) {
      startBuild(w, i, s);
      return true;
    }
  }
  return false;
}

/** Any order that is not one more for the list empties it (see applyCommand in sim.ts). */
export function dropBuilds(w: World, ids: readonly number[]): void {
  for (const id of ids) if (id >= 0 && id < w.count) w.buildLen[id] = 0;
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
      book(w, team, w.payer, b, ON_BUILDINGS);
      for (const id of crew) if (w.team[id] === team) build(w, id, s, cmd.queue === true);
      return true;
    }
    case CMD_ASSIST: {
      const s = cmd.structure;
      if (!ownBase(w, s, false)) return true;
      for (const id of trucks(w, cmd.units)) {
        if (w.team[id] === w.sTeam[s]) build(w, id, s, cmd.queue === true);
      }
      return true;
    }
    case CMD_TRAIN: {
      const s = cmd.structure;
      const kind = cmd.kind;
      if (!ownBase(w, s, true) || !Number.isInteger(kind) || kind < 0 || kind >= KIND_COUNT) {
        return true;
      }
      const team = w.sTeam[s];
      const p = unitPrice(w, team, kind);
      if (p.from !== w.sType[s] || w.tier[team] < p.tier || w.sQueueLen[s] >= QUEUE_MAX)
        return true;
      if (!canPay(w, team, p)) return true;
      pay(w, team, p, 1);
      book(w, team, w.payer, p, ON_UNITS);
      w.sQueueBy[s * QUEUE_MAX + w.sQueueLen[s]] = w.payer;
      w.sQueue[s * QUEUE_MAX + w.sQueueLen[s]++] = kind;
      w.sLast[s] = kind;
      return true;
    }
    case CMD_REPEAT: {
      if (ownBase(w, cmd.structure, true)) {
        w.sRepeat[cmd.structure] = cmd.on ? 1 : 0;
        w.sRepeatBy[cmd.structure] = cmd.on ? w.payer : NO_SEAT;
      }
      return true;
    }
    case CMD_RESEARCH: {
      const s = cmd.structure;
      if (!ownBase(w, s, true) || w.sType[s] !== B_HQ || w.sQueueLen[s] >= QUEUE_MAX) return true;
      const team = w.sTeam[s];
      const p = priceOf(w, team, TIER_ITEM);
      if (w.tier[team] >= MAX_TIER || p === null || !canPay(w, team, p)) return true;
      // One step at a time, in one headquarters.
      for (let o = 0; o < w.map.structCount; o++) {
        if (w.sTeam[o] !== team || w.sHp[o] <= 0) continue;
        for (let q = 0; q < w.sQueueLen[o]; q++) {
          if (w.sQueue[o * QUEUE_MAX + q] === TIER_ITEM) return true;
        }
      }
      pay(w, team, p, 1);
      book(w, team, w.payer, p, ON_OTHER);
      w.sQueueBy[s * QUEUE_MAX + w.sQueueLen[s]] = w.payer;
      w.sQueue[s * QUEUE_MAX + w.sQueueLen[s]++] = TIER_ITEM;
      return true;
    }
    case CMD_CANCEL: {
      const s = cmd.structure;
      if (!ownBase(w, s, true) || w.sQueueLen[s] === 0) return true;
      const team = w.sTeam[s];
      const slot = s * QUEUE_MAX + --w.sQueueLen[s];
      const item = w.sQueue[slot];
      const p = priceOf(w, team, item);
      if (p !== null) {
        pay(w, team, p, -1);
        // The refund goes back to whoever paid for that place on the queue.
        book(w, team, w.sQueueBy[slot], p, item === TIER_ITEM ? ON_OTHER : ON_UNITS, -1);
      }
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
      if (cmd.type === CMD_ORDER) {
        const was = w.orders[k];
        w.orders[k] = clampInt(w.orders[k] + (cmd.count | 0), 0, ORDER_MAX);
        noteOrder(w, team, kind, w.orders[k] - was);
      } else if (cmd.type === CMD_KEEP) {
        w.keep[k] = clampInt(cmd.count | 0, 0, ORDER_MAX);
        w.keepBy[k] = w.keep[k] > 0 ? w.payer : NO_SEAT;
        // Ending a standing order also drops what it had asked for and not yet started.
        if (w.keep[k] === 0) {
          w.orders[k] = 0;
          noteOrder(w, team, kind, 0);
        }
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
    if (
      job === JOB_NONE ||
      job === JOB_WORK ||
      job === JOB_ENTRENCH ||
      job === JOB_FELL ||
      job === JOB_HOLE
    )
      continue;
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
        // Done here (or it is gone): on to the next on its list, if it has one.
        if (!nextBuild(w, i)) {
          w.job[i] = JOB_NONE;
          halt(w, i);
        }
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
  const team = w.sTeam[s];
  const p = pricesOf(w.faction[team])[w.sLast[s]];
  if (p === undefined || p.from !== w.sType[s] || w.tier[team] < p.tier) return;
  if (!canPay(w, team, p)) return;
  pay(w, team, p, 1);
  book(w, team, w.sRepeatBy[s], p, ON_UNITS);
  w.sQueueBy[s * QUEUE_MAX + w.sQueueLen[s]] = w.sRepeatBy[s];
  w.sQueue[s * QUEUE_MAX + w.sQueueLen[s]++] = w.sLast[s];
}

/**
 * Bulk orders of `kind` for `team` went up or down by `delta` with the command being
 * carried out: up is the payer's; down comes off the payer's own first. However the
 * total changed, the players' shares never add up to more than is still on order (the
 * rest is a standing order's or a commander's).
 */
function noteOrder(w: World, team: number, kind: number, delta: number): void {
  const by = w.payer;
  const mine = by < STAT_SEATS && w.seatArmy[by] === team;
  if (mine && delta !== 0) {
    const o = by * KIND_SLOTS + kind;
    w.orderBy[o] = clampInt(w.orderBy[o] + delta, 0, ORDER_MAX);
  }
  let total = 0;
  for (let seat = 0; seat < STAT_SEATS; seat++) {
    if (w.seatArmy[seat] === team) total += w.orderBy[seat * KIND_SLOTS + kind];
  }
  let over = total - w.orders[team * KIND_SLOTS + kind];
  for (let seat = STAT_SEATS - 1; seat >= 0 && over > 0; seat--) {
    if (w.seatArmy[seat] !== team) continue;
    const o = seat * KIND_SLOTS + kind;
    const cut = Math.min(over, w.orderBy[o]);
    w.orderBy[o] -= cut;
    over -= cut;
  }
}

/**
 * Who pays for the next unit of `kind` a factory takes off `team`'s bulk orders: the
 * player with the most of that kind still on order (the first, if two have as many), else
 * whoever set the standing order, else nobody in particular (a commander's reinforcement).
 */
function orderPayer(w: World, team: number, kind: number): number {
  let best = -1;
  for (let seat = 0; seat < STAT_SEATS; seat++) {
    if (w.seatArmy[seat] !== team) continue;
    const n = w.orderBy[seat * KIND_SLOTS + kind];
    if (n > 0 && (best < 0 || n > w.orderBy[best * KIND_SLOTS + kind])) best = seat;
  }
  if (best >= 0) {
    w.orderBy[best * KIND_SLOTS + kind]--;
    return best;
  }
  const k = team * KIND_SLOTS + kind;
  return w.keep[k] > 0 ? w.keepBy[k] : NO_SEAT;
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
        if (w.orders[base + k] <= 0 || w.tier[team] < unitPrice(w, team, k).tier) continue;
        s = freeFactory(w, team, unitPrice(w, team, k).from);
        if (s >= 0) kind = k;
      }
      if (kind < 0) {
        w.orderWait[team] = 0;
        break;
      }
      const p = unitPrice(w, team, kind);
      if (!canPay(w, team, p)) {
        w.orderTurn[team] = kind;
        if (++w.orderWait[team] >= DISPATCH_PATIENCE) {
          w.orderWait[team] = 0;
          w.orderTurn[team] = (kind + 1) % KIND_COUNT;
        }
        break;
      }
      pay(w, team, p, 1);
      const by = orderPayer(w, team, kind);
      book(w, team, by, p, ON_UNITS);
      w.sQueueBy[s * QUEUE_MAX + w.sQueueLen[s]] = by;
      w.sQueue[s * QUEUE_MAX + w.sQueueLen[s]++] = kind;
      w.orders[base + kind]--;
      w.orderTurn[team] = (kind + 1) % KIND_COUNT;
      w.orderWait[team] = 0;
    }
  }
}

const fielded = new Int32Array(MAX_TEAMS * KIND_SLOTS);
const coming = new Int32Array(MAX_TEAMS * KIND_SLOTS);
const wanted = new Int32Array(MAX_TEAMS * KIND_SLOTS);

/**
 * Standing orders: whatever a "keep N" is short of, or the commanders who have their
 * losses replaced are (the larger of the two), counting what is being built, is ordered.
 */
function standingOrders(w: World): void {
  let any = false;
  for (let k = 0; k < MAX_TEAMS * KIND_SLOTS && !any; k++) any = w.keep[k] > 0;
  wanted.fill(0);
  if (reinforcementsWanted(w, wanted)) any = true;
  if (!any) return;
  fielded.fill(0);
  coming.fill(0);
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] === STATE_ALIVE) fielded[w.team[i] * KIND_SLOTS + w.kind[i]]++;
  }
  for (let t = 0; t < MAX_TEAMS; t++) fielded[t * KIND_SLOTS + KIND_PARA] += w.paraReserve[t];
  for (let s = 0; s < w.map.structCount; s++) {
    const team = w.sTeam[s];
    if (team === NO_TEAM || w.sHp[s] <= 0) continue;
    for (let q = 0; q < w.sQueueLen[s]; q++) {
      const item = w.sQueue[s * QUEUE_MAX + q];
      if (item !== TIER_ITEM) coming[team * KIND_SLOTS + item]++;
    }
  }
  for (let k = 0; k < MAX_TEAMS * KIND_SLOTS; k++) {
    const kept = w.keep[k] === 0 ? 0 : w.keep[k] - fielded[k];
    const short = Math.min(Math.max(kept, wanted[k]) - coming[k], ORDER_MAX);
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
    const p = priceOf(w, team, item);
    if (p === null) {
      w.sQueueLen[s] = 0;
      continue;
    }
    const unit = item !== TIER_ITEM;
    // An army at its limit builds nothing more until it has lost something or grown.
    if (unit && w.pop[team] + pointsOf(w, team, item) > w.popCap[team]) continue;
    // A helicopter needs somewhere to land, and the reserve has only so many places.
    if (unit && IS_HELI[item] && w.helis[team] >= w.heliCap[team]) continue;
    if (item === KIND_PARA && w.paraReserve[team] >= PARA_RESERVE_MAX) continue;
    if (w.sProgress[s] < p.ticks) w.sProgress[s]++;
    if (w.sProgress[s] < p.ticks) continue;
    if (item === KIND_PARA) {
      // Paratroops do not walk out of the door: they wait off the map for the plane.
      w.paraReserve[team]++;
      w.pop[team] += pointsOf(w, team, item);
      w.events.push(EV_RESERVE, team, w.paraReserve[team]);
    } else if (unit) {
      // Out of the south side, onto the strip of ground every building keeps free.
      const ox = ((2 * map.sX[s] + map.sW[s]) << CELL_SHIFT) >> 1;
      const oy = ((map.sY[s] + map.sH[s]) << CELL_SHIFT) + (CELL_FX >> 1);
      const id = spawnUnit(w, item, team, ox, oy);
      if (id < 0) continue;
      w.pop[team] += pointsOf(w, team, item);
      if (IS_HELI[item]) w.helis[team]++;
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
      w.sQueueBy[s * QUEUE_MAX + q] = w.sQueueBy[s * QUEUE_MAX + q + 1];
    }
  }
}

/** A new unit goes to its building's rally point; a truck rallied onto a site starts hauling. */
function rally(w: World, id: number, s: number): void {
  const map = w.map;
  let rx = w.sRallyX[s];
  let ry = w.sRallyY[s];
  // The production centre may send this kind somewhere else: to a town, or to a
  // commander. A commander's new unit still starts for the rally point, to clear the
  // factory door; its staff sends for it from there.
  const dest = w.dest[w.team[id] * KIND_SLOTS + w.kind[id]];
  if (dest >= DEST_TOWN && dest < DEST_TOWN + map.townCount) {
    rx = map.townX[dest - DEST_TOWN];
    ry = map.townY[dest - DEST_TOWN];
  } else if (dest >= DEST_COMMANDER) joinCommander(w, id, dest - DEST_COMMANDER);
  if (w.cmdr[id] < 0) claimReinforcement(w, id);
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
  if (kindOf(w, id).damage.some((d) => d > 0)) w.flags[id] |= FLAG_AMOVE;
}

/** How many units each army has, and how many its buildings let it have. */
function countForces(w: World): void {
  w.pop.fill(0);
  w.popCap.fill(0);
  w.helis.fill(0);
  w.heliCap.fill(0);
  for (let i = 0; i < w.count; i++) {
    if (w.state[i] !== STATE_ALIVE) continue;
    w.pop[w.team[i]] += pointsOf(w, w.team[i], w.kind[i]);
    if (IS_HELI[w.kind[i]]) w.helis[w.team[i]]++;
  }
  for (let t = 0; t < MAX_TEAMS; t++) w.pop[t] += w.paraReserve[t] * pointsOf(w, t, KIND_PARA);
  for (let s = 0; s < w.map.structCount; s++) {
    const team = w.sTeam[s];
    if (team === NO_TEAM || w.sHp[s] <= 0) continue;
    const b = BUILDINGS[w.sType[s]];
    if (w.sBuild[s] < b.ticks) continue;
    w.popCap[team] += b.cap;
    if (w.sType[s] === B_HELIPAD) w.heliCap[team] += HELIS_PER_PAD;
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
