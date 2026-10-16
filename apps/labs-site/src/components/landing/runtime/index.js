import { initializeInteractions } from './interactions';
import { initializeMotion } from './motion';
import { initializeAgents } from './agents';
import { initializePresentations } from './presentations';

/** Own every browser subscription and animation for a single route mount. */
export function initializeLanding(root, gsap, ScrollTrigger) {
  let disposed = false;
  const disposers = [];
  const frames = new Set();
  const cleanup = callback => disposers.push(callback);
  const runtime = {
    root,
    gsap,
    ScrollTrigger,
    shared: {},
    cleanup,
    byId: id => root.querySelector(`#${CSS.escape(id)}`),
    listen(target, name, handler, options) {
      target.addEventListener(name, handler, options);
      cleanup(() => target.removeEventListener(name, handler, options));
    },
    frame(callback) {
      if (disposed) return;
      const id = requestAnimationFrame(time => {
        frames.delete(id);
        if (!disposed) callback(time);
      });
      frames.add(id);
      return id;
    },
    observe(callback, options) {
      const observer = new IntersectionObserver((entries, instance) => {
        if (!disposed) callback(entries, instance);
      }, options);
      cleanup(() => observer.disconnect());
      return observer;
    },
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    frames.forEach(id => cancelAnimationFrame(id));
    frames.clear();
    // Remove listeners first, then restore DOM and cancel animation contexts.
    disposers.reverse().forEach(callback => callback());
  };
  try {
    initializeInteractions(runtime);
    initializeMotion(runtime);
    initializeAgents(runtime);
    initializePresentations(runtime);
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
