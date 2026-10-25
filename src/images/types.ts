export interface ImageConfig {
  architecture: string;
  os: string;
  user?: string;
  env: string[];
  cmd?: string[];
  entrypoint?: string[];
  workingDir: string;
  exposedPorts: Record<string, unknown>;
  volumes: Record<string, unknown>;
  labels: Record<string, string>;
  stopSignal?: string;
  shell?: string[];
}

export interface ImageLayer {
  digest: string;
  size: number;
  createdBy: string;
}

export interface ImageManifest {
  schemaVersion: number;
  mediaType: string;
  digest: string;
  parentDigest: string | null;
  created: string;
  createdBy: string;
  configDigest: string;
  rootfsDigest: string;
  config: ImageConfig;
  layers: ImageLayer[];
}

export interface BuildArgs {
  [key: string]: string;
}

export interface BuildInstruction {
  type: string;
  args: string;
  raw: string;
  line: number;
}

export interface BuildOptions {
  contextDir: string;
  jailfilePath?: string;
  tag?: string;
  buildArgs?: Record<string, string>;
  allowUnsafeHostProcess?: boolean;
  onLog?: (line: string) => void;
}