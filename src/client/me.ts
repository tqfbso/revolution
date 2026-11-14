/**
 * The army this player commands: 0 (red) except for a blue player in a versus game
 * (decision 114). Set once, before anything of the interface is built.
 */
export let ME = 0;

export function setMe(team: number): void {
  ME = team;
}
