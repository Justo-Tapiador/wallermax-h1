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
  /** External model to import (.glb/.gltf/.obj/.fbx/.ply). v1.2.0 */
  file?: string;
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
  /** Bind DOF focus to the tracked target so the subject stays sharp. v1.2.0 */
  dof_autofocus?: boolean;
}

export type RenderQuality = "preview" | "standard" | "cinematic";

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
    | "spline_path"
    | "zoom_in"
    | "zoom_out"
    | "custom";
  target?: string;
  duration?: number;
  angle?: number;
  distance?: number;
  speed?: number;
  /** Waypoints [x,y,z] for spline_path. v1.2.0 */
  path?: number[][];
  /** Temporal easing for spline_path / zoom. v1.2.0 */
  easing?: "linear" | "ease_in" | "ease_out" | "ease_in_out";
  /** Close the spline into a loop. v1.2.0 */
  loop?: boolean;
  /** Focal length range for zoom_in / zoom_out (mm). v1.2.0 */
  lens_start?: number;
  lens_end?: number;
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

export interface EnvironmentSpec {
    gravity?: [number, number, number];
    ambient_color?: [number, number, number];
    ambient_intensity?: number;
    /** HDRI environment lighting (highest realism). v1.2.0 */
    hdri?: {
      path: string;
      rotation_z?: number;
    };
    /** Nishita physical sky (exteriors). v1.2.0 */
    sky?: {
      sun_elevation?: number;
      sun_rotation?: number;
      altitude?: number;
      air_density?: number;
      dust_density?: number;
      ozone?: number;
      sun_strength?: number;
      sun_light?: boolean;
      color_temperature_k?: number;
    };
    depth_status?: string;
    depth_scale?: string;
    depth_message?: string;
    substeps_per_frame?: number;
    points_per_frame?: number;
  }

export interface WorldBlock {
  units?: string;
  coordinate_system?: string;
  environment?: EnvironmentSpec;
  render: {
    width: number;
    height: number;
    fps: number;
    duration: number;
    engine?: "BLENDER_EEVEE_NEXT" | "CYCLES";
    samples?: number;
    /** Quality preset. v1.2.0 — cinematic = motion blur + raytracing + AgX */
    quality?: RenderQuality;
    /** Motion-blur shutter (cinematic only, 0.5 = 180°). v1.2.0 */
    shutter?: number;
    /** Optional ffmpeg finalize pass on the MP4. v1.2.0 */
    postprocess?: boolean;
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
    /** Lens dispersion (0-1). v1.2.0 */
    chromatic_aberration?: number;
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
export interface UserAtlasTile {
  dest_row: number;
  dest_col: number;
  source_atlas: string;
  source_row: number;
  source_col: number;
}

export interface UserAtlas {
  version: string;
  grid_cols: number;
  grid_rows: number;
  tile_size: number;
  tiles: UserAtlasTile[];
}

export interface PipelineRequest {
  prompt: string;
  systemPromptExtra?: string;
  provider: "openai" | "zai" | "mock" | "deepseek";
  model?: string;
  referenceImage?: { name: string; path: string; mime: string };
  finalImage?: { name: string; path: string; mime: string };
  userAtlas?: UserAtlas;
  render: {
    width: number;
    height: number;
    fps: number;
    duration: number;
    engine?: "BLENDER_EEVEE_NEXT" | "CYCLES";
    samples?: number;
    /** Quality preset (falls back to the LLM's choice, then "standard"). v1.2.0 */
    quality?: RenderQuality;
    /** Optional ffmpeg finalize pass on the MP4. v1.2.0 */
    postprocess?: boolean;
  };
  depthBackend?: "none" | "transformers";
  depthModel?: string;
  skipBlender?: boolean;
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
  provider: "openai" | "zai" | "mock" | "deepseek";
  basicAuth?: { user: string; pass: string };
}
