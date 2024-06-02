export interface Action {
  id: string;
  permissions: Permission[];
}

export interface Permission {
  id: string;
  account: Account;
  action: Action;
  txHash: string;
}

export interface Account {
  id: string;
  permissions: Permission[];
}
