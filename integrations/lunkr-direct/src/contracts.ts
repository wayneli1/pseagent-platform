export interface LunkrSession {
  readonly email: string;
  readonly selfUid: string;
  readonly deviceUuid: string;
  readonly sid: string;
  readonly cookie: string;
  readonly createdAt: string;
  readonly lastVerifiedAt: string;
}

export interface EncryptedValue {
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export interface StoredLunkrSession {
  readonly version: 1;
  readonly email: string;
  readonly selfUid: string;
  readonly deviceUuid: string;
  readonly secrets: EncryptedValue;
  readonly createdAt: string;
  readonly lastVerifiedAt: string;
}

export interface LunkrDirectMessage {
  readonly id: string;
  readonly peerUid: string;
  readonly senderUid: string;
  readonly timestamp: number;
  readonly text: string;
  readonly hasAttachments: boolean;
}

export interface LunkrApiEnvelope<T = unknown> {
  readonly code: string;
  readonly var?: T;
}
