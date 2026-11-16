// Bundled by tools/crossbrowser.mjs to run the golden games inside a browser page.
import { crossCheck } from './golden';

(globalThis as unknown as { crossCheck: typeof crossCheck }).crossCheck = crossCheck;
