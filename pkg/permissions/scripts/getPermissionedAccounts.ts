import fs from 'fs';
import path from 'path';
import { getAccountsWithPermissions } from '../src/accounts';
import { getAccountLabel } from '../src/labelling';

const main = async () => {
  const userPermissions = await getAccountsWithPermissions();

  const flattenedUserPermissions = Object.fromEntries(
    userPermissions.map((user) => [
      getAccountLabel(user.id),
      user.permissions.flatMap((permission) => permission.action.id),
    ])
  );

  const filePath = path.join(__dirname, '../permissions/actionIds.json');

  fs.writeFileSync(filePath, JSON.stringify(flattenedUserPermissions, null, 2));
};

main();
