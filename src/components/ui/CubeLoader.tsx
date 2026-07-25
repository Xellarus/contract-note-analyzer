// A "cube solving itself" loader: an isometric 2×2 cube drawn as flat line-art
// (matching the reference), whose 12 visible tiles light up in a sweep around
// the cube — a solving cascade. Stroke + tile fills use `currentColor`, so it
// inherits the theme's ink (light) / gold (dark) remap, like the app's other
// loaders. Keyframes (cubePulse / .cube-tile) live in index.css.
//
// Geometry: top rhombus corners T/R/B/L plus the lower corners; every tile is
// built from the faces' corner + edge-midpoints so the fills align exactly with
// the outline. viewBox 100×104.
export default function CubeLoader({ className = '' }: { className?: string }) {
  // Each tile: polygon points + `d` = its position in the sweep (0-11). Delay =
  // d × step, so the lit highlight travels clockwise round the outer ring, then
  // the three inner tiles.
  const STEP = 0.2; // seconds between tiles (12 × 0.2 = 2.4s, the cube-tile cycle)
  const tiles: { pts: string; d: number }[] = [
    // top face (corners T=50,8 R=90,30 B=50,52 L=10,30; centre 50,30)
    { pts: '50,8 70,19 50,30 30,19',  d: 0 },   // back
    { pts: '70,19 90,30 70,41 50,30', d: 1 },   // top-right
    { pts: '50,30 70,41 50,52 30,41', d: 9 },   // front (inner)
    { pts: '30,19 50,30 30,41 10,30', d: 8 },   // top-left
    // left face
    { pts: '10,30 30,41 30,63 10,52', d: 7 },
    { pts: '30,41 50,52 50,74 30,63', d: 11 },  // inner
    { pts: '10,52 30,63 30,85 10,74', d: 6 },
    { pts: '30,63 50,74 50,96 30,85', d: 5 },
    // right face
    { pts: '90,30 90,52 70,63 70,41', d: 2 },
    { pts: '70,41 70,63 50,74 50,52', d: 10 },  // inner
    { pts: '90,52 90,74 70,85 70,63', d: 3 },
    { pts: '70,63 70,85 50,96 50,74', d: 4 },
  ];

  // Silhouette hexagon + the three inner edges + the six 2×2 grid lines.
  const outline =
    'M50,8 L90,30 L90,74 L50,96 L10,74 L10,30 Z' +
    ' M10,30 L50,52 M90,30 L50,52 M50,52 L50,96' +          // inner edges to the front corner
    ' M70,19 L30,41 M30,19 L70,41' +                        // top-face grid
    ' M30,41 L30,85 M10,52 L50,74' +                        // left-face grid
    ' M70,41 L70,85 M90,52 L50,74';                         // right-face grid

  return (
    <svg viewBox="0 0 100 104" fill="none" role="img" aria-label="Loading" className={`block ${className}`}>
      {/* Solving sweep — tiles behind the strokes. */}
      {tiles.map((t, i) => (
        <polygon key={i} points={t.pts} fill="currentColor" opacity="0"
          className="cube-tile" style={{ animationDelay: `${t.d * STEP}s` }} />
      ))}
      {/* Flat line-art cube. */}
      <path d={outline} stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
