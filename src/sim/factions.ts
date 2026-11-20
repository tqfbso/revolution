// The three armies (M10). A faction is the same seventeen kinds of unit with its own version
// of each: different toughness, reach, rate of fire, price and time to build, its own
// names, and one kind it does not field at all. Nothing else in the sim knows about
// factions: it asks `kindOf` for a unit's numbers where it used to read the one table.
//
// Faction 0 is no faction: the table as it stands in units.ts. Every test, scenario and
// measurement made before M10 runs on it, so their results (and the golden hash) hold.
import { fx } from './fixed';
import type { World } from './world';
import {
  KINDS,
  KIND_AD,
  KIND_ARTILLERY,
  KIND_ATGM,
  KIND_COUNT,
  KIND_DRONE,
  KIND_ENGINEER,
  KIND_EW,
  KIND_HELI,
  KIND_IFV,
  KIND_INFANTRY,
  KIND_LIFT,
  KIND_MORTAR,
  KIND_PARA,
  KIND_RECON,
  KIND_STRIKE,
  KIND_TANK,
  KIND_TRUCK,
  type UnitKind,
} from './units';

export const FACTION_NONE = 0;
/** The Western alliance: fewer and better, sees furthest, strongest in the air. */
export const FACTION_NATO = 1;
/** Russia: armour and guns in mass, the best air defence and jamming. */
export const FACTION_RUSSIA = 2;
/** China: numbers, drones by the swarm, engineers, everything on wheels. */
export const FACTION_CHINA = 3;
export const FACTION_COUNT = 4;

/** How one faction's version of a kind differs from the table. Percentages are of 100. */
interface Tweak {
  name?: string;
  hp?: number;
  speed?: number;
  /** World units added to the weapon's range, and to how far it sees. */
  range?: number;
  sight?: number;
  /** Percent of the time between shots: under 100 fires faster. */
  reload?: number;
  damage?: number;
  siege?: number;
  blast?: number;
  jam?: number;
  carry?: number;
  /** Percent of the price, and of the time to build. */
  cost?: number;
  time?: number;
  /** How much of its army the computer makes of this kind, percent of its usual share. */
  share?: number;
}

interface Spec {
  name: string;
  short: string;
  /** One line for the menu. */
  line: string;
  /** Kinds it cannot build. */
  without: number[];
  tweaks: Partial<Record<number, Tweak>>;
}

const SPECS: readonly Spec[] = [
  { name: 'No faction', short: 'none', line: 'The plain table.', without: [], tweaks: {} },
  {
    name: 'Western alliance',
    short: 'nato',
    line: 'Fewer and better: tougher armour, longer sight, precise guns, the best helicopters. Only a light jammer.',
    without: [],
    tweaks: {
      [KIND_TANK]: {
        name: 'Heavy tank',
        hp: 115,
        range: 2,
        sight: 2,
        cost: 118,
        time: 110,
        share: 85,
      },
      [KIND_INFANTRY]: { name: 'Rifle squad', hp: 108, sight: 2, cost: 110, time: 100 },
      [KIND_ATGM]: { name: 'Top-attack missile team', damage: 115, cost: 120, share: 120 },
      [KIND_IFV]: { name: 'Heavy carrier', hp: 112, cost: 114, time: 110 },
      [KIND_ARTILLERY]: {
        name: 'Precision gun',
        range: 15,
        reload: 125,
        blast: 80,
        damage: 115,
        cost: 115,
      },
      [KIND_RECON]: { name: 'Pathfinders', sight: 10 },
      [KIND_DRONE]: { name: 'Surveillance drone', sight: 6 },
      [KIND_STRIKE]: { name: 'Loitering munition', damage: 125, cost: 140, time: 125, share: 70 },
      [KIND_AD]: { name: 'Air-defence vehicle', share: 140 },
      // It had none at first (decision 123). Drones are too large a part of the game to
      // leave the army most people play without the one thing that stops them (132).
      [KIND_EW]: { name: 'Light jammer', jam: 75, cost: 125, share: 70 },
      [KIND_HELI]: { name: 'Gunship', hp: 115, damage: 110, cost: 110 },
      [KIND_LIFT]: { name: 'Transport helicopter' },
      [KIND_PARA]: { name: 'Airborne infantry', hp: 110 },
      [KIND_MORTAR]: { name: 'Mortar section', range: 5, cost: 110 },
    },
  },
  {
    name: 'Russia',
    short: 'russia',
    line: 'Armour and guns in mass: cheap tanks that fire fast, rocket batteries, long-armed air defence, the strongest jammer. No transport helicopter.',
    without: [KIND_LIFT],
    tweaks: {
      [KIND_TANK]: { name: 'Assault tank', hp: 92, reload: 85, cost: 78, time: 78, share: 140 },
      [KIND_INFANTRY]: { name: 'Motor rifle squad', hp: 95, cost: 90, time: 90 },
      [KIND_ATGM]: { name: 'Missile team' },
      [KIND_IFV]: { name: 'Tracked carrier', hp: 90, speed: 105, damage: 110, cost: 85 },
      [KIND_ARTILLERY]: {
        name: 'Rocket battery',
        range: -10,
        reload: 70,
        blast: 140,
        damage: 90,
        cost: 90,
        time: 85,
        share: 160,
      },
      [KIND_DRONE]: { name: 'Recon drone', sight: -5 },
      [KIND_STRIKE]: { name: 'Strike drone' },
      [KIND_AD]: { name: 'Gun-missile system', range: 8, damage: 115, cost: 110 },
      [KIND_EW]: { name: 'Heavy jammer', jam: 130, cost: 90, share: 150 },
      [KIND_HELI]: { name: 'Armoured gunship', hp: 130, speed: 92, cost: 105 },
      [KIND_PARA]: { name: 'Air assault troops', damage: 110 },
      [KIND_MORTAR]: { name: 'Heavy mortar team', blast: 115, reload: 110 },
    },
  },
  {
    name: 'China',
    short: 'china',
    line: 'Numbers and drones: the cheapest infantry, swarm drones at half price, fast wheeled carriers that seat three, hardy engineers. No paratroopers.',
    without: [KIND_PARA],
    tweaks: {
      [KIND_TANK]: { name: 'Medium tank', speed: 112, cost: 92, time: 92 },
      [KIND_INFANTRY]: { name: 'Infantry squad', cost: 90, time: 85, share: 100 },
      [KIND_ATGM]: { name: 'Missile team', cost: 90, time: 90 },
      [KIND_IFV]: { name: 'Wheeled carrier', hp: 94, speed: 118, carry: 3, cost: 90, time: 90 },
      [KIND_ARTILLERY]: { name: 'Truck gun', hp: 85, speed: 125, cost: 95, time: 90 },
      [KIND_DRONE]: { name: 'Recon drone', cost: 70, time: 70 },
      [KIND_STRIKE]: {
        name: 'Swarm drone',
        damage: 90,
        speed: 108,
        cost: 75,
        time: 75,
        share: 125,
      },
      [KIND_AD]: { name: 'Air-defence vehicle', cost: 90 },
      [KIND_ENGINEER]: { name: 'Combat engineers', hp: 115, siege: 120, time: 80 },
      [KIND_HELI]: { name: 'Light gunship', hp: 85, cost: 80, time: 80 },
      [KIND_TRUCK]: { name: 'Logistics truck', speed: 108 },
      [KIND_MORTAR]: { name: 'Mortar team', cost: 85, time: 85 },
    },
  },
];

const pct = (n: number, p: number | undefined): number =>
  p === undefined || n === 0 ? n : Math.max(1, Math.round((n * p) / 100));

function derive(k: UnitKind, t: Tweak | undefined): UnitKind {
  if (!t) return k;
  return {
    ...k,
    name: t.name ?? k.name,
    hp: pct(k.hp, t.hp),
    speed: pct(k.speed, t.speed),
    // A weapon that has no range gets none, whatever the faction.
    range: k.range === 0 ? 0 : Math.max(fx(1), k.range + fx(t.range ?? 0)),
    sight: k.sight + fx(t.sight ?? 0),
    reload: pct(k.reload, t.reload),
    damage: t.damage === undefined ? k.damage : k.damage.map((d) => pct(d, t.damage)),
    siege: pct(k.siege, t.siege),
    blast: pct(k.blast, t.blast),
    jam: pct(k.jam, t.jam),
    carry: t.carry ?? k.carry,
  };
}

export interface Faction {
  name: string;
  short: string;
  line: string;
  /** Its version of every kind (the table's own entry where it has no tweak). */
  kinds: readonly UnitKind[];
  /** What it can build. */
  roster: readonly boolean[];
  /** Percent of the table's price and build time, per kind. */
  cost: readonly number[];
  time: readonly number[];
  /** Percent of the computer's usual share of each kind in its army. */
  share: readonly number[];
}

export const FACTIONS: readonly Faction[] = SPECS.map((s, f) => ({
  name: s.name,
  short: s.short,
  line: s.line,
  kinds: f === FACTION_NONE ? KINDS : KINDS.map((k, i) => derive(k, s.tweaks[i])),
  roster: KINDS.map((_, i) => !s.without.includes(i)),
  cost: KINDS.map((_, i) => s.tweaks[i]?.cost ?? 100),
  time: KINDS.map((_, i) => s.tweaks[i]?.time ?? 100),
  share: KINDS.map((_, i) => s.tweaks[i]?.share ?? 100),
}));

/** The numbers of unit `i`: its faction's version of its kind. */
export function kindOf(w: World, i: number): UnitKind {
  return FACTIONS[w.faction[w.team[i]]].kinds[w.kind[i]];
}

/** The numbers of a `kind` in the army of `team`. */
export function kindFor(w: World, team: number, kind: number): UnitKind {
  return FACTIONS[w.faction[team]].kinds[kind];
}

/** Sight squared per faction and kind, by day and by night (see NIGHT_SIGHT_PCT). */
export const SIGHT_SQ: readonly (readonly number[])[] = FACTIONS.map((f) =>
  f.kinds.map((k) => k.sight * k.sight),
);

/** The faction called `name` in a URL or a menu (`nato`, `russia`, `china`), or none. */
export function factionByName(name: string | null | undefined): number {
  const f = SPECS.findIndex((s) => s.short === name);
  return f < 0 ? FACTION_NONE : f;
}

/** What each faction cannot build, for the menu and the help. */
export function missingOf(f: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < KIND_COUNT; k++) if (!FACTIONS[f].roster[k]) out.push(KINDS[k].name);
  return out;
}
