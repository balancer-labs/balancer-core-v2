import fetch, { Response } from 'node-fetch';
import { Account } from './types';

export const getAccountsWithPermissions = async (): Promise<Account[]> => {
  const response: Response = await fetch('https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-authorizer', {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
    },

    body: JSON.stringify({
      query: `{
        accounts(first: 500) {
          id
          permissions {
            action {
              id
            }
          }
        }
      }`,
    }),
  });

  const {
    data: { accounts },
  }: { data: { accounts: Account[] } } = await response.json();

  // The subgraph response also includes accounts which once had permissions which have since been revoked.
  // We filter these out as they're not interesting.
  const accountsWithPermissions = accounts.filter((acc) => acc.permissions.length > 0);

  return accountsWithPermissions;
};
