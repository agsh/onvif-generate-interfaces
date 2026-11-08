export interface Capabilities {
  snapshotUri?: boolean;
  [key: string]: unknown;
  [key: symbol]: unknown;
}
