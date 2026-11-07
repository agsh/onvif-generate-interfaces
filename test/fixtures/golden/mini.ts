import { Duration, PositiveInteger } from './basics';

/** Opaque reference token. */
export type ReferenceToken = string;
export type MoveStatus = 'IDLE' | 'MOVING' | 'UNKNOWN';
export type ReferenceTokenList = ReferenceToken[];
export type Delay = Duration;
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
}
