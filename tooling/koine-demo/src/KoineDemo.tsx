import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BrandMark } from "./components/BrandMark";
import { CodeBlock } from "./components/CodeBlock";
import { MONO, P, SANS } from "./palette";
import {
  GEN_FILES,
  KOI_LINE_COUNT,
  KOINE_CHARS,
  KOINE_LINES,
  LANG_CHIPS,
  TOTAL_FILES,
  TOTAL_LOC,
} from "./snippets";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// ── Layout ───────────────────────────────────────────────────────────────────
const LEFT_X = 56;
const LEFT_W = 444;
const PANEL_TOP = 88;
const PANEL_H = 552;
const HEAD_H = 46;
const BODY_PAD_Y = 17;
const CODE_SIZE = 12.5;
const CODE_LH = 1.45;
const LINE_PX = CODE_SIZE * CODE_LH;

const RIGHT_X = 548;
const RIGHT_W = 676;
const STRIP_H = 38;
const CARD_W = 330;
const CARD_H = 84;
const CARD_GAP_X = 16;
const CARD_ROW = 96;
const CARDS_TOP = 138;
const RUNTIME_TOP = 522;

// ── Timeline (30fps · 432 frames · beats ①–⑤) ────────────────────────────────
const TYPE_START = 56;
const TYPE_END = 146;
const PILL_IN = 146;
// One stamp per generated file, in GEN_FILES order: the 7 domain files at a
// readable cadence, then the 4 shared-runtime files as a quick burst.
const STAMPS = [164, 180, 196, 212, 228, 246, 260, 276, 284, 292, 300];
const BANNER_IN = 316;
const OUTRO_IN = 368;
const FADE_OUT = 424;

// Rolling line-counter: piecewise ramp to each cumulative real line count.
const CUM = GEN_FILES.reduce<number[]>((acc, f) => {
  acc.push((acc[acc.length - 1] ?? 0) + f.loc);
  return acc;
}, []);
const LINES_IN: number[] = [];
const LINES_OUT: number[] = [];
STAMPS.forEach((t, i) => {
  LINES_IN.push(t, t + 5);
  LINES_OUT.push(i === 0 ? 0 : CUM[i - 1], CUM[i]);
});

// Grid slot for domain card i (0-based): A1 B1 A2 B2 A3 B3 A4.
const slot = (i: number) => ({
  x: RIGHT_X + (i % 2) * (CARD_W + CARD_GAP_X),
  y: CARDS_TOP + Math.floor(i / 2) * CARD_ROW,
});

const DOMAIN_FILES = GEN_FILES.filter((f) => !f.runtime);
const RUNTIME_FILES = GEN_FILES.filter((f) => f.runtime);
const RUNTIME_STAMP_BASE = DOMAIN_FILES.length; // runtime stamps start here

export const KoineDemo: React.FC = () => {
  const frame = useCurrentFrame();

  // Clean loop: fade in/out at the seam so the GIF cycles without a hard cut.
  const loop = interpolate(frame, [0, 8, FADE_OUT, 432], [0, 1, 1, 0], clamp);

  // ② the .koi model types itself in.
  const leftIn = interpolate(frame, [48, 62], [0, 1], clamp);
  const typed = Math.floor(
    interpolate(frame, [TYPE_START, TYPE_END], [0, KOINE_CHARS], clamp),
  );
  const typing = frame >= 48 && frame < TYPE_END + 4;

  // ③ compile pill + counter strip.
  const pillIn = interpolate(frame, [PILL_IN, PILL_IN + 12], [0, 1], clamp);
  const stamped = STAMPS.filter((t) => frame >= t).length;
  const linesCount = Math.round(interpolate(frame, LINES_IN, LINES_OUT, clamp));

  // ④ the number. ⑤ polyglot payoff.
  const bannerIn = interpolate(frame, [BANNER_IN, BANNER_IN + 12], [0, 1], clamp);
  const outroIn = interpolate(frame, [OUTRO_IN, OUTRO_IN + 12], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ background: P.bgDeep, opacity: loop }}>
      {/* backdrop */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(1200px 620px at 50% -10%, rgba(50,69,184,0.20), transparent 60%), radial-gradient(900px 900px at 50% 120%, rgba(50,69,184,0.10), transparent 60%), ${P.bgDeep}`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(120,140,200,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(120,140,200,0.045) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(1000px 600px at 50% 45%, black, transparent 80%)",
        }}
      />

      {/* ── top: the build pill ─────────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 24,
          display: "flex",
          justifyContent: "center",
          opacity: pillIn,
          transform: `translateY(${interpolate(pillIn, [0, 1], [-12, 0])}px)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "8px 18px",
            borderRadius: 999,
            background: "rgba(50,69,184,0.16)",
            border: `1px solid ${P.brand}`,
            boxShadow: "0 10px 30px rgba(50,69,184,0.35)",
          }}
        >
          <BrandMark size={22} />
          <span style={{ fontFamily: MONO, fontSize: 15, color: "#dfe6ff", fontWeight: 600 }}>
            koine build ordering.koi
          </span>
          <span style={{ color: P.brandLite, fontSize: 17, fontWeight: 700 }}>→</span>
          <span
            style={{
              fontFamily: SANS,
              fontSize: 12,
              fontWeight: 700,
              color: "#8a63ff",
              background: "#8a63ff22",
              border: "1px solid #8a63ff55",
              padding: "2px 9px",
              borderRadius: 6,
            }}
          >
            C#
          </span>
        </div>
      </div>

      {/* ── LEFT: the .koi source ───────────────────────────────────────── */}
      <div
        style={{
          ...panel,
          left: LEFT_X,
          width: LEFT_W,
          opacity: leftIn,
          transform: `translateX(${interpolate(leftIn, [0, 1], [-40, 0])}px)`,
        }}
      >
        <PanelHead dot="#4aa3ff" title="ordering.koi" tag="model" tagColor="#4aa3ff" />
        <div style={{ padding: `${BODY_PAD_Y}px 20px`, position: "relative" }}>
          {/* highlight sweep: the construct being compiled right now */}
          {DOMAIN_FILES.map((f, i) => {
            const t = STAMPS[i];
            const glow = interpolate(frame, [t - 14, t - 8, t + 2, t + 10], [0, 1, 1, 0], clamp);
            if (glow === 0 || !f.src) return null;
            const [a, b] = f.src;
            return (
              <div
                key={f.file}
                style={{
                  position: "absolute",
                  left: 8,
                  right: 8,
                  top: BODY_PAD_Y + (a - 1) * LINE_PX - 2,
                  height: (b - a + 1) * LINE_PX + 4,
                  borderRadius: 6,
                  background: `${f.accent}14`,
                  borderLeft: `3px solid ${f.accent}`,
                  opacity: glow,
                }}
              />
            );
          })}
          <CodeBlock
            lines={KOINE_LINES}
            fontSize={CODE_SIZE}
            lineHeight={CODE_LH}
            visibleChars={typing ? typed : Infinity}
            caret={typing}
          />
        </div>
      </div>

      {/* ── RIGHT: counter strip + the generated wall ───────────────────── */}
      <div
        style={{
          position: "absolute",
          left: RIGHT_X,
          top: PANEL_TOP,
          width: RIGHT_W,
          height: STRIP_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          borderRadius: 10,
          background: P.panelHead,
          border: `1px solid ${P.panelBorder}`,
          opacity: pillIn,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 9, height: 9, borderRadius: 5, background: P.brandLite }} />
          <span style={{ fontFamily: MONO, fontSize: 13, color: P.dim }}>generated/</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 14, color: "#dfe6ff", fontWeight: 600 }}>
          <span style={{ color: P.brandLite }}>{stamped}</span> files ·{" "}
          <span style={{ color: P.brandLite }}>{linesCount}</span> lines
        </div>
      </div>

      {/* domain file cards */}
      {DOMAIN_FILES.map((f, i) => {
        const t = STAMPS[i];
        const pop = interpolate(frame, [t, t + 8], [0, 1], clamp);
        if (pop === 0) return null;
        const { x, y } = slot(i);
        return (
          <FileCard key={f.file} file={f} x={x} y={y} pop={pop} justLanded={frame < t + 16} />
        );
      })}

      {/* shared runtime group */}
      <div
        style={{
          position: "absolute",
          left: RIGHT_X,
          top: RUNTIME_TOP,
          width: RIGHT_W,
          height: 118,
          borderRadius: 12,
          background: "rgba(15,20,32,0.6)",
          border: `1px dashed ${P.panelBorder}`,
          padding: "10px 14px",
          opacity: interpolate(
            frame,
            [STAMPS[RUNTIME_STAMP_BASE] - 10, STAMPS[RUNTIME_STAMP_BASE]],
            [0, 1],
            clamp,
          ),
        }}
      >
        <div
          style={{
            fontFamily: SANS,
            fontSize: 12,
            fontWeight: 700,
            color: P.dim,
            letterSpacing: 1.1,
            textTransform: "uppercase",
          }}
        >
          + the shared Koine runtime
        </div>
        <div
          style={{
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "6px 18px",
          }}
        >
          {RUNTIME_FILES.map((f, i) => {
            const t = STAMPS[RUNTIME_STAMP_BASE + i];
            const pop = interpolate(frame, [t, t + 6], [0, 1], clamp);
            return (
              <div
                key={f.file}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  opacity: pop,
                  transform: `translateY(${interpolate(pop, [0, 1], [6, 0])}px)`,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 4, background: f.accent }} />
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 12.5,
                    color: P.text,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    flex: 1,
                  }}
                >
                  {f.file}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: P.dim }}>
                  {f.loc} lines
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── ④ the number ────────────────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 660,
          display: "flex",
          justifyContent: "center",
          opacity: bannerIn,
          transform: `translateY(${interpolate(bannerIn, [0, 1], [18, 0])}px)`,
        }}
      >
        <div style={{ fontFamily: SANS, fontSize: 27, fontWeight: 700, color: "#eef2ff" }}>
          <Num>{KOI_LINE_COUNT}</Num> lines of Koine
          <span style={{ color: P.brandLite, fontWeight: 800 }}> &nbsp;→&nbsp; </span>
          <Num>{TOTAL_FILES}</Num> files · <Num>{TOTAL_LOC}</Num> lines of C# ·{" "}
          <span style={{ color: P.enumC }}>0</span> written by you
        </div>
      </div>

      {/* ── ① hook ──────────────────────────────────────────────────────── */}
      {frame < 58 && (
        <AbsoluteFill
          style={{
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 20,
            background: P.bgDeep,
            opacity: interpolate(frame, [44, 56], [1, 0], clamp),
          }}
        >
          <div
            style={{
              transform: `scale(${interpolate(frame, [0, 22], [0.82, 1], clamp)})`,
              opacity: interpolate(frame, [0, 16], [0, 1], clamp),
            }}
          >
            <BrandMark size={110} />
          </div>
          <div
            style={{
              fontFamily: SANS,
              fontSize: 44,
              fontWeight: 800,
              color: "#eef2ff",
              letterSpacing: -0.6,
              opacity: interpolate(frame, [8, 22], [0, 1], clamp),
            }}
          >
            Write the domain.
          </div>
          <div
            style={{
              fontFamily: SANS,
              fontSize: 44,
              fontWeight: 800,
              color: P.brandLite,
              letterSpacing: -0.6,
              opacity: interpolate(frame, [20, 34], [0, 1], clamp),
            }}
          >
            Not the boilerplate.
          </div>
        </AbsoluteFill>
      )}

      {/* ── ⑤ polyglot payoff + CTA ─────────────────────────────────────── */}
      {frame > OUTRO_IN - 4 && (
        <>
          <AbsoluteFill style={{ background: "#04060b", opacity: outroIn * 0.93 }} />
          <AbsoluteFill
            style={{
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 18,
              opacity: outroIn,
              transform: `translateY(${interpolate(outroIn, [0, 1], [30, 0])}px)`,
            }}
          >
            <BrandMark size={62} />
            <div
              style={{
                fontFamily: SANS,
                fontSize: 42,
                fontWeight: 800,
                color: "#f2f5ff",
                letterSpacing: -0.7,
              }}
            >
              The same model. <span style={{ color: P.brandLite }}>Seven languages.</span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {LANG_CHIPS.map((c, i) => {
                const chipIn = interpolate(
                  frame,
                  [OUTRO_IN + 6 + i * 3, OUTRO_IN + 14 + i * 3],
                  [0, 1],
                  clamp,
                );
                return (
                  <div
                    key={c.name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "6px 13px",
                      borderRadius: 999,
                      border: `1px solid ${c.accent}66`,
                      background: `${c.accent}1a`,
                      opacity: chipIn,
                      transform: `translateY(${interpolate(chipIn, [0, 1], [10, 0])}px)`,
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: c.accent }} />
                    <span
                      style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: "#e7ecff" }}
                    >
                      {c.name}
                    </span>
                  </div>
                );
              })}
            </div>
            <div
              style={{
                fontFamily: SANS,
                fontSize: 18,
                color: P.dim,
                fontWeight: 500,
                opacity: interpolate(frame, [OUTRO_IN + 22, OUTRO_IN + 32], [0, 1], clamp),
              }}
            >
              …plus living docs, a glossary, OpenAPI &amp; AsyncAPI — from the same file.
            </div>
            <div
              style={{
                marginTop: 8,
                fontFamily: MONO,
                fontSize: 18,
                color: "#dfe6ff",
                padding: "11px 22px",
                borderRadius: 999,
                background: "rgba(50,69,184,0.18)",
                border: `1px solid ${P.brand}`,
                opacity: interpolate(frame, [OUTRO_IN + 28, OUTRO_IN + 38], [0, 1], clamp),
              }}
            >
              Try it in your browser → atypical-consulting.github.io/Koine
            </div>
          </AbsoluteFill>
        </>
      )}
    </AbsoluteFill>
  );
};

// ── pieces ───────────────────────────────────────────────────────────────────

const Num: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ color: P.brandLite, fontWeight: 800 }}>{children}</span>
);

const FileCard: React.FC<{
  file: (typeof GEN_FILES)[number];
  x: number;
  y: number;
  pop: number;
  justLanded: boolean;
}> = ({ file, x, y, pop, justLanded }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: CARD_W,
      height: CARD_H,
      borderRadius: 10,
      background: P.panel,
      border: `1px solid ${justLanded ? `${file.accent}88` : P.panelBorder}`,
      boxShadow: justLanded
        ? `0 0 22px ${file.accent}33, 0 14px 34px rgba(0,0,0,0.42)`
        : "0 14px 34px rgba(0,0,0,0.42)",
      overflow: "hidden",
      opacity: pop,
      transform: `translateY(${interpolate(pop, [0, 1], [16, 0])}px) scale(${interpolate(
        pop,
        [0, 1],
        [0.96, 1],
      )})`,
    }}
  >
    <div
      style={{
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "0 12px",
        background: P.panelHead,
        borderBottom: `1px solid ${P.panelBorder}`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: file.accent, flexShrink: 0 }} />
      <span
        style={{
          fontFamily: MONO,
          fontSize: 12,
          color: P.dim,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          flexShrink: 1,
          minWidth: 0,
        }}
      >
        {file.dir}/
      </span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 12.5,
          color: "#e7ecff",
          fontWeight: 600,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {file.file}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: MONO, fontSize: 11, color: P.dim, whiteSpace: "nowrap", flexShrink: 0 }}>
        {file.loc} lines
      </span>
    </div>
    <div
      style={{
        padding: "7px 12px",
        whiteSpace: "nowrap",
        maskImage: "linear-gradient(90deg, black 85%, transparent 99%)",
      }}
    >
      {file.peek && <CodeBlock lines={file.peek} fontSize={10.5} lineHeight={1.4} />}
    </div>
  </div>
);

const panel: React.CSSProperties = {
  position: "absolute",
  top: PANEL_TOP,
  height: PANEL_H,
  background: P.panel,
  border: `1px solid ${P.panelBorder}`,
  borderRadius: 14,
  overflow: "hidden",
  boxShadow: "0 26px 64px rgba(0,0,0,0.48)",
};

const PanelHead: React.FC<{ dot: string; title: string; tag: string; tagColor: string }> = ({
  dot,
  title,
  tag,
  tagColor,
}) => (
  <div
    style={{
      height: HEAD_H,
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "0 18px",
      background: P.panelHead,
      borderBottom: `1px solid ${P.panelBorder}`,
    }}
  >
    <span style={{ width: 10, height: 10, borderRadius: 5, background: dot }} />
    <span style={{ fontFamily: MONO, fontSize: 14, color: P.dim, flex: 1 }}>{title}</span>
    <span
      style={{
        fontFamily: SANS,
        fontSize: 12,
        fontWeight: 700,
        color: tagColor,
        background: `${tagColor}22`,
        border: `1px solid ${tagColor}55`,
        padding: "2px 9px",
        borderRadius: 6,
      }}
    >
      {tag}
    </span>
  </div>
);
