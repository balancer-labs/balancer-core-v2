# <img src="../../logo.svg" alt="Balancer" height="128px">

# Balancer V2 Interfaces

[![NPM Package](https://img.shields.io/npm/v/@balancer-labs/v2-interfaces.svg)](https://www.npmjs.org/package/@balancer-labs/v2-interfaces)

This package contains interfaces used in dependent packages, which makes building systems that interact with Balancer contracts simpler, as the implementation information is not included.

## Overview

### Installation

```console
$ npm install @balancer-labs/v2-interfaces
```

### Usage

This package can be used in multiple ways, including interacting with already deployed Pools, or performing local testing. It contains all interfaces used in the system, from the foundational [Vault](contracts/vault/IVault.sol) to very specific contracts (e.g., [Optimism Gas Limit Provider](contracts/liquidity-mining/IOptimismGasLimitProvider.sol)).

The following are a couple code samples to help get you started. To get the address of deployed contracts in both production and test networks, see [`balancer-deployments` repository](https://github.com/balancer/balancer-deployments).

Sample contract that joins a Balancer Pool:

```solidity
pragma solidity ^0.7.0;

// Import Vault interface, error messages, and library for decoding join/exit data.
import "@balancer-labs/v2-interfaces/contracts/solidity-utils/helpers/BalancerErrors.sol";
import "@balancer-labs/v2-interfaces/contracts/solidity-utils/openzeppelin/IERC20.sol";
import "@balancer-labs/v2-interfaces/contracts/pool-weighted/WeightedPoolUserData.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IAsset.sol";

// Import ERC20Helpers for `_asIAsset`
import "@balancer-labs/v2-solidity-utils/contracts/helpers/ERC20Helpers.sol";

contract JoinBalancerPool {
    IVault private constant vault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

    function joinBalancerPool(bytes32 poolId, address sender, address recipient, uint256[] memory amountsIn, uint256 minBptAmountOut) external {
        (IERC20[] memory tokens, , ) = vault.getPoolTokens(poolId);

        // Use BalancerErrors to validate input
        _require(amountsIn.length == tokens.length, Errors.INPUT_LENGTH_MISMATCH);

        // Encode the userData for a multi-token join
        bytes memory userData = abi.encode(WeightedPoolUserData.JoinKind.EXACT_TOKENS_IN_FOR_BPT_OUT, amountsIn, minBptAmountOut);

        IVault.JoinPoolRequest memory request = IVault.JoinPoolRequest({
            assets: _asIAsset(tokens),
            maxAmountsIn: amountsIn,
            userData: userData,
            fromInternalBalance: false
        });

        // Call the Vault to join the pool
        vault.joinPool(poolId, sender, recipient, request);
    }

    ...
}
```

Sample contract that performs Internal Balance deposits:

```solidity
pragma solidity ^0.7.0;

import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";

contract SimpleDepositor {
    IVault private constant vault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

    function depositFunds(
        IERC20[] memory tokens,
        uint256[] memory amounts,
    ) external {
      IVault.UserBalanceOp[] memory ops = new IVault.UserBalanceOp[](tokens.length);

      for (uint256 i = 0; i < tokens.length; ++i) {
        ops[i] = IVault.UserBalanceOp({
          kind: IVault.UserBalanceOpKind.DEPOSIT_INTERNAL,
          asset: IAsset(tokens[i]),
          amount: amounts[i],
          sender: address(this),
          recipient: address(this)
        });
      }

      vault.manageUserBalance(ops);
    }
}
```

Sample contract that performs Flash Loans:

```solidity
pragma solidity ^0.7.0;

import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IFlashLoanRecipient.sol";

contract FlashLoanRecipient is IFlashLoanRecipient {
    IVault private constant vault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

    function makeFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
      vault.flashLoan(this, tokens, amounts, userData);
    }

    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        require(msg.sender == vault);
        ...
    }
}
```

### Notes

In addition to interfaces, it also includes a small number of libraries that encapsulate enum types for particular pools (e.g., [StablePoolUserData](contracts/pool-stable/StablePoolUserData.sol), and functions for working with encoding and decoding `userData`. (See the `balancer-js` package for TypeScript versions of these utilities.)

One of the most commonly included libraries is [BalancerErrors](contracts/solidity-utils/helpers/BalancerErrors.sol). To save bytecode, Balancer V2 does not use the standard `require(<condition>, 'error string')`. Instead, BalancerErrors defines `_require` and `_revert` functions. These take a numerical constant instead of a string, and return a fixed-length code, which can be converted to plain text using TypeScript utilities.

## Licensing

[GNU General Public License Version 3 (GPL v3)](../../LICENSE).

