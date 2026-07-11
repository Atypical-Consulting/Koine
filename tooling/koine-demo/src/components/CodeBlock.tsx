import React from "react";
import { useCurrentFrame } from "remotion";
import { Line } from "../snippets";
import { MONO, P } from "../palette";

// Renders tokenized code. When `visibleChars` is finite, reveals characters up
// to that count (typewriter) with a blinking caret; height stays stable because
// every line is always laid out (empty lines render a non-breaking space).
export const CodeBlock: React.FC<{
  lines: Line[];
  fontSize: number;
  visibleChars?: number;
  caret?: boolean;
  lineHeight?: number;
}> = ({ lines, fontSize, visibleChars = Infinity, caret = false, lineHeight = 1.5 }) => {
  const frame = useCurrentFrame();
  const blink = Math.floor(frame / 14) % 2 === 0 ? 1 : 0.15;

  let remaining = visibleChars;
  let caretPlaced = false;

  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize,
        lineHeight,
        whiteSpace: "pre",
        color: P.text,
        letterSpacing: 0.2,
      }}
    >
      {lines.map((line, li) => {
        const parts: React.ReactNode[] = [];
        for (let si = 0; si < line.length; si++) {
          const sp = line[si];
          if (remaining >= sp.text.length) {
            parts.push(
              <span key={si} style={{ color: sp.color }}>
                {sp.text}
              </span>,
            );
            remaining -= sp.text.length;
          } else if (remaining > 0) {
            parts.push(
              <span key={si} style={{ color: sp.color }}>
                {sp.text.slice(0, remaining)}
              </span>,
            );
            remaining = 0;
            if (caret && !caretPlaced) {
              parts.push(<Caret key="c" opacity={blink} fontSize={fontSize} />);
              caretPlaced = true;
            }
          }
        }
        // caret sits at end of the last fully-typed line when a line just completed
        if (
          caret &&
          !caretPlaced &&
          remaining === 0 &&
          visibleChars !== Infinity &&
          parts.length > 0 &&
          li < lines.length
        ) {
          parts.push(<Caret key="c" opacity={blink} fontSize={fontSize} />);
          caretPlaced = true;
        }
        return <div key={li}>{parts.length ? parts : " "}</div>;
      })}
    </div>
  );
};

const Caret: React.FC<{ opacity: number; fontSize: number }> = ({ opacity, fontSize }) => (
  <span
    style={{
      display: "inline-block",
      width: Math.max(2, fontSize * 0.09),
      height: fontSize * 0.98,
      background: P.brandLite,
      transform: "translateY(2px)",
      marginLeft: 1,
      opacity,
    }}
  />
);
