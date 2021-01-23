// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

pragma solidity ^0.7.1;

import "hardhat/console.sol";

import "@openzeppelin/contracts/utils/SafeCast.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";

import "./BalanceAllocation.sol";
import "../../math/FixedPoint.sol";

contract MinimalSwapInfoPoolsBalance {
    using SafeCast for uint256;
    using FixedPoint for int256;
    using BalanceAllocation for bytes32;

    using EnumerableSet for EnumerableSet.AddressSet;

    // Data for Pools with Minimal Swap Info Specialization setting
    //
    // These Pools use the IMinimalSwapInfoPoolQuote interface, and so the Vault must read the balance of the two tokens
    // in the swap. The best solution is to use a mapping from token to balance, which lets us read or write any token's
    // balance in a  single storage access.
    // We also keep a set with all tokens in the Pool in order to implement getPoolTokens, and update this set when
    // cash is added or removed from the pool. Tokens in the set always have a non-zero balance, so we don't need to
    // check the set for token existence during a swap: the non-zero balance check achieves this for less gas.

    mapping(bytes32 => EnumerableSet.AddressSet) internal _minimalSwapInfoPoolsTokens;
    mapping(bytes32 => mapping(IERC20 => bytes32)) internal _minimalSwapInfoPoolsBalances;

    /**
     * @dev Returns an array with all the tokens in a Minimal Swap Info Pool. This order may change when tokens are
     * added to or removed from the Pool.
     */
    function _getMinimalSwapInfoPoolTokens(bytes32 poolId) internal view returns (IERC20[] memory) {
        IERC20[] memory tokens = new IERC20[](_minimalSwapInfoPoolsTokens[poolId].length());

        for (uint256 i = 0; i < tokens.length; ++i) {
            tokens[i] = IERC20(_minimalSwapInfoPoolsTokens[poolId].at(i));
        }

        return tokens;
    }

    /**
     * @dev Returns the balance for a token in a Minimal Swap Info Pool.
     *
     * Requirements:
     *
     * - `token` must be in the Pool.
     */
    function _getMinimalSwapInfoPoolBalance(bytes32 poolId, IERC20 token) internal view returns (bytes32) {
        bytes32 balance = _minimalSwapInfoPoolsBalances[poolId][token];
        bool existsToken = balance.isNotZero() || _minimalSwapInfoPoolsTokens[poolId].contains(address(token));
        require(existsToken, "ERR_TOKEN_NOT_REGISTERED");
        return balance;
    }

    /**
     * @dev Registers a list of tokens in a Minimal Swap Info Pool.
     *
     * Requirements:
     *
     * - Each token must not be the zero address.
     * - Each token must not be registered in the Pool.
     */
    function _registerMinimalSwapInfoPoolTokens(bytes32 poolId, IERC20[] memory tokens) internal {
        EnumerableSet.AddressSet storage poolTokens = _minimalSwapInfoPoolsTokens[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            IERC20 token = tokens[i];
            require(token != IERC20(0), "ERR_TOKEN_CANT_BE_ZERO");
            bool added = poolTokens.add(address(token));
            require(added, "ERR_TOKEN_ALREADY_REGISTERED");
        }
    }

    /**
     * @dev Unregisters a list of tokens in a Minimal Swap Info Pool.
     *
     * Requirements:
     *
     * - Each token must be registered in the Pool.
     * - Each token must have non balance in the Vault.
     */
    function _unregisterMinimalSwapInfoPoolTokens(bytes32 poolId, IERC20[] memory tokens) internal {
        EnumerableSet.AddressSet storage poolTokens = _minimalSwapInfoPoolsTokens[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            IERC20 token = tokens[i];
            require(_minimalSwapInfoPoolsBalances[poolId][token].isZero(), "ERR_TOKEN_BALANCE_IS_NOT_ZERO");
            bool removed = poolTokens.remove(address(token));
            require(removed, "ERR_TOKEN_NOT_REGISTERED");
            // No need to delete the balance entries, since they already are zero
        }
    }

    /**
     * @dev Adds cash to a Minimal Swap Info Pool for a list of tokens. This function doesn't check that the lengths of
     * `tokens` and `amounts` match, it is responsibility of the caller to ensure that.
     *
     * Requirements:
     *
     * - Each token must be registered in the pool
     * - Amounts can be zero
     */
    function _increaseMinimalSwapInfoPoolCash(
        bytes32 poolId,
        IERC20[] memory tokens,
        uint256[] memory amounts
    ) internal {
        EnumerableSet.AddressSet storage poolTokens = _minimalSwapInfoPoolsTokens[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            uint128 amount = amounts[i].toUint128();
            _updateMinimalSwapInfoPoolBalance(poolTokens, poolId, tokens[i], BalanceAllocation.increaseCash, amount);
        }
    }

    function _alterMinimalSwapInfoPoolCash(
        bytes32 poolId,
        IERC20[] memory tokens,
        int256[] memory amounts
    ) internal {
        EnumerableSet.AddressSet storage poolTokens = _minimalSwapInfoPoolsTokens[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            int256 amount = amounts[i];

            _updateMinimalSwapInfoPoolBalance(
                poolTokens,
                poolId,
                tokens[i],
                amount > 0 ? BalanceAllocation.increaseCash : BalanceAllocation.decreaseCash,
                amount.abs().toUint128()
            );
        }
    }

    /**
     * @dev Removes cash from a  Minimal Swap Info Pool for a list of tokens. This function doesn't check that the
     * lengths of `tokens` and `amounts` match, it is responsibility of the caller to ensure that.
     *
     * Requirements:
     *
     * - Each token must be registered in the Pool.
     * - Each amount must be less or equal than the Pool's cash for that token.
     */
    function _decreaseMinimalSwapInfoPoolCash(
        bytes32 poolId,
        IERC20[] memory tokens,
        uint256[] memory amounts
    ) internal {
        EnumerableSet.AddressSet storage poolTokens = _minimalSwapInfoPoolsTokens[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            uint128 amount = amounts[i].toUint128();
            _updateMinimalSwapInfoPoolBalance(poolTokens, poolId, tokens[i], BalanceAllocation.decreaseCash, amount);
        }
    }

    function _minimalSwapInfoPoolCashToManaged(
        bytes32 poolId,
        IERC20 token,
        uint128 amount
    ) internal {
        _updateMinimalSwapInfoPoolBalance(poolId, token, BalanceAllocation.cashToManaged, amount);
    }

    function _minimalSwapInfoPoolManagedToCash(
        bytes32 poolId,
        IERC20 token,
        uint128 amount
    ) internal {
        _updateMinimalSwapInfoPoolBalance(poolId, token, BalanceAllocation.managedToCash, amount);
    }

    function _setMinimalSwapInfoPoolManagedBalance(
        bytes32 poolId,
        IERC20 token,
        uint128 amount
    ) internal {
        _updateMinimalSwapInfoPoolBalance(poolId, token, BalanceAllocation.setManagedBalance, amount);
    }

    function _minimalSwapInfoPoolIsManaged(bytes32 poolId, IERC20 token) internal view returns (bool) {
        EnumerableSet.AddressSet storage poolTokens = _minimalSwapInfoPoolsTokens[poolId];
        bytes32 currentBalance = _getMinimalSwapInfoPoolTokenBalance(poolTokens, poolId, token);
        return currentBalance.isManaged();
    }

    function _updateMinimalSwapInfoPoolBalance(
        bytes32 poolId,
        IERC20 token,
        function(bytes32, uint128) pure returns (bytes32) mutation,
        uint128 amount
    ) internal {
        EnumerableSet.AddressSet storage poolTokens = _minimalSwapInfoPoolsTokens[poolId];
        _updateMinimalSwapInfoPoolBalance(poolTokens, poolId, token, mutation, amount);
    }

    function _updateMinimalSwapInfoPoolBalance(
        EnumerableSet.AddressSet storage poolTokens,
        bytes32 poolId,
        IERC20 token,
        function(bytes32, uint128) pure returns (bytes32) mutation,
        uint128 amount
    ) internal {
        bytes32 currentBalance = _getMinimalSwapInfoPoolTokenBalance(poolTokens, poolId, token);
        _minimalSwapInfoPoolsBalances[poolId][token] = mutation(currentBalance, amount);
    }

    function _getMinimalSwapInfoPoolTokenBalance(
        EnumerableSet.AddressSet storage poolTokens,
        bytes32 poolId,
        IERC20 token
    ) internal view returns (bytes32) {
        require(poolTokens.contains(address(token)), "ERR_TOKEN_NOT_REGISTERED");
        return _minimalSwapInfoPoolsBalances[poolId][token];
    }

    function _isMinimalSwapInfoPoolTokenRegistered(bytes32 poolId, IERC20 token) internal view returns (bool) {
        EnumerableSet.AddressSet storage poolTokens = _minimalSwapInfoPoolsTokens[poolId];
        return poolTokens.contains(address(token));
    }
}
