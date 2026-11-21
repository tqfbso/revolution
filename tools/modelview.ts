// A bench to look at the unit models on, outside the game: every army's models in rows on
// a plain floor, in the game's own paint, light and scale. For the modeller, and for the
// before-and-after pictures. Run `npx vite` and open /tools/modelview.html with:
//
//   ?factions=1,2,3   which armies (a row each)        ?kinds=0,3,4   which kinds (default all)
//   ?lod=0|1|2        level of detail                  ?men=1|2       foot soldiers, or teams at their weapons
//   ?yaw=&pitch=&dist=&x=&z=   the camera              ?gap=          room between models
//   ?burn=1           as wrecks                        ?renderer=webgl
import '../src/sim/euro'; // first: the sim's map modules import each other in a ring, and this way in works unbundled
import * as THREE from 'three/webgpu';
import { Batch } from '../src/client/batch';
import { makeLook, skyScene } from '../src/client/look';
import {
  LAUNCHER_AT,
  MORTAR_AT,
  buildArsenal,
  buildLauncher,
  buildMortar,
} from '../src/client/models';
import { ARM_TUBE, Soldiers } from '../src/client/soldiers';
import { CREW, WEAPON_LAUNCHER, WEAPON_MORTAR, serve } from '../src/client/drills';
import { BURN_BASE, BURN_SCALE, SEEDS, unitMaterial } from '../src/client/unitpaint';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const list = (k: string, d: number[]) =>
  params.has(k) ? params.get(k)!.split(',').map(Number) : d;

const TEAM_RGB = [
  [0.52, 0.045, 0.03],
  [0.03, 0.15, 0.62],
  [0.62, 0.36, 0.02],
  [0.1, 0.4, 0.12],
];

async function start(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: params.get('renderer') === 'webgl',
  });
  await renderer.init();
  renderer.setPixelRatio(num('ratio', 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9c4cc);
  scene.add(new THREE.HemisphereLight(0xcfdbe6, 0x4d4636, 0.78));
  const sun = new THREE.DirectionalLight(0xffe6c0, 4.3);
  const sunDir = new THREE.Vector3(0.5, 0.62, 0.48).normalize();
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 1.6;
  scene.add(sun, sun.target);
  const look = makeLook('normal', true);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(skyScene(sunDir), 0.02).texture;
  scene.environmentIntensity = 0.45;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x5c5a50, roughness: 1 }),
  );
  floor.receiveShadow = true;
  scene.add(floor);

  const material = unitMaterial(look);
  const batches: Batch[] = [];
  const batch = (g: THREE.BufferGeometry, cap = 64) => {
    const b = new Batch(g, material, cap);
    b.mesh.castShadow = b.mesh.receiveShadow = true;
    scene.add(b.mesh);
    batches.push(b);
    return b;
  };

  const factions = list('factions', [1, 2, 3]);
  const lod = num('lod', 0);
  const gap = num('gap', 4.2);
  const burn = num('burn', 0);
  const turn = num('turn', 0.5);
  const heading = num('heading', 0);
  let tris = 0;
  let widest = 0;
  factions.forEach((faction, row) => {
    const team = TEAM_RGB[row % TEAM_RGB.length];
    const across = params.get('across') === '1';
    const z = across ? 0 : -row * num('rows', 5.5);
    const ox = across ? (row - (factions.length - 1) / 2) * num('rows', 5.5) : 0;
    const tintW = (n: number) => (n % SEEDS) + faction * SEEDS + BURN_BASE + BURN_SCALE * burn;
    if (params.get('men') === '2') {
      // Teams at their weapons: the mortar just fired, ducking, and ready; the missile
      // team; and a team packed up and running.
      const soldiers = new Soldiers((g, cap) => batch(g, Math.min(cap, 256)), faction);
      const guns = [
        null,
        batch(buildLauncher(faction).launcher, 8),
        batch(buildMortar(faction).tube, 8),
      ];
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      const teams: [number, number, number][] = [
        [WEAPON_MORTAR, 0.05, 1],
        [WEAPON_MORTAR, 0.6, 1],
        [WEAPON_MORTAR, 3, 1],
        [WEAPON_LAUNCHER, 3, 1],
        [WEAPON_MORTAR, 3, 0],
      ];
      teams.forEach(([weapon, since, halted], t) => {
        const cx = (t - (teams.length - 1) / 2) * num('gap', 1.6);
        const at = weapon === WEAPON_MORTAR ? MORTAR_AT : LAUNCHER_AT;
        const put = (fx: number, fz: number): [number, number] => [
          cx + fx * cos + fz * sin,
          z - fx * sin + fz * cos,
        ];
        if (halted) {
          const [wx, wz] = put(at[0], at[1]);
          guns[weapon]!.put(wx, 0, wz, sin, cos, 1, team[0], team[1], team[2], tintW(t));
        }
        CREW[weapon].forEach((place, m) => {
          const [mx, mz] = put(place.x, place.z);
          const face = heading + place.turn * halted;
          if (halted) serve(soldiers, weapon, m, since, 7);
          soldiers.man(
            Math.min(lod, 1),
            mx,
            0,
            mz,
            Math.sin(face),
            Math.cos(face),
            halted,
            0,
            1 - halted,
            0,
            1 + m * 2.1,
            0,
            team[0],
            team[1],
            team[2],
            tintW(t + m),
            0,
            !halted && m === 0 ? ARM_TUBE : 0,
          );
        });
        widest = Math.max(widest, Math.abs(cx));
      });
      return;
    }
    if (params.get('men') === '1') {
      const soldiers = new Soldiers((g, cap) => batch(g, Math.min(cap, 256)), faction);
      const poses: [number, number, number, number, number][] = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 1, 0],
        [1, 0, 0, 0, 0],
        [1, 0, 0, 1, 0],
        [0, 1, 0, 1, 0],
        [0, 0, 1, 0, 0.6],
        [0, 0, 1, 0, 2.2],
        [0, 0, 1, 0, 3.8],
      ];
      poses.forEach(([kneel, prone, run, aim, stride], k) => {
        const x = (k - (poses.length - 1) / 2) * num('gap', 0.9);
        soldiers.man(
          Math.min(lod, 1),
          x,
          0,
          z,
          Math.sin(heading),
          Math.cos(heading),
          kneel,
          prone,
          run,
          aim,
          stride,
          0,
          team[0],
          team[1],
          team[2],
          tintW(k),
          0,
          k % 3,
        );
        widest = Math.max(widest, Math.abs(x));
      });
      return;
    }
    const arsenal = buildArsenal(faction);
    const models = [...arsenal.vehicles, arsenal.jet];
    const kinds = list(
      'kinds',
      models.map((m, k) => (m ? k : -1)).filter((k) => k >= 0),
    );
    let x = 0;
    const xs: number[] = [];
    for (const k of kinds) {
      const m = models[k];
      if (!m) continue;
      m.far.computeBoundingBox();
      const wide = Math.max(1.6, m.far.boundingBox!.max.x - m.far.boundingBox!.min.x);
      x += wide / 2;
      xs.push(x);
      x += wide / 2 + gap * 0.35;
    }
    const mid = x / 2;
    kinds.forEach((k, n) => {
      const m = models[k];
      if (!m) return;
      const px = xs[n] - mid + ox;
      widest = Math.max(widest, Math.abs(px));
      const y =
        num('y', 0) + ([6, 7, 12, 13, 15, 17].includes(k) ? num('air', 1.2) : 0) - (m.lift ?? 0);
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      const w = tintW(n + row * 3);
      const count = (g: THREE.BufferGeometry) =>
        (tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3);
      if (lod === 2) {
        batch(m.far.clone()).put(px, y, z, sin, cos, 1, team[0], team[1], team[2], w);
        count(m.far);
        return;
      }
      batch(m.hull[lod].clone()).put(px, y, z, sin, cos, 1, team[0], team[1], team[2], w);
      count(m.hull[lod]);
      if (m.turret.length > 0) {
        const th = heading + turn;
        batch(m.turret[lod].clone()).put(
          px + sin * m.turretZ,
          y + m.turretY,
          z + cos * m.turretZ,
          Math.sin(th),
          Math.cos(th),
          1,
          team[0],
          team[1],
          team[2],
          w,
        );
        count(m.turret[lod]);
      }
      // Rotors and propellers where they sit, each stopped at its own angle.
      (m.rotors ?? []).forEach((r, q) => {
        const a = 0.4 + q * 0.7;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        // The airframe's axes: left, up, forward.
        const X = [cos, 0, -sin];
        const Y = [0, 1, 0];
        const Z = [sin, 0, cos];
        const mix = (u: number[], v: number[], p: number, q2: number) =>
          u.map((e, k) => e * p + v[k] * q2);
        const [fx, fy, fz] =
          r.axis === 'y'
            ? [mix(X, Z, c, -sn), Y, mix(X, Z, sn, c)]
            : r.axis === 'x'
              ? [X, mix(Y, Z, c, sn), mix(Z, Y, c, -sn)]
              : [mix(X, Y, c, sn), mix(Y, X, c, -sn), Z];
        const f = new Float32Array([
          ...fx,
          ...fy,
          ...fz,
          px + X[0] * r.x + Z[0] * r.z,
          y + r.y,
          z + X[2] * r.x + Z[2] * r.z,
        ]);
        const g = m.rotorShapes![r.shape][lod];
        batch(g.clone()).frame(f, team[0], team[1], team[2], w);
        count(g);
      });
    });
  });
  for (const b of batches) b.flush();

  const camera = new THREE.PerspectiveCamera(num('fov', 30), 1, 0.1, 2000);
  const yaw = num('yaw', 0.6);
  const pitch = num('pitch', 0.6);
  const dist = num('dist', Math.max(14, widest * 2.4));
  const cx = num('x', 0);
  const cz = num(
    'z',
    params.get('across') === '1' ? 0 : (-(factions.length - 1) * num('rows', 5.5)) / 2,
  );
  camera.position.set(
    cx + Math.sin(yaw) * Math.cos(pitch) * dist,
    Math.sin(pitch) * dist,
    cz + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(cx, num('cy', 0.5), cz);
  sun.target.position.set(cx, 0, cz);
  sun.position.copy(sun.target.position).addScaledVector(sunDir, 120);
  const s = Math.max(12, widest * 1.3);
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 400 });
  sun.shadow.camera.updateProjectionMatrix();

  const frame = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.render(scene, camera);
  };
  let frames = 0;
  renderer.setAnimationLoop(() => {
    frame();
    if (++frames === 3) (window as unknown as { ready: unknown }).ready = { tris };
  });
}

start().catch((err) => {
  console.error(err);
  (window as unknown as { ready: unknown }).ready = { error: String(err) };
});
