import fs from 'fs';
import path from 'path';

export const ACTION_ID_DIRECTORY = path.join(__dirname, '../../deployments/action-ids');

export type ContractActionIdData = { useAdaptor: boolean; factoryOutput?: string; actionIds: Record<string, string> };
export type ActionIdInfo = {
  taskId: string;
  contractName: string;
  signature: string;
  useAdaptor: boolean;
};

export function safeReadJsonFile<T>(filePath: string): Record<string, T> {
  const fileExists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();

  return fileExists ? JSON.parse(fs.readFileSync(filePath).toString()) : {};
}

export function getActionIdFunctions(
  actionIdFileContents: Record<string, Record<string, ContractActionIdData>>
): Record<string, ActionIdInfo[]> {
  // Reverse the mapping of `contractName -> signature -> actionId` to be `actionId -> [contractName, signature][]`.
  // This simplifies checking for duplicate actionIds to just reading the length of the arrays.
  return Object.entries(actionIdFileContents)
    .flatMap(([taskId, taskData]) =>
      Object.entries(taskData).flatMap(([contractName, contractData]) =>
        Object.entries(contractData.actionIds).map<[string, ActionIdInfo]>(([signature, actionId]) => [
          actionId,
          { taskId, contractName, signature, useAdaptor: contractData.useAdaptor },
        ])
      )
    )
    .reduce((acc: Record<string, ActionIdInfo[]>, [actionId, actionIdInfo]) => {
      acc[actionId] = acc[actionId] ?? [];
      acc[actionId].push(actionIdInfo);
      return acc;
    }, {});
}
