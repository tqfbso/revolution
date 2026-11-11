import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The simulation must be bit-identical on every machine (lockstep multiplayer, replays).
// Anything whose result can differ between engines or runs is banned inside src/sim.
const nondeterministic = [
  'random',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'pow',
  'exp',
  'log',
  'log2',
  'log10',
  'hypot',
  'cbrt',
].map((property) => ({
  object: 'Math',
  property,
  message: 'Not deterministic across engines. Use src/sim/fixed.ts or src/sim/rng.ts.',
}));

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', ...nondeterministic],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'No wall-clock time in the simulation.' },
        { name: 'performance', message: 'No wall-clock time in the simulation.' },
        { name: 'window', message: 'The simulation must not touch the DOM.' },
        { name: 'document', message: 'The simulation must not touch the DOM.' },
      ],
    },
  },
);
