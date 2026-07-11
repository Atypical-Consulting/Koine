import React from "react";
import { P } from "../palette";

// The Koine brand mark: a lowercase kappa (κ) inscribed in the ports-and-adapters hexagon.
export const BrandMark: React.FC<{ size: number; color?: string }> = ({
  size,
  color = P.brandLite,
}) => {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <path
        d="M50 5 L88 27 L88 73 L50 95 L12 73 L12 27 Z"
        stroke={color}
        strokeWidth={4.5}
        strokeLinejoin="round"
        fill="rgba(50,69,184,0.14)"
      />
      <text
        x="50"
        y="52"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize="48"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontWeight={700}
        fill={color}
      >
        κ
      </text>
    </svg>
  );
};
