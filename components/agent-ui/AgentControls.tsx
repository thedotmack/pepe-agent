"use client";

/**
 * AgentControls
 *
 * Bottom-centre UI:
 *   • Big mic button to start/stop the ElevenLabs conversational session
 *   • Status ring that changes colour depending on agent state
 *   • Small status label
 */

import { motion, AnimatePresence } from "motion/react";
import { AgentStatus } from "@/lib/agent";

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "Click to talk",
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Pepe is speaking",
};

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "bg-gray-600 border-gray-500",
  connecting: "bg-blue-700 border-blue-500",
  listening: "bg-blue-500 border-blue-300",
  speaking: "bg-green-500 border-green-300",
};

const RING_COLORS: Record<AgentStatus, string> = {
  idle: "border-gray-500",
  connecting: "border-blue-500",
  listening: "border-blue-400",
  speaking: "border-green-400",
};

interface Props {
  status: AgentStatus;
  onToggle: () => void;
}

export default function AgentControls({ status, onToggle }: Props) {
  const isActive = status !== "idle";
  const isPulsing = status === "listening" || status === "speaking";

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Status label */}
      <AnimatePresence mode="wait">
        <motion.span
          key={status}
          className="text-sm font-medium text-white/70 tracking-wide"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
        >
          {STATUS_LABELS[status]}
        </motion.span>
      </AnimatePresence>

      {/* Mic button with status ring */}
      <div className="relative">
        {/* Animated pulse ring */}
        {isPulsing && (
          <motion.span
            className={`absolute inset-0 rounded-full border-2 ${RING_COLORS[status]}`}
            animate={{ scale: [1, 1.5], opacity: [0.7, 0] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeOut" }}
          />
        )}

        <button
          onClick={onToggle}
          className={`
            relative w-16 h-16 rounded-full border-2 transition-all duration-300
            flex items-center justify-center
            ${STATUS_COLORS[status]}
            hover:scale-105 active:scale-95
            focus:outline-none focus:ring-2 focus:ring-white/30
          `}
          aria-label={isActive ? "Stop conversation" : "Start conversation"}
        >
          {isActive ? (
            /* Stop icon */
            <svg
              viewBox="0 0 24 24"
              className="w-7 h-7 text-white fill-current"
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            /* Mic icon */
            <svg
              viewBox="0 0 24 24"
              className="w-7 h-7 text-white fill-current"
            >
              <path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" />
              <line x1="12" y1="19" x2="12" y2="23" stroke="white" strokeWidth="2" strokeLinecap="round" />
              <line x1="8" y1="23" x2="16" y2="23" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
