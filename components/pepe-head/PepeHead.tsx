"use client";

/**
 * PepeHead
 *
 * Ported from MemeDeck's Pepe_Character.tsx.
 * All Zustand / Privy / achievement dependencies removed.
 * Lip-sync is driven by an external `volume` prop (0-1) instead of
 * the ElevenLabs TTS one-shot system.
 */

import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

// ─── Config (mirrors lib/pepe/animations.ts) ──────────────────────────────────

const SPRITE_CONFIG = {
  basePath: "/frames/",
  sequence: ["1-1.webp", "1-2.webp", "1-3.webp", "1-4.webp", "1-5.webp"],
  blinkOverlays: {
    "1-1.webp": "1-1-blink.webp",
    "1-2.webp": "1-2-blink.webp",
    "1-3.webp": "1-3-blink.webp",
    "1-4.webp": "1-4-blink.webp",
    "1-5.webp": "1-5-blink.webp",
  } as Record<string, string>,
} as const;

const ANIMATION_CONFIG = {
  blinkInterval: { min: 2000, max: 5000 },
  blinkDuration: 150,
} as const;

// ─── Props ────────────────────────────────────────────────────────────────────

interface PepeHeadProps {
  /** 0-1 volume level — drives mouth animation */
  volume?: number;
  /** Text to show in the speech bubble (null = hidden) */
  transcript?: string | null;
  /** Whether Pepe is currently speaking (drives scale pulse) */
  isSpeaking?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PepeHead({
  volume = 0,
  transcript = null,
  isSpeaking = false,
}: PepeHeadProps) {
  const [currentFrame, setCurrentFrame] = useState<string>(SPRITE_CONFIG.sequence[0]);
  const [isBlinking, setIsBlinking] = useState(false);
  const [floatOffset, setFloatOffset] = useState(0);
  const [facingDirection, setFacingDirection] = useState<"left" | "right">("right");
  const [headRotation, setHeadRotation] = useState(0);
  const [eyeOffset, setEyeOffset] = useState({
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
  });

  const pepeDivRef = useRef<HTMLDivElement>(null);
  const blinkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Lip sync via volume prop ────────────────────────────────────────────────
  useEffect(() => {
    if (!isSpeaking) {
      setCurrentFrame(SPRITE_CONFIG.sequence[0]);
      return;
    }
    // Map volume 0-1 → mouth frame
    if (volume > 0.55) {
      setCurrentFrame(SPRITE_CONFIG.sequence[1]); // wide open
    } else if (volume > 0.25) {
      setCurrentFrame(SPRITE_CONFIG.sequence[3]); // mid
    } else {
      setCurrentFrame(SPRITE_CONFIG.sequence[0]); // closed
    }
  }, [volume, isSpeaking]);

  // ── Float animation ─────────────────────────────────────────────────────────
  useEffect(() => {
    let rafId: number;
    const start = Date.now();
    const animate = () => {
      const elapsed = Date.now() - start;
      setFloatOffset(Math.sin(elapsed * 0.001) * 6);
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ── Blinking ────────────────────────────────────────────────────────────────
  const scheduleNextBlink = useCallback(() => {
    const delay =
      Math.random() *
        (ANIMATION_CONFIG.blinkInterval.max - ANIMATION_CONFIG.blinkInterval.min) +
      ANIMATION_CONFIG.blinkInterval.min;
    blinkTimeoutRef.current = setTimeout(() => {
      if (!isSpeaking) {
        setIsBlinking(true);
        setTimeout(() => setIsBlinking(false), ANIMATION_CONFIG.blinkDuration);
      }
      scheduleNextBlink();
    }, delay);
  }, [isSpeaking]);

  useEffect(() => {
    scheduleNextBlink();
    return () => {
      if (blinkTimeoutRef.current) clearTimeout(blinkTimeoutRef.current);
    };
  }, [scheduleNextBlink]);

  // ── Mouse / eye tracking ────────────────────────────────────────────────────
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

      if (!pepeDivRef.current) return;
      const rect = pepeDivRef.current.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;

      setFacingDirection(dx < 0 ? "left" : "right");

      const normX = (dx / window.innerWidth) * 2;
      const normY = (dy / window.innerHeight) * 2;
      const angle = Math.atan2(normY, Math.abs(normX));
      const tilt = Math.max(-20, Math.min(20, angle * (180 / Math.PI) * 0.3));
      setHeadRotation(tilt);

      const maxEye = 12;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const normDist = Math.min(dist / 500, 1);
      const bx = (dx / 50) * (1 + normDist * 0.5);
      const by = (dy / 50) * (1 + normDist * 0.5);

      const crossZone = 100;
      const crossFactor = Math.max(0, 1 - Math.abs(dx) / crossZone);
      const conv = 8 * crossFactor;

      let lx = bx, rx = bx;
      if (Math.abs(dx) < crossZone) {
        lx = bx + conv;
        rx = bx - conv;
      }

      const clamp = (v: number) => Math.max(-maxEye, Math.min(maxEye, v));
      const ey = clamp(by);

      if (dx < 0) {
        const tmp = lx;
        lx = -rx;
        rx = -tmp;
      }

      setEyeOffset({
        left: { x: clamp(lx), y: ey },
        right: { x: clamp(rx), y: ey },
      });

      // Idle: drift back to neutral after 2 s of no movement
      idleTimerRef.current = setTimeout(() => {
        const returnToNeutral = () => {
          setHeadRotation((r) => (Math.abs(r) < 0.5 ? 0 : r * 0.85));
          setEyeOffset((o) => ({
            left: {
              x: Math.abs(o.left.x) < 0.5 ? 0 : o.left.x * 0.85,
              y: Math.abs(o.left.y) < 0.5 ? 0 : o.left.y * 0.85,
            },
            right: {
              x: Math.abs(o.right.x) < 0.5 ? 0 : o.right.x * 0.85,
              y: Math.abs(o.right.y) < 0.5 ? 0 : o.right.y * 0.85,
            },
          }));
        };
        const iv = setInterval(returnToNeutral, 40);
        setTimeout(() => clearInterval(iv), 500);
      }, 2000);
    };

    document.addEventListener("mousemove", handleMouseMove);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────
  const blinkSrc =
    SPRITE_CONFIG.blinkOverlays[currentFrame as keyof typeof SPRITE_CONFIG.blinkOverlays];

  return (
    <div
      ref={pepeDivRef}
      className="relative w-60 h-60 cursor-pointer select-none"
      title="Double-click me!"
    >
      <motion.div
        className="relative w-full h-full"
        animate={{
          scale: isSpeaking ? 1.05 : 1,
          rotate: headRotation,
          y: floatOffset,
          scaleX: facingDirection === "left" ? -1 : 1,
        }}
        transition={{
          scale: { duration: 0.3 },
          rotate: { duration: 0.05, ease: "linear" },
          y: { duration: 0 },
          scaleX: { duration: 0.1, ease: "linear" },
        }}
      >
        {/* Body / mouth frame */}
        <Image
          src={SPRITE_CONFIG.basePath + currentFrame}
          alt="Pepe"
          fill
          sizes="240px"
          className="object-contain pointer-events-none"
          style={{ objectPosition: "center 55%" }}
          priority
        />

        {/* Eye layers (hidden while blinking) */}
        {!isBlinking && (
          <>
            <Image
              src="/eyes/eyes-base.webp"
              alt="Eyes base"
              fill
              sizes="240px"
              className="object-contain pointer-events-none"
              style={{ objectPosition: "center 55%" }}
            />
            <Image
              src="/eyes/eyes-pupil-left.webp"
              alt="Left pupil"
              fill
              sizes="240px"
              className="object-contain pointer-events-none"
              style={{
                transform: `translate(${eyeOffset.left.x}px, ${eyeOffset.left.y}px)`,
                objectPosition: "center 55%",
              }}
            />
            <Image
              src="/eyes/eyes-pupil-right.webp"
              alt="Right pupil"
              fill
              sizes="240px"
              className="object-contain pointer-events-none"
              style={{
                transform: `translate(${eyeOffset.right.x}px, ${eyeOffset.right.y}px)`,
                objectPosition: "center 55%",
              }}
            />
            <Image
              src="/eyes/eyes-frame.webp"
              alt="Eyes frame"
              fill
              sizes="240px"
              className="object-contain pointer-events-none"
              style={{ objectPosition: "center 55%" }}
            />
          </>
        )}

        {/* Blink overlay */}
        <AnimatePresence>
          {isBlinking && blinkSrc && (
            <motion.img
              src={SPRITE_CONFIG.basePath + blinkSrc}
              alt="Blink"
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.08 }}
              style={{ objectPosition: "center 55%" }}
            />
          )}
        </AnimatePresence>

        {/* Speaking indicator dot */}
        {isSpeaking && (
          <motion.div
            className="absolute -top-2 -right-2 w-4 h-4 bg-green-400 rounded-full"
            animate={{ scale: [1, 1.3, 1] }}
            transition={{ duration: 0.6, repeat: Infinity }}
          />
        )}
      </motion.div>

      {/* Speech bubble */}
      <AnimatePresence>
        {transcript && (
          <motion.div
            className="absolute -top-4 left-1/2 -translate-x-1/2 -translate-y-full pointer-events-none z-10"
            initial={{ opacity: 0, scale: 0.85, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.85, y: 10 }}
            transition={{ duration: 0.2 }}
          >
            <div className="relative bg-white text-black px-4 py-2 rounded-xl max-w-xs shadow-xl">
              <p className="text-sm font-medium leading-snug">{transcript}</p>
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full">
                <div className="w-0 h-0 border-l-8 border-r-8 border-t-8 border-l-transparent border-r-transparent border-t-white" />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
