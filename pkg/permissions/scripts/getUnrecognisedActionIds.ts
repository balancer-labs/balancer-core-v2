import fs from 'fs';
import path from 'path';
import { ContractActionIdData, getActionIdFunctions, safeReadJsonFile } from '../src/actionIds';
import { getAccountLabel } from '../src/labelling';

const funcsPath = path.join(__dirname, '../../deployments/action-ids/mainnet/action-ids.json');

const actionIdFunctions = getActionIdFunctions(safeReadJsonFile<Record<string, ContractActionIdData>>(funcsPath));

const main = async () => {
  const inputPath = path.join(__dirname, '../permissions/actionIds.json');
  const userPermissions = safeReadJsonFile<string[]>(inputPath);

  const callableFunctions = Object.fromEntries(
    Object.entries(userPermissions)
      .map(([user, actionIds]) => [
        getAccountLabel(user),
        actionIds.filter((actionId) => actionIdFunctions[actionId] == undefined),
      ])
      .filter(([, actionIds]) => actionIds.length > 0)
  );

  const filePath = path.join(__dirname, '../permissions/unrecognised.json');

  fs.writeFileSync(filePath, JSON.stringify(callableFunctions, null, 2));
};

main();
