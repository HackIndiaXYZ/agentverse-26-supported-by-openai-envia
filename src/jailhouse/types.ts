export interface JailhousePort {
  published: number | string;
  target: number | string;
  protocol?: "tcp" | "udp";
}

export interface JailhouseService {
  image?: string;
  build?: {
    context: string;
    jailfile?: string;
  };
  command?: string | string[];
  args?: string[];
  entrypoint?: string | string[];
  environment?: Record<string, string>;
  env_file?: string | string[];
  ports?: Array<string | JailhousePort>;
  volumes?: string[];
  mounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
  networks?: string[];
  depends_on?: string[] | Record<string, { condition?: string }>;
  healthcheck?: {
    test?: string | string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  restart?: "no" | "always" | "on-failure" | "unless-stopped";
  working_dir?: string;
  user?: string;
  cpu?: number;
  memory?: string;
  pids?: number;
  runtime_ms?: number;
  profiles?: string[];
  command_override?: string[];
}

export interface JailhouseNetwork {
  driver?: string;
  external?: boolean;
  name?: string;
}

export interface JailhouseVolume {
  driver?: string;
  external?: boolean;
  name?: string;
}

export interface JailhouseConfig {
  name?: string;
  version?: string;
  services: Record<string, JailhouseService>;
  networks?: Record<string, JailhouseNetwork>;
  volumes?: Record<string, JailhouseVolume>;
  profiles?: string[];
}

export interface JailhouseServiceState {
  name: string;
  jailId?: string;
  imageDigest?: string;
  state: "created" | "running" | "stopped" | "failed" | "removed";
  exitCode?: number | null;
  startedAt?: string;
  stoppedAt?: string;
  health?: "starting" | "healthy" | "unhealthy" | "none";
  restartCount?: number;
}

export interface JailhouseApplicationState {
  name: string;
  configPath: string;
  createdAt: string;
  updatedAt: string;
  services: Record<string, JailhouseServiceState>;
  networks: string[];
  volumes: string[];
  status: "running" | "partial" | "stopped" | "failed";
}