import labelledAccounts from '../labelled-accounts/mainnet.json';

export const getAccountLabel = (address: string): string => {
  return labelledAccounts[address as never] ?? address;
};
