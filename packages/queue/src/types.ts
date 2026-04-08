export type QueueMessage = {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
};

export type QueueError = string;
