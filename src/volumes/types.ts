export interface Volume {
  name: string;
  path: string;
  createdAt: string;
}

export interface VolumeMountOptions {
  readOnly?: boolean;
}