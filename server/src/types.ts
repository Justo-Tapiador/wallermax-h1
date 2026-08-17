// Wallermax H1 — shared types

export type Provenance = "observed" | "user_defined" | "inferred" | "creative";

export interface Transform {
  position?: [number, number, number];
  rotation?: [number, number, number]; // Euler XYZ, degrees
  scale?: [number, number, number];
}

export interface Geometry {
  shape?: "sphere" | "box" | "cylinder" | "plane" | "mesh" | "room" | "custom";
  radius?: number;
  dimensions?: [number, number, number];
  depth?: number;
  size?: number;
  subdivisions?: number;
}

export interface MaterialSpec {
  base_color?: [number, number, number] | [number, number, number, number];
  roughness?: number;
  metallic?: number;
  ior?: number;
  emission?: [number, number, number];
  emission_strength?: number;
  alpha?: number;
  pattern?: "solid" | "checker" | "noise" | "gradient" | "brick";
  pattern_scale?: number;
  texture_image?: string;
  normal_image?: string;
  roughness_image?: string;
}

export interface LightSpec {
  type: "POINT" | "AREA" | "SUN" | "SPOT";
  power?: number;
  color?: [number, number, number];
  color_temperature_k?: number;
  size?: number;
  shape?: "DISK" | "RECTANGLE" | "SQUARE";
  beam_angle?: number;
  softness?: number;
}

export interface CameraSpec {
  lens?: number;
  sensor_width?: number;
  projection?: "perspective" | "orthographic";
  target?: string;
  look_at?: [number, number, number];
  fov_deg?: number;
  dof_focus_distance?: number;
  dof_fstop?: number;
}

export interface BehaviorSpec {
  type:
    | "static"
    | "look_at"
    | "follow"
    | "orbit"
    | "dolly_in"
    | "dolly_out"
    | "crane_up"
    | "crane_down"
    | "pan"
    | "tilt"
    | "custom";
  target?: string;
  duration?: number;
  angle?: number;
  distance?: number;
  speed?: number;
}

export interface Entity {
  id: string;
  type: string;
  name?: string;
  provenance: Provenance;
  confidence: number;
  locked?: boolean;
  parent?: string | null;
  transform?: Transform;
  geometry?: Geometry;
  material?: MaterialSpec;
  light?: LightSpec;
  camera?: CameraSpec;
  physics?: {
    rigid_body?: {
      mass?: number;
      restitution?: number;
      friction?: number;
      type?: "ACTIVE" | "PASSIVE";
    };
  };
  behavior?: BehaviorSpec;
  metadata?: Record<string, unknown>;
}

export interface WorldBlock {
  units?: string;
  coordinate_system?: string;
  environment?: {
    gravity?: [number, number, number];
    ambient_color?: [number, number, number];
    ambient_intensity?: number;
    depth_status?: string;
    depth_scale?: string;
    depth_message?: string;
    substeps_per_frame?: number;
    points_per_frame?: number;
  };
  render: {
    width: number;
    height: number;
    fps: number;
    duration: number;
    engine?: "BLENDER_EEVEE_NEXT" | "CYCLES";
    samples?: number;
  };
  aesthetic?: {
    source_image?: string;
    palette?: number[][];
    color_temperature_k?: number;
    mood?: string;
    style_tags?: string[];
    grain?: number;
    vignette?: number;
    bloom?: number;
    exposure_ev?: number;
  };
}

export interface WorldModel {
  version: string;
  world: WorldBlock;
  entities: Entity[];
  relationships: unknown[];
  constraints?: unknown[];
  events: unknown[];
}

// ── Pipeline request (matches the multipart form posted by the web UI) ──
export interface PipelineRequest {
  prompt: string;
  systemPromptExtra?: string;
  provider: "openai" | "zai" | "mock";
  model?: string;
  referenceImage?: { name: string; path: string; mime: string };
  finalImage?: { name: string; path: string; mime: string };
  render: {
    width: number;
    height: number;
    fps: number;
    duration: number;
    engine?: "BLENDER_EEVEE_NEXT" | "CYCLES";
    samples?: number;
  };
  skipBlender?: boolean;
  depthBackend?: "none" | "transformers";
  depthModel?: string;
}

export type JobStatus =
  | "queued"
  | "analyzing"
  | "compiling"
  | "rendering"
  | "done"
  | "error";

export interface JobProgress {
  jobId: string;
  status: JobStatus;
  progress: number; // 0..1
  stage: string;
  message?: string;
  startedAt: number;
  finishedAt?: number;
  /** Which renderer was used: "blender" (full 3D) or "fallback" (preview). */
  renderEngine?: "blender" | "fallback";
  /** Renderer log lines (Blender / fallback renderer output). Visible in the UI. */
  logs?: string[];
  /** Current frame being rendered (for progress display). */
  currentFrame?: number;
  /** Total number of frames to render. */
  totalFrames?: number;
  /** Set to true when the user requests an abort. */
  abortRequested?: boolean;
  artifacts?: {
    worldJson?: string;
    sceneReportMd?: string;
    reconstructionJson?: string;
    finalImageJson?: string;
    blendFile?: string;
    renderMp4?: string;
    renderPosterPng?: string;
  };
  error?: string;
  world?: WorldModel;
  reconstruction?: unknown;
  finalImageAnalysis?: unknown;
}

export interface ServerConfig {
  port: number;
  host: string;
  workdir: string;
  blenderBin: string;
  skipBlender: boolean;
  defaultRender: { width: number; height: number; fps: number; duration: number };
  maxUploadBytes: number;
  provider: "openai" | "zai" | "mock";
  basicAuth?: { user: string; pass: string };
}
