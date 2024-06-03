# Echidna - Balancer Linear Pool

## Setup

1. Install Slither on the `dev` branch [here](https://github.com/crytic/slither/tree/dev).
2. Install Echidna 2.0. Binaries are available [here](https://github.com/crytic/echidna/releases/tag/v2.0.0-b1).
3. Apply the following patch to the `pool-linear` directory.
```
diff --git a/pkg/pool-linear/contracts/LinearPool.sol b/pkg/pool-linear/contracts/LinearPool.sol
index da40c71..c545a1f 100644
--- a/pkg/pool-linear/contracts/LinearPool.sol
+++ b/pkg/pool-linear/contracts/LinearPool.sol
@@ -156,7 +156,9 @@ contract LinearPool is BasePool, IGeneralPool, LinearMath, IRateProvider {
         bytes32 poolId = getPoolId();
         (IERC20[] memory tokens, , ) = getVault().getPoolTokens(poolId);
         uint256[] memory maxAmountsIn = new uint256[](_TOTAL_TOKENS);
-        maxAmountsIn[tokens[0] == IERC20(this) ? 0 : tokens[1] == IERC20(this) ? 1 : 2] = _MAX_TOKEN_BALANCE;
+        uint index = tokens[0] == IERC20(this) ? 0 : tokens[1] == IERC20(this) ? 1 : 2;
+        maxAmountsIn[index] = _MAX_TOKEN_BALANCE;
+        maxAmountsIn[index] = _MAX_TOKEN_BALANCE;
 
         IVault.JoinPoolRequest memory request = IVault.JoinPoolRequest({
             assets: _asIAsset(tokens),
diff --git a/pkg/pool-linear/hardhat.config.ts b/pkg/pool-linear/hardhat.config.ts
index 17fe749..a735adb 100644
--- a/pkg/pool-linear/hardhat.config.ts
+++ b/pkg/pool-linear/hardhat.config.ts
@@ -1,23 +1,6 @@
-import '@nomiclabs/hardhat-ethers';
-import '@nomiclabs/hardhat-waffle';
 
-import { hardhatBaseConfig } from '@balancer-labs/v2-common';
-import { name } from './package.json';
-
-import { task } from 'hardhat/config';
-import { TASK_COMPILE } from 'hardhat/builtin-tasks/task-names';
-import overrideQueryFunctions from '@balancer-labs/v2-helpers/plugins/overrideQueryFunctions';
-
-task(TASK_COMPILE).setAction(overrideQueryFunctions);
-
-export default {
-  networks: {
-    hardhat: {
-      allowUnlimitedContractSize: true,
-    },
-  },
+module.exports = {
   solidity: {
-    compilers: hardhatBaseConfig.compilers,
-    overrides: { ...hardhatBaseConfig.overrides(name) },
+    version: "0.7.6",
   },
 };
```
4. Then, create symlinks in the repository.
```
$ ls node_modules/@balancer-labs/ -la
total 8
drwxrwxr-x  2 user user 4096 Sep 27 11:53 .
drwxrwxr-x 29 user user 4096 Sep 27 11:50 ..
lrwxrwxrwx  1 user user   29 Sep 27 11:52 v2-asset-manager-utils -> ../../../asset-manager-utils/
lrwxrwxrwx  1 user user   20 Sep 27 11:52 v2-pool-utils -> ../../../pool-utils/
lrwxrwxrwx  1 user user   24 Sep 27 11:52 v2-solidity-utils -> ../../../solidity-utils/
lrwxrwxrwx  1 user user   14 Sep 27 11:53 v2-vault -> ../../../vault
```

## Properties

From the `pkg/pool-linear` directory, run: 

`npx hardhat clean && npx hardhat compile && echidna-test-2.0 . --contract LinearMathEchidna --config ./contracts/LinearMathEchidna.yaml`

| ID | Description | Name | Contract | Result | 
|----|-------------|------|----------|--------|
| 1 | Users cannot secure free BPT tokens by calling `calcBptOutPerMainIn` | [`calcBptOutPerMainIn`](./contracts/LinearMathEchidna.sol#L69-L99) | `LinearMathEchidna.sol` | PASSED | 
| 2 | Users cannot secure free main tokens by calling `calcBptInPerMainOut` | [`calcBptInPerMainOut`](./contracts/LinearMathEchidna.sol#L101-L132) | `LinearMathEchidna.sol` | FAILED*| 
| 3 | Users cannot secure free wrapped tokens by calling `calcWrappedOutPerMainIn` | [`calcWrappedOutPerMainIn`](./contracts/LinearMathEchidna.sol#L134-L158) | `LinearMathEchidna.sol` | PASSED | 
| 4 | Users cannot secure free main tokens `calcWrappedInPerMainOut`  | [`calcWrappedInPerMainOut`](./contracts/LinearMathEchidna.sol#L160-L185) | `LinearMathEchidna.sol` | PASSED | 
| 5  | Users cannot secure free BPT tokens by calling `calcMainInPerBptOut` | [`calcMainInPerBptOut`](./contracts/LinearMathEchidna.sol#L187-L219) | `LinearMathEchidna.sol` | PASSED | 
| 6 | Users cannot secure free main tokens by calling `calcMainOutPerBptIn`  | [`calcMainOutPerBptIn`](./contracts/LinearMathEchidna.sol#L221-L252) | `LinearMathEchidna.sol` | PASSED | 
| 7 | Users cannot secure free main tokens by calling `calcMainOutPerWrappedIn` | [`calcMainOutPerWrappedIn`](./contracts/LinearMathEchidna.sol#L254-L278) | `LinearMathEchidna.sol` | PASSED | 
| 8 | Users cannot secure free wrapped tokens by calling `calcMainInPerWrappedOut` | [`calcMainInPerWrappedOut`](./contracts/LinearMathEchidna.sol#L280-L305) | `LinearMathEchidna.sol` | PASSED | 
| 9 | Users cannot secure free BPT tokens by calling `calcBptOutPerWrappedIn` | [`calcBptOutPerWrappedIn`](./contracts/LinearMathEchidna.sol#L307-L337) | `LinearMathEchidna.sol` | PASSED | 
| 10 | Users cannot secure free wrapped tokens by calling `calcBptInPerWrappedOut` | [`calcBptInPerWrappedOut`](./contracts/LinearMathEchidna.sol#L339-L369) | `LinearMathEchidna.sol` | FAILED* | 
| 11 | Users cannot secure free BPT tokens by calling `calcWrappedInPerBptOut` | [`calcWrappedInPerBptOut`](./contracts/LinearMathEchidna.sol#L371-L402) | `LinearMathEchidna.sol` | FAILED (TOB-BALANCER-003) | 
| 12 | Users cannot secure free wrapped tokens by calling `calcWrappedOutPerBptIn` | [`calcWrappedOutPerBptIn`](./contracts/LinearMathEchidna.sol#L404-L433) | `LinearMathEchidna.sol` | PASSED | 
| 13 | `toNomimal` and `fromNominal` are inverse functions | [`nominal`](./contracts/LinearMathEchidna.sol#L436-L453) | `LinearMathEchidna.sol` | PASSED |  

`*` A call to `calcBptInPerMainOut` can result in a corner-case rounding error if the BPT supply is set to zero and the balance of the main token (`mainBalance`) is greater than zero. The same is true of calls to `calcBptInPerWrappedOut` when the BPT supply is set to zero and the balance of the wrapped token is greater than zero. As these corner cases are unlikely to occur in practice, they are not included as findings in this report. 
