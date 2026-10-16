'use client';

import { useEffect } from 'react';
import { initializeLanding } from './runtime';

/** Browser behaviour is attached only while the landing route is mounted. */
export function LandingRuntime() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.labs-landing');
    if (!root) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;

    void Promise.all([import('gsap'), import('gsap/ScrollTrigger')])
      .then(([{ gsap }, { ScrollTrigger }]) => {
        if (!cancelled && root.isConnected) {
          dispose = initializeLanding(root, gsap, ScrollTrigger);
        }
      })
      .catch(error => {
        // Server-rendered content stays visible if motion cannot initialize.
        console.error('Could not initialize landing interactions.', error);
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return null;
}
