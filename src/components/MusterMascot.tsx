// One authored flower geometry for Muster branding and star teammates.
// Motion is opt-in CSS: no per-avatar animation frames, listeners or timers.
import "./muster-mascot.css";

export const MUSTER_ORANGE = "#f08a24";
export const MUSTER_EYES = "#f9f9f9";
export const MUSTER_BODY = "M92.79 0.33C91.27 3.35 89.38 6.32 87 8.93C84.61 11.55 82.11 14.13 78.48 16.01C74.85 17.88 66.56 17.93 65.21 20.2C63.86 22.47 68.79 26.23 70.37 29.61C71.96 32.98 73.87 36.88 74.73 40.45C75.59 44.01 75.71 47.58 75.52 51.01C75.33 54.43 74.63 57.83 73.61 61C72.58 64.17 71.12 67.24 69.39 70.02C67.66 72.81 65.54 75.42 63.21 77.7C60.88 79.97 58.22 82.01 55.42 83.66C52.62 85.32 49.55 86.68 46.43 87.62C43.3 88.57 39.97 89.17 36.67 89.33C33.37 89.49 29.93 89.28 26.61 88.59C23.29 87.89 19.91 86.84 16.74 85.15C13.57 83.47 10.4 82.24 7.6 78.47C4.79 74.7 2.48 62.54 -0.08 62.54C-2.63 62.54 -4.94 74.7 -7.75 78.47C-10.55 82.24 -13.72 83.47 -16.89 85.15C-20.06 86.84 -23.44 87.89 -26.76 88.59C-30.08 89.28 -33.52 89.49 -36.82 89.33C-40.12 89.17 -43.45 88.57 -46.58 87.62C-49.7 86.68 -52.77 85.32 -55.57 83.66C-58.37 82.01 -61.03 79.97 -63.36 77.7C-65.69 75.42 -67.81 72.81 -69.54 70.02C-71.27 67.24 -72.74 64.17 -73.76 61C-74.78 57.83 -75.48 54.43 -75.67 51.01C-75.86 47.58 -75.74 44.01 -74.88 40.45C-74.02 36.88 -72.11 32.98 -70.52 29.61C-68.94 26.23 -64.01 22.47 -65.36 20.2C-66.71 17.93 -75 17.88 -78.63 16.01C-82.26 14.13 -84.76 11.55 -87.15 8.93C-89.53 6.32 -91.42 3.35 -92.94 0.33C-94.46 -2.69 -95.56 -5.95 -96.27 -9.18C-96.97 -12.41 -97.27 -15.78 -97.18 -19.05C-97.1 -22.32 -96.6 -25.65 -95.74 -28.79C-94.89 -31.93 -93.63 -35.04 -92.06 -37.9C-90.48 -40.75 -88.52 -43.5 -86.3 -45.91C-84.07 -48.33 -81.49 -50.56 -78.7 -52.38C-75.9 -54.21 -72.81 -55.79 -69.53 -56.86C-66.25 -57.93 -62.77 -58.77 -59.02 -58.81C-55.27 -58.84 -50.24 -57 -47.03 -57.08C-43.82 -57.15 -41.16 -56.77 -39.76 -59.26C-38.36 -61.76 -39.58 -68.26 -38.63 -72.04C-37.67 -75.81 -35.91 -78.96 -34.02 -81.9C-32.13 -84.84 -29.78 -87.43 -27.29 -89.68C-24.79 -91.92 -21.96 -93.83 -19.05 -95.36C-16.13 -96.89 -12.97 -98.06 -9.81 -98.83C-6.65 -99.61 -3.32 -100 -0.08 -100C3.17 -100 6.5 -99.61 9.66 -98.83C12.82 -98.06 15.98 -96.89 18.9 -95.36C21.81 -93.83 24.64 -91.92 27.14 -89.68C29.63 -87.43 31.98 -84.84 33.87 -81.9C35.76 -78.96 37.52 -75.81 38.48 -72.04C39.43 -68.26 38.21 -61.76 39.61 -59.26C41.01 -56.77 43.67 -57.15 46.88 -57.08C50.09 -57 55.12 -58.84 58.87 -58.81C62.62 -58.77 66.1 -57.93 69.38 -56.86C72.66 -55.79 75.75 -54.21 78.55 -52.38C81.34 -50.56 83.92 -48.33 86.15 -45.91C88.37 -43.5 90.33 -40.75 91.91 -37.9C93.48 -35.04 94.74 -31.93 95.59 -28.79C96.45 -25.65 96.94 -22.32 97.03 -19.05C97.12 -15.78 96.82 -12.41 96.12 -9.18C95.41 -5.95 94.31 -2.69 92.79 0.33Z";

export type MusterEyeState = "open" | "closed" | "happy";

interface MusterMascotProps {
  size?: number;
  color?: string;
  eyes?: MusterEyeState;
  /** Static expression, independent of optional blinking. */
  eyeOpenness?: number;
  label?: string;
  animated?: boolean;
  /** Changing a nonzero key replays one finite wave without a timer. */
  reaction?: number;
}

export function MusterMascot({
  size = 44,
  color = MUSTER_ORANGE,
  eyes = "open",
  eyeOpenness = 1,
  label,
  animated = false,
  reaction = 0,
}: MusterMascotProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-112 -112 224 224"
      xmlns="http://www.w3.org/2000/svg"
      className="muster-mascot"
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-animated={animated}
      data-eyes={eyes}
    >
      <g className="muster-mascot__float">
        <g key={reaction} className="muster-mascot__reaction" data-wave={reaction ? true : undefined}>
          <path d={MUSTER_BODY} fill={color} />
          {[-15, 38].map((x, index) => (
            <g key={x} transform={`translate(${x} ${index === 0 ? -2 : -6}) rotate(-4)`}>
              {eyes === "open" ? (
                <g transform={`scale(1 ${eyeOpenness})`}>
                  <rect className="muster-mascot__eye" x={-10.5} y={-22} width={21} height={44} rx={10.5} fill={MUSTER_EYES} />
                </g>
              ) : (
                <path
                  d={eyes === "happy" ? "M-10.5 5Q0 -13 10.5 5" : "M-10.5 0H10.5"}
                  fill="none"
                  stroke={MUSTER_EYES}
                  strokeWidth={6}
                  strokeLinecap="round"
                />
              )}
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}
