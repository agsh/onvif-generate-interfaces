import { Duration, PositiveInteger } from './basics';

/**
 * Opaque reference token.
 * @xsd maxLength 64
 */
export type ReferenceToken = string;
/**
 * @xsd minLength 8
 * @xsd maxLength 63
 * @xsd pattern [ -~]{8,63}
 */
export type PskPassphrase = string;
export type MoveStatus = 'IDLE' | 'MOVING' | 'UNKNOWN';
export type ReferenceTokenList = ReferenceToken[];
export type Delay = Duration;
export type ExtendedDirection = 'Left' | 'Right' | 'Any';
export type Direction = ExtendedDirection;
export interface DeviceEntity {
  token: ReferenceToken;
}
/** Analytics object (renamed to OnvifObject in TS). */
export interface OnvifObject extends DeviceEntity {
  appearance?: string;
  [key: string]: unknown;
  [key: symbol]: unknown;
}
export interface PTZStatus {
  moveStatus?: MoveStatus;
  utcTime: Date;
  [key: string]: unknown;
  [key: symbol]: unknown;
}
export interface GetStatus {
  profileToken?: ReferenceToken;
  count?: PositiveInteger;
  tracked?: OnvifObject;
}
export interface SerialData {
  binary?: string;
  string?: string;
}
export interface MetadataStream {
  PTZ?: PTZStatus[];
  event?: string[];
  [key: string]: unknown;
  [key: symbol]: unknown;
}
export interface BoundedItems {
  item?: string[];
  a?: string[];
  b?: number[];
}
export interface PresetDetail {
  presetToken?: ReferenceToken;
  home?: boolean;
  [key: string]: unknown;
  [key: symbol]: unknown;
}
export interface CertificateUsage {
  _: string;
  critical: boolean;
}
export type TokenRef = ReferenceToken;
export interface UnorderedPair {
  left: string;
  right?: string;
}
export interface NamedPoint {
  token: ReferenceToken;
  name?: string;
  x: number;
  y: number;
}
export interface FrameExtension {
  motionInCells?: boolean;
  [key: string]: unknown;
  [key: symbol]: unknown;
}
export interface FrameExtension2 {
  [key: string]: unknown;
  [key: symbol]: unknown;
}
