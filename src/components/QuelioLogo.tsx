interface Props {
  size?: number;
}

/** Quelioアプリアイコン（src-tauri/iconsと同デザインのインラインSVG版） */
export function QuelioLogo({ size = 18 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden
      style={{ display: "block" }}
    >
      <defs>
        <clipPath id="q-squircle">
          <rect x="0" y="0" width="1024" height="1024" rx="230" ry="230" />
        </clipPath>
        <linearGradient
          id="q-wave"
          gradientUnits="userSpaceOnUse"
          x1="80"
          y1="360"
          x2="980"
          y2="140"
        >
          <stop offset="0" stopColor="#6A0ABE" />
          <stop offset="0.55" stopColor="#2E7DE8" />
          <stop offset="1" stopColor="#4FFFFF" />
        </linearGradient>
        <linearGradient
          id="q-blob"
          gradientUnits="userSpaceOnUse"
          x1="230"
          y1="820"
          x2="40"
          y2="1010"
        >
          <stop offset="0" stopColor="#4621AA" />
          <stop offset="1" stopColor="#958FFF" />
        </linearGradient>
        <linearGradient
          id="q-base"
          gradientUnits="userSpaceOnUse"
          x1="200"
          y1="200"
          x2="900"
          y2="1000"
        >
          <stop offset="0" stopColor="#221E5E" />
          <stop offset="1" stopColor="#1B1842" />
        </linearGradient>
      </defs>

      <g clipPath="url(#q-squircle)">
        <rect x="0" y="0" width="1024" height="1024" fill="url(#q-base)" />
        <path
          fill="url(#q-wave)"
          d="M 0 0 L 1024 0 L 1024 600 C 920 650 830 640 750 590 C 660 532 590 470 500 420 C 400 365 300 340 210 368 C 130 392 60 440 0 490 Z"
        />
        <path
          fill="url(#q-blob)"
          d="M 0 770 C 110 752 210 800 245 890 C 268 950 258 1010 225 1024 L 0 1024 Z"
        />
        <circle
          cx="489"
          cy="488"
          r="205"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="110"
        />
        <g
          stroke="#1E1B4B"
          strokeWidth="28"
          fill="#1E1B4B"
          strokeLinejoin="round"
        >
          <path d="M 557 548 A 112 40 0 0 1 781 548 L 781 743 A 112 40 0 0 1 557 743 Z" />
        </g>
        <path
          fill="#FFFFFF"
          d="M 557 548 A 112 40 0 0 1 781 548 L 781 743 A 112 40 0 0 1 557 743 Z"
        />
        <ellipse
          cx="669"
          cy="548"
          rx="112"
          ry="40"
          fill="#FFFFFF"
          stroke="#1E1B4B"
          strokeWidth="15"
        />
        <g
          fill="none"
          stroke="#1E1B4B"
          strokeWidth="15"
          strokeLinecap="round"
        >
          <path d="M 557 613 A 112 40 0 0 0 781 613" />
          <path d="M 557 678 A 112 40 0 0 0 781 678" />
        </g>
      </g>
    </svg>
  );
}
