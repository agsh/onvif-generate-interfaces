export interface DeviceServiceCapabilities {
  network?: boolean;
}
export interface GetDeviceInformation {}
export interface GetDeviceInformationResponse {
  manufacturer: string;
  model: string;
}
