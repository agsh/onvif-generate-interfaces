import { ReferenceToken } from './mini';

export interface Capabilities {
  EFlip?: boolean;
  reverse?: boolean;
  [key: string]: unknown;
  [key: symbol]: unknown;
}
export interface GetStatus {
  profileToken?: ReferenceToken;
}
export interface GetStatusResponse {
  PTZStatus: string;
}
export interface StopResponse {}
