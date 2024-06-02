import fs from 'fs';
import path from 'path';
import { ActionIdInfo, ContractActionIdData, getActionIdFunctions, safeReadJsonFile } from '../src/actionIds';
import { getAccountLabel } from '../src/labelling';

const funcsPath = path.join(__dirname, '../../deployments/action-ids/mainnet/action-ids.json');

const actionIdFunctions = getActionIdFunctions(safeReadJsonFile<Record<string, ContractActionIdData>>(funcsPath));

const specialCasedActionIds: Record<string, ActionIdInfo[]> = {
  // Withdraw permission over BALTokenHolder for veBAL gauge.
  '0x79922681fd17c90b4f3409d605f5b059ffcbcef7b5440321ae93b87f3b5c1c78': [
    {
      taskId: '20220325-bal-token-holder-factory',
      contractName: 'BALTokenHolder',
      signature: 'function withdrawFunds(address,uint256)',
      useAdaptor: false,
    },
  ],
};

const ignoredActionIds: string[] = [
  // Root permission. This is being removed as part of the migration to TimelockAuthorizer.
  '0x0000000000000000000000000000000000000000000000000000000000000000',
  // Permissions to managed an unused deployment of ComposableStablePool.
  // Granted in https://forum.balancer.fi/t/bip-49-composablestable-and-aavelinearpools-permission-granting/3631
  // Should be revoked/renounced before migration.
  '0x11562115fbcf4955e097732f59969867f1cb458a8cbd648231b0ffae14c800de',
  '0xf8ab8bdb4497d157053d2f796e50c33e6fff3d586b6db6880ab12eff1d907b2b',
  '0x94611f33019f04ed070e076bbacb9ff5c5fe03d7184bef4026e1ee669d3b623e',
  '0xd4f0c40da2129d4b1aba541e693e03b92a323a66f649257a258fe6e4ea331b52',
  '0x367e95c6cc9f3041f3c6ee21b06ef8992a82318a6b2adbbfb6af3ee601769a30',
  '0xfef90c64be79cb170a20e526196e7c8f2f37f441ae85c945c18a91a64777d309',
  // Withdraw permission over unused BALTokenHolders
  // LM committee BALTokenHolder
  '0x590e300e371ba81baff1c912e578fdecbfa490f39994607a18ee692ab942f846',
  // Polygon BALTokenHolder
  '0x802db13f34b039826402f87748c166a94c8130bf894f8af7e1144c874b36b76e',
  // Arbitrum BALTokenHolder
  '0xbfa133e7b0ebe7bf8b3f11a17a38c0f4492b428e4fb7fc8b509da63189247b06',
  // Added to get the permissions:map script to work
  // AaveLinearPoolFactory.disable()
  '0x3924d0d790727bf2925421c7e316cfbe3d8b69f26b36b9d7d1c97e32bdeb4947',
  // AaveLinearPool.pause()
  '0x1f16abe3860c7a3426659e50f0217af96ac40aa554d8ddaebcb7c399118eeb1b',
  // AaveLinearPool.unpause()
  '0xcdd7ab46c8258e8c091144b92a3a1061315e0da3aef7773d859de4ee421fd920',
  // AaveLinearPool.setTargets()
  '0x881bd2702150eafb9524fe01e983df0fb0e99eca758c1b3959e46a084cc1618b',
  // AaveLinearPool.setSwapFeePercentage()
  '0x0693774dcda5e82a5b5f4255fe8bc7aa5f7ce39cd6b4f9986b116fc4af317450',
];

const main = async () => {
  const inputPath = path.join(__dirname, '../permissions/actionIds.json');
  const userPermissions = safeReadJsonFile<string[]>(inputPath);

  const callableFunctions = Object.fromEntries(
    Object.entries(userPermissions).map(([user, actionIds]) => [
      getAccountLabel(user),
      actionIds
        .filter((actionId) => !ignoredActionIds.includes(actionId))
        .flatMap((actionId) => {
          const actionIdInfo = actionIdFunctions[actionId] ?? specialCasedActionIds[actionId];
          if (actionIdInfo === undefined) throw new Error(`Unknown action id: ${actionId}`);
          return actionIdInfo;
        }),
    ])
  );

  const filePath = path.join(__dirname, '../permissions/functions.json');

  fs.writeFileSync(filePath, JSON.stringify(callableFunctions, null, 2));
};

main();
