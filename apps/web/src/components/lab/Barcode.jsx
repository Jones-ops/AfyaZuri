import { code128 } from '@afyazuri/shared';

/** Code 128 barcode as SVG, with quiet zones. Scales to its container width. */
export default function Barcode({ value, height = 40, label = true }) {
  const { modules } = code128(value);
  const quiet = 10;
  const width = modules.reduce((s, m) => s + m, 0) + quiet * 2;
  let x = quiet;
  const bars = [];
  modules.forEach((w, i) => {
    if (i % 2 === 0) bars.push(<rect key={i} x={x} y={0} width={w} height={height} />);
    x += w;
  });
  return (
    <svg
      viewBox={`0 0 ${width} ${height + (label ? 12 : 0)}`}
      className="block w-full"
      role="img"
      aria-label={`Barcode ${value}`}
      shapeRendering="crispEdges"
    >
      <rect width={width} height={height + (label ? 12 : 0)} fill="#fff" />
      <g fill="#000">{bars}</g>
      {label && (
        <text x={width / 2} y={height + 10} textAnchor="middle" fontFamily="monospace" fontSize="10" fill="#000">
          {value}
        </text>
      )}
    </svg>
  );
}
