export interface MyobTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: string | number;
  refresh_token: string;
  scope?: string;
  user?: {
    uid: string;
    username: string;
  };
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  userUid?: string;
  username?: string;
}

export interface CompanyConnection {
  businessId: string;
  displayName?: string;
  connectedAt: string;
  tokens: StoredTokens;
}

export interface ConnectionStore {
  connections: CompanyConnection[];
  activeBusinessId?: string;
}

export interface MyobInventoryItem {
  UID: string;
  Number?: string;
  Name?: string;
  Description?: string;
  IsActive?: boolean;
  IsBought?: boolean;
  IsSold?: boolean;
  IsInventoried?: boolean;
  QuantityOnHand?: number;
  QuantityCommitted?: number;
  QuantityOnOrder?: number;
  QuantityAvailable?: number;
  AverageCost?: number;
  CurrentValue?: number;
  BaseSellingPrice?: number;
  LastModified?: string;
  URI?: string;
  [key: string]: unknown;
}

export interface MyobPagedResponse<T> {
  Items: T[];
  NextPageLink?: string | null;
  Count?: number;
}
