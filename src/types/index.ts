export enum AccountStatus {
  INITIALIZING = 'INITIALIZING',
  QR_READY = 'QR_READY',
  AUTHENTICATED = 'AUTHENTICATED',
  DISCONNECTED = 'DISCONNECTED',
}

export interface ClientInstanceInfo {
  id: string;
  status: AccountStatus;
  qrCode: string | null;
  error: string | null;
  proxy: string;
}

export interface AccountCreatePayload {
  id: string;
  proxy: string;
}

export interface AccountResponse {
  id: string;
  status: AccountStatus;
  qrCode: string | null;
  error: string | null;
  name?: string;
  phoneNumber?: string;
}
