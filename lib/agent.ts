/**
 * ElevenLabs Conversational AI session manager.
 *
 * Wraps @11labs/client's Conversation class and exposes a clean interface
 * for starting/stopping a session plus callbacks for audio volume (used for
 * lip-sync and ASCII background reactivity).
 */

import { Conversation } from "@elevenlabs/client";

export type AgentStatus = "idle" | "connecting" | "listening" | "speaking";

export interface AgentCallbacks {
  onStatusChange: (status: AgentStatus) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
  /** Called ~60fps while agent is speaking with a 0-1 volume level */
  onVolume: (level: number) => void;
  onError: (error: string) => void;
}

export class PepeAgent {
  private conversation: Conversation | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private volumeRafId: number | null = null;
  private callbacks: AgentCallbacks;

  constructor(callbacks: AgentCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.callbacks.onStatusChange("connecting");

    // Fetch a signed URL from our server route (keeps API key server-side)
    let signedUrl: string;
    try {
      const res = await fetch("/api/agent-token");
      if (!res.ok) throw new Error(`agent-token: ${res.status}`);
      const data = await res.json();
      signedUrl = data.signedUrl;
    } catch (err) {
      this.callbacks.onError(`Failed to get agent token: ${err}`);
      this.callbacks.onStatusChange("idle");
      return;
    }

    try {
      this.conversation = await Conversation.startSession({
        signedUrl,

        onConnect: () => {
          this.callbacks.onStatusChange("listening");
        },

        onDisconnect: () => {
          this.stopVolumePolling();
          this.callbacks.onStatusChange("idle");
        },

        onError: (message: string) => {
          this.callbacks.onError(message);
        },

        onModeChange: (mode: { mode: string }) => {
          if (mode.mode === "speaking") {
            this.callbacks.onStatusChange("speaking");
            this.startVolumePolling();
          } else {
            this.stopVolumePolling();
            this.callbacks.onStatusChange("listening");
            this.callbacks.onVolume(0);
          }
        },

        onMessage: (message: { message: string; source: string }) => {
          if (message.source === "ai") {
            this.callbacks.onTranscript(message.message, true);
          }
        },
      });
    } catch (err) {
      this.callbacks.onError(`Failed to start session: ${err}`);
      this.callbacks.onStatusChange("idle");
    }
  }

  async stop(): Promise<void> {
    this.stopVolumePolling();
    if (this.conversation) {
      await this.conversation.endSession();
      this.conversation = null;
    }
    this.callbacks.onStatusChange("idle");
    this.callbacks.onVolume(0);
  }

  /**
   * Poll the output audio stream for volume levels so we can drive lip-sync
   * and the ASCII background reactivity.
   *
   * @11labs/client routes agent audio through a standard <audio> element that
   * it creates on the page. We grab it via the AudioContext and an AnalyserNode.
   */
  private startVolumePolling(): void {
    if (this.volumeRafId !== null) return;

    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
      }
      if (!this.analyser) {
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;

        // Connect any playing <audio> element created by @11labs/client
        const audioEl = document.querySelector<HTMLAudioElement>(
          "audio[data-elevenlabs]"
        );
        if (audioEl) {
          const src =
            this.audioContext.createMediaElementSource(audioEl);
          src.connect(this.analyser);
          this.analyser.connect(this.audioContext.destination);
        }
      }

      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const poll = () => {
        this.analyser!.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        this.callbacks.onVolume(Math.min(avg / 128, 1));
        this.volumeRafId = requestAnimationFrame(poll);
      };
      this.volumeRafId = requestAnimationFrame(poll);
    } catch {
      // Web Audio not available — fall back to a simple pulsing value
      let t = 0;
      const poll = () => {
        t += 0.1;
        this.callbacks.onVolume(0.4 + 0.4 * Math.abs(Math.sin(t)));
        this.volumeRafId = requestAnimationFrame(poll);
      };
      this.volumeRafId = requestAnimationFrame(poll);
    }
  }

  private stopVolumePolling(): void {
    if (this.volumeRafId !== null) {
      cancelAnimationFrame(this.volumeRafId);
      this.volumeRafId = null;
    }
  }

  isActive(): boolean {
    return this.conversation !== null;
  }
}
