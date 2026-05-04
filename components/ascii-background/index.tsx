"use client";

/**
 * ASCII Background Renderer
 *
 * Ported from MemeDeck's components/ascii-renderer/index.tsx.
 * Zustand and image-proxy dependencies removed.
 * Added `audioIntensity` prop to drive brightness from ElevenLabs audio volume.
 */

import { Camera, Mesh, Plane, Program, Renderer, RenderTarget, Transform } from "ogl";
import { useEffect, useRef } from "react";

// ─── Noise shader (renders coloured Perlin noise to a RenderTarget) ───────────

const vertexShaderSource = `#version 300 es
in vec2 uv;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `#version 300 es
precision mediump float;

uniform float uFrequency;
uniform float uTime;
uniform float uSpeed;
uniform float uValue;
uniform vec3 uColorStart;
uniform vec3 uColorMid;
uniform vec3 uColorEnd;

in vec2 vUv;
out vec4 fragColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float cnoise(vec3 P) {
  vec3 Pi0 = floor(P); vec3 Pi1 = Pi0 + vec3(1.0);
  Pi0 = mod289(Pi0); Pi1 = mod289(Pi1);
  vec3 Pf0 = fract(P); vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz; vec4 iz1 = Pi1.zzzz;
  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0); vec4 ixy1 = permute(ixy + iz1);
  vec4 gx0 = ixy0 * (1.0 / 7.0);
  vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5); gy0 -= sz0 * (step(0.0, gy0) - 0.5);
  vec4 gx1 = ixy1 * (1.0 / 7.0);
  vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5); gy1 -= sz1 * (step(0.0, gy1) - 0.5);
  vec3 g000 = vec3(gx0.x,gy0.x,gz0.x); vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
  vec3 g010 = vec3(gx0.z,gy0.z,gz0.z); vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
  vec3 g001 = vec3(gx1.x,gy1.x,gz1.x); vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
  vec3 g011 = vec3(gx1.z,gy1.z,gz1.z); vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);
  vec4 norm0 = taylorInvSqrt(vec4(dot(g000,g000),dot(g010,g010),dot(g100,g100),dot(g110,g110)));
  g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001,g001),dot(g011,g011),dot(g101,g101),dot(g111,g111)));
  g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;
  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);
  vec3 fade_xyz = Pf0 * Pf0 * Pf0 * (Pf0 * (Pf0 * 6.0 - 15.0) + 10.0);
  vec4 n_z = mix(vec4(n000,n100,n010,n110), vec4(n001,n101,n011,n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
  return 2.2 * n_xyz;
}

void main() {
  float noise = abs(cnoise(vec3(vUv * uFrequency, uTime * uSpeed)));
  vec3 col;
  if (noise < 0.33) {
    col = mix(uColorStart, uColorMid, noise / 0.33);
  } else if (noise < 0.66) {
    col = mix(uColorMid, uColorEnd, (noise - 0.33) / 0.33);
  } else {
    col = mix(uColorEnd, uColorStart, (noise - 0.66) / 0.34);
  }
  fragColor = vec4(col * uValue, 1.0);
}
`;

// ─── ASCII post-process shader ────────────────────────────────────────────────

const asciiVertexShaderSource = `#version 300 es
in vec2 uv;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const asciiFragmentShaderSource = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform sampler2D uTexture;

in vec2 vUv;
out vec4 fragColor;

float character(int n, vec2 p) {
  p = floor(p * vec2(-4.0, 4.0) + 2.5);
  if (clamp(p.x, 0.0, 4.0) == p.x && clamp(p.y, 0.0, 4.0) == p.y) {
    int a = int(round(p.x) + 5.0 * round(p.y));
    if (((n >> a) & 1) == 1) return 1.0;
  }
  return 0.0;
}

void main() {
  vec2 pix = gl_FragCoord.xy;
  vec3 col = texture(uTexture, floor(pix / 16.0) * 16.0 / uResolution.xy).rgb;
  float gray = 0.3 * col.r + 0.59 * col.g + 0.11 * col.b;
  int n = 4096;
  if (gray > 0.2) n = 65600;
  if (gray > 0.3) n = 163153;
  if (gray > 0.4) n = 15255086;
  if (gray > 0.5) n = 13121101;
  if (gray > 0.6) n = 15252014;
  if (gray > 0.7) n = 13195790;
  if (gray > 0.8) n = 11512810;
  vec2 p = mod(pix / 8.0, 2.0) - vec2(1.0);
  col = col * character(n, p);
  fragColor = vec4(col, 1.0);
}
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface AsciiBackgroundControls {
  frequency?: number;
  speed?: number;
  value?: number;
  colorStart?: string;
  colorMid?: string;
  colorEnd?: string;
}

interface Props {
  controls?: AsciiBackgroundControls;
  /** 0-1 audio intensity — increases brightness when Pepe speaks */
  audioIntensity?: number;
}

const DEFAULTS: Required<AsciiBackgroundControls> = {
  frequency: 3.5,
  speed: 0.12,
  value: 0.8,
  colorStart: "#0060ee",
  colorMid: "#8744bb",
  colorEnd: "#10d3da",
};

export default function AsciiBackground({ controls = {}, audioIntensity = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  // Use a ref so the animation loop always reads the latest value without
  // causing a full renderer re-init.
  const audioIntensityRef = useRef(audioIntensity);
  const noiseProgramRef = useRef<Program | null>(null);

  useEffect(() => {
    audioIntensityRef.current = audioIntensity;
    // Directly update the uniform so we don't re-init WebGL on every volume tick.
    if (noiseProgramRef.current) {
      const c = { ...DEFAULTS, ...controls };
      const boosted = Math.min(c.value + audioIntensity * 0.4, 1.0);
      noiseProgramRef.current.uniforms.uValue.value = boosted;
    }
  }, [audioIntensity, controls]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
      container.appendChild(canvasRef.current);
    }
    const canvas = canvasRef.current;
    const w = window.innerWidth;
    const h = window.innerHeight;

    const renderer = new Renderer({
      canvas,
      width: w,
      height: h,
      dpr: Math.min(window.devicePixelRatio, 2),
    });
    const gl = renderer.gl;
    gl.clearColor(0.05, 0.05, 0.05, 1);

    const camera = new Camera(gl, { fov: 45 });
    camera.position.z = 5;

    const scene = new Transform();
    const geometry = new Plane(gl, { width: 2, height: 2 });
    const renderTarget = new RenderTarget(gl, { width: w, height: h });

    const c = { ...DEFAULTS, ...controls };

    const noiseProgram = new Program(gl, {
      vertex: vertexShaderSource,
      fragment: fragmentShaderSource,
      uniforms: {
        uTime: { value: 0 },
        uFrequency: { value: c.frequency },
        uSpeed: { value: c.speed },
        uValue: { value: c.value },
        uColorStart: { value: hexToRgb(c.colorStart) },
        uColorMid: { value: hexToRgb(c.colorMid) },
        uColorEnd: { value: hexToRgb(c.colorEnd) },
      },
    });
    noiseProgramRef.current = noiseProgram;

    const asciiProgram = new Program(gl, {
      vertex: asciiVertexShaderSource,
      fragment: asciiFragmentShaderSource,
      uniforms: {
        uResolution: { value: [w, h] },
        uTexture: { value: renderTarget.texture },
      },
    });

    const noiseMesh = new Mesh(gl, { geometry, program: noiseProgram });
    noiseMesh.setParent(scene);
    const asciiMesh = new Mesh(gl, { geometry, program: asciiProgram });
    asciiMesh.setParent(scene);

    let last = 0;
    const FPS = 30;
    const FRAME_TIME = 1000 / FPS;

    const animate = (t: number) => {
      rafRef.current = requestAnimationFrame(animate);
      if (t - last < FRAME_TIME) return;
      last = t;

      const elapsed = t * 0.001;
      noiseProgram.uniforms.uTime.value = elapsed;
      noiseProgram.uniforms.uFrequency.value = c.frequency;
      noiseProgram.uniforms.uSpeed.value = c.speed;
      noiseProgram.uniforms.uColorStart.value = hexToRgb(c.colorStart);
      noiseProgram.uniforms.uColorMid.value = hexToRgb(c.colorMid);
      noiseProgram.uniforms.uColorEnd.value = hexToRgb(c.colorEnd);
      // value is updated directly via the audioIntensity effect above

      renderer.render({ scene: noiseMesh, camera, target: renderTarget });
      asciiProgram.uniforms.uResolution.value = [gl.canvas.width, gl.canvas.height];
      renderer.render({ scene: asciiMesh, camera });
    };

    rafRef.current = requestAnimationFrame(animate);

    const handleResize = () => {
      const nw = window.innerWidth;
      const nh = window.innerHeight;
      renderer.setSize(nw, nh);
      camera.perspective({ aspect: nw / nh });
      asciiProgram.uniforms.uResolution.value = [nw, nh];
    };
    window.addEventListener("resize", handleResize);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", handleResize);
      noiseProgramRef.current = null;
      if (canvas && container.contains(canvas)) {
        container.removeChild(canvas);
        canvasRef.current = null;
      }
    };
  }, []); // intentionally empty — controls/audioIntensity update via refs

  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
      }}
    />
  );
}
