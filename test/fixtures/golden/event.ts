export interface NotificationMessage {
  utcTime: Date;
  topic?: string;
}
export interface PullMessagesResponse {
  currentTime: Date;
  terminationTime: Date;
  notificationMessage?: NotificationMessage[];
}
