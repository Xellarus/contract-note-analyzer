import cubeLoader from '../../assets/cube-loader.webp';

// The app's loading indicator: an animated WebP of a 2×2 modular Rubik's cube assembling
// itself (user-supplied, 150×150, alpha channel — the "Dark Mode" variant).
//
// NOTE ON COLOUR: this replaced a hand-drawn SVG that used `currentColor`. A WebP bakes its
// palette into every frame, so the orange is FIXED in both themes and the `text-*` classes
// on the existing call sites no longer affect it. That trade-off was the user's call
// (2026-08-06). To make it theme-aware again you'd need a second asset, or a return to
// vector art — a CSS filter can't hit the brass/gold pair cleanly.
//
// Sizing still comes from the caller's width class (w-7 … w-24); the image is square, so
// height follows automatically. `loading="eager"` because it only mounts when something is
// already loading — a lazy fetch would show nothing for the first moment.
export default function CubeLoader({ className = '' }: { className?: string }) {
  return (
    <img
      src={cubeLoader}
      alt=""
      role="img"
      aria-label="Loading"
      decoding="async"
      loading="eager"
      draggable={false}
      className={`block select-none ${className}`}
    />
  );
}
