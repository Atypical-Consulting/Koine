import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BrandMark } from "./components/BrandMark";
import { CodeBlock } from "./components/CodeBlock";
import { MONO, P, SANS, TARGET_ACCENT } from "./palette";
import { KOINE_CHARS, KOINE_LINES, TARGETS } from "./snippets";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const PANEL_W = 470;
const PANEL_H = 540;
const PANEL_TOP = 108;
const LEFT_X = 92;
const RIGHT_X = 1280 - PANEL_W - 92;
const CODE_SIZE = 17;

export const KoineDemo: React.FC = () => {
  const frame = useCurrentFrame();

  // Clean loop: fade in/out at the seam so the GIF cycles without a hard cut.
  const loop = interpolate(frame, [0, 8, 352, 360], [0, 1, 1, 0], clamp);

  // Left panel — the .koi model types itself in.
  const leftIn = interpolate(frame, [40, 58], [0, 1], clamp);
  const typed = Math.floor(interpolate(frame, [52, 142], [0, KOINE_CHARS], clamp));
  const typing = frame < 150;

  // Center — the compile pill, then a flash as output lands.
  const pillIn = interpolate(frame, [70, 86], [0, 1], clamp);
  const flash = interpolate(frame, [148, 158, 178], [0, 1, 0], clamp);
  const flashScale = interpolate(frame, [148, 178], [0.6, 1.7], clamp);

  // Right panel — emitted output, chip cycling C# → TS → Python → Rust.
  const rStarts = [150, 205, 255, 305];
  let ti = 0;
  for (let i = 0; i < rStarts.length; i++) if (frame >= rStarts[i]) ti = i;
  const target = TARGETS[ti];
  const accent = TARGET_ACCENT[target.name];
  const rightIn = interpolate(frame, [148, 168], [0, 1], clamp);
  const swapIn = interpolate(frame, [rStarts[ti], rStarts[ti] + 10], [0, 1], clamp);

  // Outro CTA.
  const ctaIn = interpolate(frame, [316, 336], [0, 1], clamp);

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

      {/* ── LEFT: .koi source ─────────────────────────────────────────── */}
      <div
        style={{
          ...panel,
          left: LEFT_X,
          opacity: leftIn,
          transform: `translateX(${interpolate(leftIn, [0, 1], [-40, 0])}px)`,
        }}
      >
        <PanelHead dot="#4aa3ff" title="Billing.koi" tag="model" tagColor="#4aa3ff" />
        <div style={panelBody}>
          <CodeBlock
            lines={KOINE_LINES}
            fontSize={CODE_SIZE}
            visibleChars={typing ? typed : Infinity}
            caret={typing}
          />
        </div>
      </div>

      {/* ── CENTER: compile pill + flash ──────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: PANEL_TOP + PANEL_H / 2 - 22,
          display: "flex",
          justifyContent: "center",
          opacity: pillIn,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 20px",
            borderRadius: 999,
            background: "rgba(50,69,184,0.16)",
            border: `1px solid ${P.brand}`,
            boxShadow: "0 10px 30px rgba(50,69,184,0.35)",
            backdropFilter: "blur(2px)",
          }}
        >
          <BrandMark size={26} />
          <span
            style={{
              fontFamily: MONO,
              fontSize: 17,
              color: "#dfe6ff",
              fontWeight: 600,
              letterSpacing: 0.3,
            }}
          >
            koine build
          </span>
          <span style={{ color: P.brandLite, fontSize: 20, fontWeight: 700 }}>→</span>
        </div>
      </div>

      {/* flash burst */}
      <div
        style={{
          position: "absolute",
          left: RIGHT_X - 40,
          top: PANEL_TOP + PANEL_H / 2 - 90,
          width: 180,
          height: 180,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(120,150,255,0.9), rgba(50,69,184,0.25) 45%, transparent 70%)",
          opacity: flash * 0.9,
          transform: `scale(${flashScale})`,
          filter: "blur(2px)",
        }}
      />

      {/* ── RIGHT: emitted output ─────────────────────────────────────── */}
      <div
        style={{
          ...panel,
          left: RIGHT_X,
          opacity: rightIn,
          transform: `translateX(${interpolate(rightIn, [0, 1], [40, 0])}px)`,
        }}
      >
        <PanelHead dot={accent} title={target.file} tag={target.name} tagColor={accent} />
        <div
          style={{
            ...panelBody,
            opacity: swapIn,
            transform: `translateY(${interpolate(swapIn, [0, 1], [8, 0])}px)`,
          }}
        >
          <CodeBlock lines={target.lines} fontSize={CODE_SIZE} />
        </div>
      </div>

      {/* target progress dots */}
      <div
        style={{
          position: "absolute",
          left: RIGHT_X,
          width: PANEL_W,
          top: PANEL_TOP + PANEL_H + 18,
          display: "flex",
          justifyContent: "center",
          gap: 10,
          opacity: rightIn,
        }}
      >
        {TARGETS.map((t, i) => (
          <div
            key={t.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              opacity: i === ti ? 1 : 0.4,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                background: i === ti ? TARGET_ACCENT[t.name] : P.dim,
              }}
            />
            <span style={{ fontFamily: SANS, fontSize: 13, color: i === ti ? "#e7ecff" : P.dim }}>
              {t.name}
            </span>
          </div>
        ))}
      </div>

      {/* ── INTRO ─────────────────────────────────────────────────────── */}
      {frame < 50 && (
        <AbsoluteFill
          style={{
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 22,
            background: P.bgDeep,
            opacity: interpolate(frame, [34, 48], [1, 0], clamp),
          }}
        >
          <div
            style={{
              transform: `scale(${interpolate(frame, [0, 22], [0.82, 1], clamp)})`,
              opacity: interpolate(frame, [0, 16], [0, 1], clamp),
            }}
          >
            <BrandMark size={118} />
          </div>
          <div
            style={{
              fontFamily: SANS,
              fontSize: 38,
              fontWeight: 700,
              color: "#eef2ff",
              opacity: interpolate(frame, [10, 26], [0, 1], clamp),
              letterSpacing: -0.5,
            }}
          >
            Write your domain <span style={{ color: P.brandLite }}>once</span>.
          </div>
        </AbsoluteFill>
      )}

      {/* ── OUTRO CTA ─────────────────────────────────────────────────── */}
      {frame > 310 && (
        <>
          <AbsoluteFill style={{ background: "#04060b", opacity: ctaIn * 0.62 }} />
          <AbsoluteFill
            style={{
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 18,
              opacity: ctaIn,
              transform: `translateY(${interpolate(ctaIn, [0, 1], [34, 0])}px)`,
            }}
          >
            <BrandMark size={72} />
            <div
              style={{
                fontFamily: SANS,
                fontSize: 46,
                fontWeight: 800,
                color: "#f2f5ff",
                letterSpacing: -0.8,
              }}
            >
              One model. <span style={{ color: P.brandLite }}>Seven languages.</span>
            </div>
            <div style={{ fontFamily: SANS, fontSize: 21, color: P.dim, fontWeight: 500 }}>
              Value objects · entities · aggregates · CQRS · context maps — generated.
            </div>
            <div
              style={{
                marginTop: 10,
                fontFamily: MONO,
                fontSize: 19,
                color: "#dfe6ff",
                padding: "11px 22px",
                borderRadius: 999,
                background: "rgba(50,69,184,0.18)",
                border: `1px solid ${P.brand}`,
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

const panel: React.CSSProperties = {
  position: "absolute",
  top: PANEL_TOP,
  width: PANEL_W,
  height: PANEL_H,
  background: P.panel,
  border: `1px solid ${P.panelBorder}`,
  borderRadius: 14,
  overflow: "hidden",
  boxShadow: "0 26px 64px rgba(0,0,0,0.48)",
};

const panelBody: React.CSSProperties = {
  padding: "20px 22px",
};

const PanelHead: React.FC<{ dot: string; title: string; tag: string; tagColor: string }> = ({
  dot,
  title,
  tag,
  tagColor,
}) => (
  <div
    style={{
      height: 46,
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
