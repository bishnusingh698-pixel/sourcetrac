/**
 * A browser DOM for a test that mounts React for real, installed on the global
 * object. Import it before anything that loads `react-dom`, which decides once,
 * at load time, whether it is running in a browser.
 *
 * Why not `@vitest-environment happy-dom`: under a DOM environment the React
 * Router Vite plugin transforms app components for the browser and demands its
 * HMR preamble, which a test never has. This keeps the Node transform and adds
 * only the globals.
 */
import { Window } from "happy-dom";

const win = new Window({ url: "https://admin.test/" });
const target = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MutationObserver"] as const) {
  if (key === "navigator" && "navigator" in globalThis) continue;
  target[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
