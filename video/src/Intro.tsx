import type { CSSProperties, ReactNode } from "react";
import { createContext, useContext } from "react";
import {
  AbsoluteFill,
  Easing,
  Html5Audio,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import editions from "./editions.json";
import { mono, sans } from "./fonts";

type Edition = keyof typeof editions;
const EditionContext = createContext<Edition>("original");

// Accelerate entrance timing while keeping each scene's reading time independent.
function useSceneFrame() {
  const frame = useCurrentFrame();
  const edition = useContext(EditionContext);
  return frame * editions[edition].motionRate;
}

const C = {
  paper: "#F3F2EB",
  ink: "#18221E",
  muted: "#68746A",
  line: "#D2D8CD",
  green: "#C4F277",
  dark: "#131C18",
  panel: "#1E2A23",
  soft: "#A6B4A9",
  orange: "#FFAC79",
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.bezier(0.16, 1, 0.3, 1);
const reveal = (f: number, delay = 0, duration = 26) =>
  interpolate(f, [delay, delay + duration], [0, 1], {
    ...clamp,
    easing: ease,
  });

function Enter({
  children,
  delay = 0,
  style,
}: {
  children: ReactNode;
  delay?: number;
  style?: CSSProperties;
}) {
  const p = reveal(useSceneFrame(), delay);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * 30}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Mark({ size = 52, dark = false }: { size?: number; dark?: boolean }) {
  const color = dark ? C.green : C.ink;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M16 14v20c0 11 32 1 32 16M16 34c0-11 32-1 32-20"
        fill="none"
        stroke={color}
        strokeWidth="5"
      />
      <circle cx="16" cy="12" r="7" fill={color} />
      <circle cx="48" cy="12" r="7" fill={color} />
      <rect x="40" y="43" width="16" height="16" rx="4" fill={color} />
    </svg>
  );
}

function Icon({
  name,
  size = 42,
  color = C.ink,
}: {
  name: "review" | "spark" | "check" | "code" | "lock" | "link";
  size?: number;
  color?: string;
}) {
  const paths = {
    review: (
      <>
        <path d="M7 7h34v25H23L12 42V32H7Z" />
        <path d="M15 16h18M15 23h12" />
      </>
    ),
    spark: (
      <>
        <path d="m25 5 5 14 14 5-14 5-5 14-5-14-14-5 14-5Z" />
        <path d="m8 4 1 4 4 1-4 1-1 4-1-4-4-1 4-1Z" />
      </>
    ),
    check: (
      <>
        <rect x="6" y="6" width="36" height="36" rx="10" />
        <path d="m15 24 6 6 13-14" />
      </>
    ),
    code: (
      <>
        <path d="m16 12-12 12 12 12M32 12l12 12-12 12M28 7l-8 34" />
      </>
    ),
    lock: (
      <>
        <rect x="8" y="21" width="32" height="23" rx="6" />
        <path d="M15 21v-9a9 9 0 0 1 18 0v9M24 30v6" />
      </>
    ),
    link: (
      <>
        <path
          d="m20 28 8-8M17 31l-3 3a8 8 0 0 1-11-11l9-9a8 8 0 0 1 11 0M31 17l3-3a8 8 0 0 1 11 11l-9 9a8 8 0 0 1-11 0"
          transform="translate(0 -1)"
        />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke={color}
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Label({
  children,
  dark = false,
  style,
}: {
  children: ReactNode;
  dark?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 19,
        letterSpacing: "0.14em",
        fontWeight: 600,
        color: dark ? C.soft : C.muted,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Pill({
  children,
  dark = false,
}: {
  children: ReactNode;
  dark?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        border: `1px solid ${dark ? "#435348" : C.line}`,
        padding: "10px 17px",
        borderRadius: 999,
        fontSize: 19,
        color: dark ? C.soft : C.muted,
      }}
    >
      {children}
    </span>
  );
}

function Frame({
  children,
  chapter,
  number,
  dark = false,
}: {
  children: ReactNode;
  chapter: string;
  number: string;
  dark?: boolean;
}) {
  const f = useSceneFrame();
  return (
    <AbsoluteFill
      style={{
        fontFamily: sans,
        background: dark ? C.dark : C.paper,
        color: dark ? C.paper : C.ink,
        opacity: interpolate(f, [0, 15], [0, 1], clamp),
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${dark ? "#46554A" : "#BBC5B7"} 0.8px, transparent 0.8px)`,
          backgroundSize: "32px 32px",
          opacity: 0.2,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 52,
          left: 80,
          right: 80,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
          <Mark size={38} dark={dark} />
          <span
            style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-0.04em" }}
          >
            repo-knowledge-mcp
          </span>
        </div>
        <Label dark={dark}>
          {number} / {chapter}
        </Label>
      </div>
      {children}
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 43,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 17,
          color: dark ? C.soft : C.muted,
        }}
      >
        <span>REVIEW KNOWLEDGE. REUSED.</span>
        <span>TamaT-LLC / OPEN SOURCE</span>
      </div>
    </AbsoluteFill>
  );
}

function Headline({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 76,
        fontWeight: 700,
        letterSpacing: "-0.065em",
        lineHeight: 1.35,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function ReviewCard({
  title,
  number,
  style,
  dark = false,
}: {
  title: string;
  number: string;
  style?: CSSProperties;
  dark?: boolean;
}) {
  return (
    <div
      style={{
        background: dark ? C.panel : "#FFFDF8",
        border: `1px solid ${dark ? "#3E4D42" : C.line}`,
        borderRadius: 20,
        padding: 30,
        boxShadow: dark ? "0 20px 50px #00000020" : "0 22px 50px #2230220C",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          marginBottom: 27,
        }}
      >
        <Icon name="review" size={26} color={dark ? C.soft : C.muted} />
        <Label dark={dark}>PULL REQUEST {number}</Label>
      </div>
      <div
        style={{
          fontSize: 30,
          fontWeight: 500,
          lineHeight: 1.65,
          whiteSpace: "pre-line",
        }}
      >
        {title}
      </div>
      <div style={{ marginTop: 28, display: "flex", gap: 7 }}>
        <div
          style={{
            width: 130,
            height: 5,
            borderRadius: 5,
            background: dark ? "#45534A" : "#D7DED2",
          }}
        />
        <div
          style={{
            width: 55,
            height: 5,
            borderRadius: 5,
            background: dark ? "#45534A" : "#D7DED2",
          }}
        />
      </div>
    </div>
  );
}

function Hero() {
  const f = useSceneFrame();
  const move = spring({
    frame: f - 22,
    fps: 30,
    config: { damping: 24, stiffness: 90 },
  });
  return (
    <Frame number="01" chapter="THE IDEA">
      <div style={{ position: "absolute", left: 100, top: 243, zIndex: 2 }}>
        <Enter delay={5}>
          <Label>FROM PULL REQUESTS TO REUSABLE RULES</Label>
        </Enter>
        <Enter delay={11}>
          <Headline style={{ fontSize: 101, marginTop: 32 }}>
            そのレビューを、
            <br />
            次の実装へ。
          </Headline>
        </Enter>
        <Enter delay={24}>
          <div
            style={{
              fontSize: 29,
              lineHeight: 1.85,
              color: C.muted,
              marginTop: 35,
            }}
          >
            PRに眠る知見を、
            <br />
            AIが使えるリポジトリのルールに。
          </div>
        </Enter>
        <Enter delay={40}>
          <div style={{ display: "flex", gap: 12, marginTop: 50 }}>
            <Pill>Local-first</Pill>
            <Pill>MCP server</Pill>
            <Pill>MIT License</Pill>
          </div>
        </Enter>
      </div>
      <div
        style={{
          position: "absolute",
          left: 1140,
          top: 155,
          width: 600,
          height: 650,
          transform: `translateY(${(1 - move) * 90}px)`,
        }}
      >
        <svg
          style={{ position: "absolute", top: -30, left: -150 }}
          width="820"
          height="800"
          viewBox="0 0 820 800"
          aria-hidden="true"
        >
          <circle cx="415" cy="390" r="298" fill="none" stroke={C.line} />
          <circle
            cx="415"
            cy="390"
            r="225"
            fill="none"
            stroke={C.line}
            strokeDasharray="3 12"
          />
          <path
            d="M140 260C720 260 80 595 550 595"
            fill="none"
            stroke="#92A480"
            strokeWidth="2"
            strokeDasharray="7 12"
          />
        </svg>
        <Enter delay={18}>
          <ReviewCard
            number="#42"
            title="「保存する前に、スキーマで検証してください」"
            style={{
              position: "absolute",
              top: 75,
              left: 30,
              width: 510,
              transform: "rotate(-5deg)",
            }}
          />
        </Enter>
        <Enter delay={45}>
          <div
            style={{
              position: "absolute",
              top: 370,
              left: -15,
              width: 575,
              padding: "33px 36px",
              boxSizing: "border-box",
              borderRadius: 22,
              background: C.green,
              transform: "rotate(3deg)",
              boxShadow: "0 24px 60px #2030211A",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Label style={{ color: C.ink }}>REUSABLE RULE</Label>
              <Icon name="check" size={32} />
            </div>
            <div
              style={{
                fontSize: 34,
                lineHeight: 1.6,
                fontWeight: 650,
                marginTop: 23,
              }}
            >
              保存前に、
              <br />
              応答をスキーマで検証する。
            </div>
            <div style={{ marginTop: 28, fontSize: 18, opacity: 0.65 }}>
              review → knowledge → next implementation
            </div>
          </div>
        </Enter>
      </div>
      <div
        style={{
          position: "absolute",
          right: 120,
          bottom: 127,
          fontSize: 17,
          color: C.muted,
        }}
      >
        レビューとルールは説明用の例です
      </div>
    </Frame>
  );
}

function Problem() {
  const f = useSceneFrame();
  const quick = useContext(EditionContext) === "quick";
  return (
    <Frame dark number="02" chapter="THE PROBLEM">
      <Enter delay={4} style={{ position: "absolute", left: 100, top: 184 }}>
        <Label dark>GOOD FEEDBACK SHOULDN’T DISAPPEAR.</Label>
        <Headline style={{ marginTop: 26 }}>
          同じ指摘を、
          <br />
          <span style={{ color: C.orange }}>繰り返していませんか。</span>
        </Headline>
      </Enter>
      {[
        {
          x: 170,
          y: 525,
          r: -4,
          num: "#21",
          text: quick
            ? "APIの応答は、\n保存前に検証を。"
            : "APIの応答は、保存前に検証してください。",
          delay: 18,
        },
        {
          x: 703,
          y: 565,
          r: 2,
          num: "#48",
          text: quick
            ? "ここも、保存前に\nスキーマ検証を。"
            : "ここも、保存する前にスキーマで検証を。",
          delay: 35,
        },
        {
          x: 1228,
          y: 525,
          r: -2,
          num: "#73",
          text: quick
            ? "前回と同じく、\n保存前に検証を。"
            : "前回と同じく、保存前の検証が必要です。",
          delay: 52,
        },
      ].map((card) => (
        <Enter
          key={card.num}
          delay={card.delay}
          style={{ position: "absolute", left: card.x, top: card.y }}
        >
          <ReviewCard
            dark
            number={card.num}
            title={card.text}
            style={{
              width: 470,
              boxSizing: "border-box",
              transform: `rotate(${card.r + Math.sin(f / 60 + card.x) * 0.3}deg)`,
            }}
          />
        </Enter>
      ))}
      <Enter
        delay={83}
        style={{
          position: "absolute",
          left: 100,
          top: 918,
          color: C.soft,
          fontSize: 24,
        }}
      >
        レビューの知見がPRに散らばると、次の実装で活かしにくい。
      </Enter>
      <div
        style={{
          position: "absolute",
          right: 90,
          top: 922,
          fontSize: 17,
          color: C.soft,
        }}
      >
        説明用イメージ
      </div>
    </Frame>
  );
}

const stages = [
  {
    title: "取得する",
    en: "COLLECT",
    desc: (
      <>
        人とAIのレビューを
        <br />
        GitHubから取得
      </>
    ),
    tool: "gh CLI",
    icon: "review",
  },
  {
    title: "ルールにする",
    en: "DISTILL",
    desc: (
      <>
        知見を整理して
        <br />
        候補として保存
      </>
    ),
    tool: "proposed knowledge",
    icon: "spark",
  },
  {
    title: "人が承認する",
    en: "APPROVE",
    desc: (
      <>
        内容と根拠を確認し
        <br />
        ルールを有効化
      </>
    ),
    tool: "repo-knowledge review",
    icon: "check",
  },
  {
    title: "実装で使う",
    en: "APPLY",
    desc: (
      <>
        変更するファイルに
        <br />
        合うルールを取得
      </>
    ),
    tool: "get_rules",
    icon: "code",
  },
] as const;

function Pipeline() {
  const f = useSceneFrame();
  const progress = interpolate(f, [38, 174], [0, 1], clamp);
  return (
    <Frame number="03" chapter="HOW IT WORKS">
      <Enter delay={4} style={{ position: "absolute", left: 100, top: 182 }}>
        <Label>ONE CONTINUOUS WORKFLOW</Label>
        <Headline style={{ marginTop: 24 }}>
          レビューを、使えるルールに。
        </Headline>
      </Enter>
      <svg
        style={{ position: "absolute", top: 355, left: 290 }}
        width="1320"
        height="100"
        aria-hidden="true"
      >
        <path d="M0 50H1320" stroke={C.line} strokeWidth="3" />
        <path
          d="M0 50H1320"
          stroke={C.ink}
          strokeWidth="3"
          strokeDasharray="1320"
          strokeDashoffset={1320 * (1 - progress)}
        />
        <circle cx={1320 * progress} cy="50" r="9" fill={C.ink} />
      </svg>
      {stages.map((stage, i) => {
        const active = reveal(f, 32 + i * 44);
        return (
          <Enter
            key={stage.en}
            delay={14 + i * 9}
            style={{ position: "absolute", left: 100 + i * 437, top: 450 }}
          >
            <div
              style={{
                width: 408,
                height: 377,
                padding: 29,
                boxSizing: "border-box",
                border: `1px solid ${C.line}`,
                borderRadius: 18,
                background: i === 2 ? C.ink : "#FFFDF8",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  color: i === 2 ? C.green : C.muted,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 60,
                    height: 60,
                    borderRadius: 17,
                    background:
                      i === 2 ? "#35472A" : `rgba(196,242,119,${active})`,
                  }}
                >
                  <Icon
                    name={stage.icon}
                    size={33}
                    color={i === 2 ? C.green : C.ink}
                  />
                </div>
                <span style={{ fontSize: 19 }}>
                  0{i + 1} / {stage.en}
                </span>
              </div>
              <div
                style={{
                  marginTop: 30,
                  fontSize: 35,
                  fontWeight: 650,
                  letterSpacing: "-0.045em",
                  color: i === 2 ? C.paper : C.ink,
                }}
              >
                {stage.title}
              </div>
              <div
                style={{
                  marginTop: 18,
                  fontSize: 25,
                  lineHeight: 1.7,
                  color: i === 2 ? C.soft : C.muted,
                }}
              >
                {stage.desc}
              </div>
              <div
                style={{
                  marginTop: 24,
                  fontFamily: mono,
                  fontSize: 18,
                  color: i === 2 ? C.green : C.muted,
                }}
              >
                {stage.tool}
              </div>
            </div>
          </Enter>
        );
      })}
      <Enter
        delay={100}
        style={{
          position: "absolute",
          left: 100,
          top: 886,
          fontSize: 23,
          color: C.muted,
        }}
      >
        <span style={{ color: C.ink, fontWeight: 600 }}>
          根拠も一緒に保存。
        </span>{" "}
        蒸留のための外部送信は、明示的に許可した場合だけ。
      </Enter>
    </Frame>
  );
}

function Demo() {
  const f = useSceneFrame();
  const request =
    'get_rules({\n  repo: "owner/repository",\n  file_paths: ["src/github/client.ts"],\n  task: "API応答の保存処理を変更"\n})';
  const typed = request.slice(
    0,
    Math.floor(interpolate(f, [26, 109], [0, request.length], clamp)),
  );
  const p = reveal(f, 130, 35);
  return (
    <Frame dark number="04" chapter="IN CONTEXT">
      <Enter delay={4} style={{ position: "absolute", left: 100, top: 180 }}>
        <Label dark>THE RIGHT RULE, BEFORE YOU CODE.</Label>
        <Headline style={{ marginTop: 24 }}>
          コードを書く前に、知見が届く。
        </Headline>
      </Enter>
      <Enter
        delay={15}
        style={{ position: "absolute", left: 100, top: 409, width: 806 }}
      >
        <div
          style={{
            height: 422,
            background: "#0E1511",
            border: "1px solid #3B4A3F",
            borderRadius: 18,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: 65,
              borderBottom: "1px solid #344237",
              padding: "0 27px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", gap: 8 }}>
              {["#87978B", "#5B6F60", "#3C5141"].map((color) => (
                <div
                  key={color}
                  style={{
                    background: color,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                  }}
                />
              ))}
            </div>
            <Label dark style={{ fontSize: 16 }}>
              CODING AGENT → MCP
            </Label>
          </div>
          <pre
            style={{
              margin: 0,
              padding: "33px 30px",
              whiteSpace: "pre-wrap",
              fontSize: 25,
              lineHeight: 1.8,
              color: C.green,
              fontFamily: mono,
            }}
          >
            {typed}
            <span
              style={{
                opacity: f < 115 && Math.floor(f / 12) % 2 === 0 ? 1 : 0,
              }}
            >
              ▌
            </span>
          </pre>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 27 }}>
          <Pill dark>変更するファイル</Pill>
          <Pill dark>今回のタスク</Pill>
        </div>
      </Enter>
      <div style={{ position: "absolute", left: 934, top: 594, opacity: p }}>
        <svg
          width="73"
          height="30"
          viewBox="0 0 73 30"
          fill="none"
          stroke={C.green}
          strokeWidth="3"
          aria-hidden="true"
        >
          <path d="M0 15H63m-13-13 13 13-13 13" />
        </svg>
      </div>
      <Enter
        delay={125}
        style={{ position: "absolute", left: 1030, top: 409, width: 788 }}
      >
        <div
          style={{
            background: C.paper,
            color: C.ink,
            borderRadius: 18,
            padding: "31px 34px 33px",
            minHeight: 422,
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Label>1 MATCHING RULE</Label>
            <span
              style={{
                color: "#45682B",
                fontSize: 18,
                background: "#DEEDCE",
                padding: "7px 16px",
                borderRadius: 100,
              }}
            >
              active
            </span>
          </div>
          <div
            style={{
              fontSize: 33,
              lineHeight: 1.65,
              fontWeight: 650,
              marginTop: 32,
            }}
          >
            GitHub APIの応答は、
            <br />
            保存する前に
            <br />
            <span style={{ background: C.green }}>
              strict schemaで検証する。
            </span>
          </div>
          <div
            style={{ height: 1, background: C.line, margin: "29px 0 20px" }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 18,
              color: C.muted,
            }}
          >
            <span>{"scope: src/github/**/*.ts"}</span>
            <span>evidence: 2 reviews ↗</span>
          </div>
        </div>
        <Enter delay={190}>
          <div
            style={{
              marginTop: 26,
              fontSize: 25,
              color: C.green,
              display: "flex",
              alignItems: "center",
              gap: 13,
            }}
          >
            <Icon name="link" size={26} color={C.green} />
            元のレビューまで、根拠をたどれる。
          </div>
        </Enter>
      </Enter>
      <div
        style={{
          position: "absolute",
          right: 102,
          bottom: 110,
          fontSize: 17,
          color: C.soft,
        }}
      >
        READMEの例をもとにした簡略表示
      </div>
    </Frame>
  );
}

function Trust() {
  const f = useSceneFrame();
  const arc = reveal(f, 20, 55);
  return (
    <Frame number="05" chapter="BUILT ON TRUST">
      <Enter delay={4} style={{ position: "absolute", left: 100, top: 185 }}>
        <Label>YOUR KNOWLEDGE. YOUR CONTROL.</Label>
        <Headline style={{ marginTop: 25 }}>
          知見はローカルに。
          <br />
          判断は、人の手に。
        </Headline>
      </Enter>
      <Enter delay={15} style={{ position: "absolute", left: 115, top: 508 }}>
        <div
          style={{
            width: 625,
            height: 362,
            background: C.ink,
            borderRadius: 22,
            padding: 38,
            boxSizing: "border-box",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <svg
            style={{
              position: "absolute",
              right: -85,
              top: -85,
              opacity: 0.35,
            }}
            width="400"
            height="400"
            aria-hidden="true"
          >
            <circle
              cx="200"
              cy="200"
              r="150"
              fill="none"
              stroke={C.green}
              strokeWidth="2"
              strokeDasharray="943"
              strokeDashoffset={943 * (1 - arc)}
            />
            <circle
              cx="200"
              cy="200"
              r="110"
              fill="none"
              stroke={C.green}
              strokeDasharray="2 14"
            />
          </svg>
          <Icon name="lock" color={C.green} size={56} />
          <div
            style={{
              color: C.paper,
              fontSize: 31,
              fontWeight: 600,
              marginTop: 33,
            }}
          >
            個人用のローカルストア
          </div>
          <div
            style={{
              color: C.green,
              fontFamily: mono,
              fontSize: 29,
              marginTop: 23,
            }}
          >
            ~/.repo-knowledge/
          </div>
          <div style={{ color: C.soft, marginTop: 22, fontSize: 22 }}>
            知見をMarkdownで管理
          </div>
        </div>
      </Enter>
      <div style={{ position: "absolute", left: 887, top: 435, width: 889 }}>
        {[
          {
            title: "外部送信は、既定で無効。",
            body: "蒸留方法と送信内容を、自分で選べる。",
            tag: "OPT-IN",
            icon: "lock",
          },
          {
            title: "ルールの承認は、人が行う。",
            body: "自動有効化は既定で無効。承認はCLIから。",
            tag: "HUMAN REVIEW",
            icon: "check",
          },
          {
            title: "レビューの根拠を残す。",
            body: "元のコメントとPRを、あとから確認できる。",
            tag: "TRACEABLE",
            icon: "link",
          },
        ].map((item, i) => (
          <Enter key={item.tag} delay={30 + i * 25}>
            <div
              style={{
                borderBottom: `1px solid ${C.line}`,
                padding: "28px 0",
                display: "flex",
                gap: 30,
              }}
            >
              <div style={{ width: 55, marginTop: 7 }}>
                <Icon name={item.icon as "lock" | "check" | "link"} size={36} />
              </div>
              <div>
                <Label style={{ fontSize: 15 }}>{item.tag}</Label>
                <div style={{ fontSize: 31, fontWeight: 600, marginTop: 11 }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 23, color: C.muted, marginTop: 9 }}>
                  {item.body}
                </div>
              </div>
            </div>
          </Enter>
        ))}
      </div>
    </Frame>
  );
}

function Clients() {
  const f = useSceneFrame();
  const p = reveal(f, 34, 63);
  return (
    <Frame dark number="06" chapter="VENDOR NEUTRAL">
      <Enter delay={4} style={{ position: "absolute", left: 100, top: 183 }}>
        <Label dark>ONE KNOWLEDGE BASE. MULTIPLE AGENTS.</Label>
        <Headline style={{ marginTop: 24 }}>
          使うAIが変わっても、
          <br />
          <span style={{ color: C.green }}>知見は引き継げる。</span>
        </Headline>
      </Enter>
      <svg
        style={{ position: "absolute", left: 0, top: 0 }}
        width="1920"
        height="1080"
        fill="none"
        aria-hidden="true"
      >
        {[600, 748, 896].map((y) => (
          <g key={y}>
            <path
              d={`M895 738C1070 738 1060 ${y} 1240 ${y}`}
              stroke="#3E5244"
              strokeWidth="2"
            />
            <path
              d={`M895 738C1070 738 1060 ${y} 1240 ${y}`}
              stroke={C.green}
              strokeWidth="3"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={1 - p}
            />
          </g>
        ))}
      </svg>
      <Enter delay={15} style={{ position: "absolute", left: 165, top: 583 }}>
        <div
          style={{
            width: 730,
            height: 310,
            boxSizing: "border-box",
            border: "1px solid #48613E",
            borderRadius: 24,
            background: C.panel,
            padding: 40,
          }}
        >
          <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
            <Mark dark size={72} />
            <div>
              <div
                style={{
                  fontSize: 35,
                  fontWeight: 600,
                  letterSpacing: "-0.05em",
                }}
              >
                repo-knowledge-mcp
              </div>
              <div style={{ fontSize: 20, color: C.soft, marginTop: 8 }}>
                あなたのリポジトリの知識
              </div>
            </div>
          </div>
          <div
            style={{
              marginTop: 33,
              padding: "18px 20px",
              borderRadius: 12,
              background: "#2D3E2B",
              color: C.green,
              fontSize: 23,
              display: "flex",
              alignItems: "center",
              gap: 13,
            }}
          >
            <Icon name="check" size={28} color={C.green} />
            承認済みのルール ＋ レビューの根拠
          </div>
        </div>
      </Enter>
      {[
        { name: "Codex", sub: "MCP CLIENT", char: ">_", y: 550 },
        { name: "Claude Code", sub: "MCP CLIENT", char: "✳", y: 698 },
        { name: "Cursor", sub: "MCP CLIENT", char: "↗", y: 846 },
      ].map((client, i) => (
        <Enter
          key={client.name}
          delay={46 + i * 16}
          style={{ position: "absolute", left: 1240, top: client.y }}
        >
          <div
            style={{
              width: 515,
              height: 102,
              border: "1px solid #4E6152",
              borderRadius: 16,
              boxSizing: "border-box",
              padding: "20px 25px",
              display: "flex",
              alignItems: "center",
              gap: 23,
              background: C.panel,
            }}
          >
            <div
              style={{
                fontFamily: mono,
                fontSize: 30,
                color: C.green,
                width: 53,
              }}
            >
              {client.char}
            </div>
            <div style={{ fontSize: 31, fontWeight: 500, flex: 1 }}>
              {client.name}
            </div>
            <div
              style={{ color: C.soft, fontSize: 12, letterSpacing: "0.06em" }}
            >
              {client.sub}
            </div>
          </div>
        </Enter>
      ))}
      <Enter
        delay={120}
        style={{
          position: "absolute",
          left: 982,
          top: 683,
          color: C.green,
          fontFamily: mono,
          fontSize: 18,
        }}
      >
        get_rules
      </Enter>
    </Frame>
  );
}

function Closing() {
  const f = useSceneFrame();
  const scale = interpolate(f, [0, 270], [0.95, 1.03], clamp);
  return (
    <Frame number="07" chapter="GET STARTED">
      <div
        style={{
          position: "absolute",
          right: -65,
          top: 30,
          transform: `scale(${scale})`,
          opacity: 0.18,
        }}
      >
        <svg
          width="850"
          height="900"
          viewBox="0 0 850 900"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M110 0v280c0 230 620 70 620 390v230M110 460C110 230 730 460 730 0"
            stroke="#6D8F4F"
            strokeWidth="65"
          />
          <circle cx="110" cy="100" r="70" fill="#6D8F4F" />
          <rect
            x="660"
            y="713"
            width="140"
            height="140"
            rx="34"
            fill="#6D8F4F"
          />
        </svg>
      </div>
      <Enter delay={6} style={{ position: "absolute", left: 100, top: 196 }}>
        <Label>MAKE EVERY REVIEW COUNT.</Label>
        <Headline style={{ fontSize: 89, marginTop: 27 }}>
          レビューを、
          <br />
          積み重なる知識に。
        </Headline>
      </Enter>
      <Enter delay={20} style={{ position: "absolute", left: 104, top: 513 }}>
        <div
          style={{ fontSize: 43, fontWeight: 600, letterSpacing: "-0.045em" }}
        >
          repo-knowledge-mcp
        </div>
        <div style={{ fontSize: 25, color: C.muted, marginTop: 12 }}>
          Pull Requestの知見を、次の実装へつなぐMCPサーバー。
        </div>
      </Enter>
      <Enter delay={34} style={{ position: "absolute", left: 100, top: 664 }}>
        <div
          style={{
            background: C.ink,
            borderRadius: 17,
            width: 1405,
            padding: "27px 31px",
            boxSizing: "border-box",
            color: C.paper,
          }}
        >
          <div
            style={{
              fontSize: 16,
              color: C.soft,
              letterSpacing: "0.1em",
              marginBottom: 17,
            }}
          >
            START IN YOUR REPOSITORY
          </div>
          <div style={{ fontFamily: mono, fontSize: 30, whiteSpace: "nowrap" }}>
            <span style={{ color: C.green }}>$ </span>npx -y
            @tamat-llc/repo-knowledge-mcp@latest setup
          </div>
        </div>
      </Enter>
      <Enter delay={45} style={{ position: "absolute", left: 103, top: 855 }}>
        <div style={{ fontSize: 28, fontWeight: 500 }}>
          github.com/TamaT-LLC/repo-knowledge-mcp{" "}
          <span style={{ color: C.muted }}>↗</span>
        </div>
        <div style={{ fontSize: 18, marginTop: 19, color: C.muted }}>
          macOS / Linux · Node.js 22.13+ または 24+ · gh CLI が必要
        </div>
      </Enter>
    </Frame>
  );
}

const scenes = [
  {
    component: Hero,
    name: "そのレビューを、次の実装へ",
  },
  {
    component: Problem,
    name: "繰り返されるレビュー",
  },
  {
    component: Pipeline,
    name: "取得・蒸留・承認・活用",
  },
  { component: Demo, name: "get_rules の使用例" },
  {
    component: Trust,
    name: "ローカル保存と人の承認",
  },
  {
    component: Clients,
    name: "複数のAIで知見を再利用",
  },
  { component: Closing, name: "セットアップ" },
];

export function Intro({ edition = "original" }: { edition?: Edition }) {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const timing = editions[edition];
  return (
    <AbsoluteFill style={{ backgroundColor: C.paper }}>
      <Html5Audio src={staticFile(timing.audio)} volume={0.8} />
      <EditionContext.Provider value={edition}>
        {scenes.map(({ component: Scene, name }, i) => (
          <Sequence
            key={name}
            from={timing.frames.slice(0, i).reduce((sum, n) => sum + n, 0)}
            durationInFrames={
              timing.frames[i] + (i < scenes.length - 1 ? timing.overlap : 0)
            }
            name={name}
          >
            <Scene />
          </Sequence>
        ))}
      </EditionContext.Provider>
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 22,
          height: 2,
          background: "#80937F28",
        }}
      >
        <div
          style={{
            width: `${((f + 1) / durationInFrames) * 100}%`,
            height: "100%",
            background: "#86A767",
          }}
        />
      </div>
    </AbsoluteFill>
  );
}
