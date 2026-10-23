// Lexi: the little character who speaks for Alexa in the simulator and flies to the code to point at lines.

export type LexiMood = 'happy' | 'thinking' | 'listening' | 'worried';

interface Props {
  size?: number;
  talking?: boolean;
  mood?: LexiMood;
  /** Point to the left (at code) with the left arm. */
  pointing?: boolean;
  className?: string;
}

export function Lexi({ size = 96, talking = false, mood = 'happy', pointing = false, className = '' }: Props) {
  const worried = mood === 'worried';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      className={`lexi ${talking ? 'lexi-talking' : ''} ${mood === 'thinking' ? 'lexi-thinking' : ''} ${className}`}
      role="img"
      aria-label="Lexi"
    >
      <defs>
        <radialGradient id="lexi-body" cx="38%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#cffafe" />
          <stop offset="45%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#0e7490" />
        </radialGradient>
        <radialGradient id="lexi-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ecfeff" />
          <stop offset="100%" stopColor="#22d3ee" />
        </radialGradient>
      </defs>
      {/* antenna with Alexa's glowing light */}
      <line x1="60" y1="22" x2="60" y2="8" stroke="#0e7490" strokeWidth="3" strokeLinecap="round" />
      <circle className="lexi-light" cx="60" cy="7" r="5" fill="url(#lexi-glow)" />
      {/* arms */}
      {pointing ? (
        <g className="lexi-point">
          <path d="M22 70 Q8 66 2 62" stroke="#0e7490" strokeWidth="7" strokeLinecap="round" fill="none" />
          <circle cx="3" cy="62" r="4.5" fill="#22d3ee" />
        </g>
      ) : (
        <path className="lexi-wave" d="M22 72 Q12 80 14 90" stroke="#0e7490" strokeWidth="7" strokeLinecap="round" fill="none" />
      )}
      <path d="M98 72 Q108 80 106 90" stroke="#0e7490" strokeWidth="7" strokeLinecap="round" fill="none" />
      {/* body */}
      <ellipse cx="60" cy="66" rx="40" ry="44" fill="url(#lexi-body)" />
      <ellipse cx="46" cy="40" rx="12" ry="7" fill="#ffffff" opacity="0.35" />
      {/* eyes */}
      <g className="lexi-eyes">
        <ellipse cx="45" cy="60" rx="9" ry={worried ? 9 : 11} fill="#ffffff" />
        <ellipse cx="75" cy="60" rx="9" ry={worried ? 9 : 11} fill="#ffffff" />
        <circle cx={mood === 'thinking' ? 49 : 46} cy={mood === 'thinking' ? 56 : 62} r="5" fill="#0f172a" />
        <circle cx={mood === 'thinking' ? 79 : 76} cy={mood === 'thinking' ? 56 : 62} r="5" fill="#0f172a" />
        <circle cx="48" cy="59" r="1.8" fill="#ffffff" />
        <circle cx="78" cy="59" r="1.8" fill="#ffffff" />
      </g>
      {worried && <path d="M36 46 L52 50 M84 46 L68 50" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round" />}
      {/* cheeks */}
      <ellipse cx="34" cy="76" rx="6" ry="3.5" fill="#f472b6" opacity="0.55" />
      <ellipse cx="86" cy="76" rx="6" ry="3.5" fill="#f472b6" opacity="0.55" />
      {/* mouth: a smile, or an open mouth that moves while talking */}
      {talking ? (
        <ellipse className="lexi-mouth" cx="60" cy="82" rx="7" ry="5" fill="#0f172a" />
      ) : worried ? (
        <path d="M51 86 Q60 80 69 86" stroke="#0f172a" strokeWidth="3" strokeLinecap="round" fill="none" />
      ) : (
        <path d="M50 80 Q60 90 70 80" stroke="#0f172a" strokeWidth="3" strokeLinecap="round" fill="none" />
      )}
    </svg>
  );
}
