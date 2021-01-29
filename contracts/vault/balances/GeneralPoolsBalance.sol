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

import "@openzeppelin/contracts/utils/SafeCast.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./BalanceAllocation.sol";
import "../../lib/math/SignedMath.sol";
import "../../lib/helpers/EnumerableMap.sol";

contract GeneralPoolsBalance {
    using SafeCast for uint256;
    using SignedMath for int256;
    using BalanceAllocation for bytes32;

    using EnumerableMap for EnumerableMap.IERC20ToBytes32Map;

    // Data for Pools with General Pool Specialization setting
    //
    // These Pools use the IGeneralPoolQuote interface, which means the Vault must query the balance for *all* of their
    // tokens in every swap. If we kept a mapping of token to balance plus a set (array) of tokens, it'd be very gas
    // intensive to read all token addresses just to then do a lookup on the balance mapping.
    // Instead, we use our customized EnumerableMap, which lets us read the N balances in N+1 storage accesses (one for
    // the number of tokens in the Pool), as well as access the index of any token in a single read (required for the
    // IGeneralPoolQuote call) and update an entry's value given its index.

    mapping(bytes32 => EnumerableMap.IERC20ToBytes32Map) internal _generalPoolsBalances;

    /**
     * @dev Registers a list of tokens in a General Pool.
     *
     * Requirements:
     *
     * - Each token must not be the zero address.
     * - Each token must not be registered in the Pool.
     */
    function _registerGeneralPoolTokens(bytes32 poolId, IERC20[] memory tokens) internal {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            IERC20 token = tokens[i];
            require(token != IERC20(0), "ERR_TOKEN_CANT_BE_ZERO");
            bool added = poolBalances.set(token, 0);
            require(added, "ERR_TOKEN_ALREADY_REGISTERED");
            // No need to delete the balance entries, since they already are zero
        }
    }

    /**
     * @dev Unregisters a list of tokens in a General Pool.
     *
     * Requirements:
     *
     * - Each token must be registered in the Pool.
     * - Each token must have non balance in the Vault.
     */
    function _unregisterGeneralPoolTokens(bytes32 poolId, IERC20[] memory tokens) internal {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            IERC20 token = tokens[i];
            bytes32 currentBalance = _getGeneralPoolBalance(poolBalances, token);
            require(currentBalance.isZero(), "ERR_TOKEN_BALANCE_IS_NOT_ZERO");
            poolBalances.remove(token);
        }
    }

    /**
     * @dev Adds cash to a General Pool for a list of tokens. This function doesn't check that the lengths of
     * `tokens` and `amounts` match, it is responsibility of the caller to ensure that.
     *
     * Requirements:
     *
     * - Each token must be registered in the pool
     * - Amounts can be zero
     */
    function _increaseGeneralPoolCash(
        bytes32 poolId,
        IERC20[] memory tokens,
        uint256[] memory amounts
    ) internal {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            uint128 amount = amounts[i].toUint128();
            _updateGeneralPoolBalance(poolBalances, tokens[i], BalanceAllocation.increaseCash, amount);
        }
    }

    function _alterGeneralPoolCash(
        bytes32 poolId,
        IERC20[] memory tokens,
        int256[] memory amounts
    ) internal {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            int256 amount = amounts[i];

            _updateGeneralPoolBalance(
                poolBalances,
                tokens[i],
                amount > 0 ? BalanceAllocation.increaseCash : BalanceAllocation.decreaseCash,
                amount.abs().toUint128()
            );
        }
    }

    /**
     * @dev Removes cash from a General Pool for a list of tokens. This function doesn't check that the lengths of
     * `tokens` and `amounts` match, it is responsibility of the caller to ensure that.
     *
     * Requirements:
     *
     * - Each token must be registered in the Pool.
     * - Each amount must be less or equal than the Pool's cash for that token.
     */
    function _decreaseGeneralPoolCash(
        bytes32 poolId,
        IERC20[] memory tokens,
        uint256[] memory amounts
    ) internal {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];

        for (uint256 i = 0; i < tokens.length; ++i) {
            uint128 amount = amounts[i].toUint128();
            _updateGeneralPoolBalance(poolBalances, tokens[i], BalanceAllocation.decreaseCash, amount);
        }
    }

    function _generalPoolCashToManaged(
        bytes32 poolId,
        IERC20 token,
        uint128 amount
    ) internal {
        _updateGeneralPoolBalance(poolId, token, BalanceAllocation.cashToManaged, amount);
    }

    function _generalPoolManagedToCash(
        bytes32 poolId,
        IERC20 token,
        uint128 amount
    ) internal {
        _updateGeneralPoolBalance(poolId, token, BalanceAllocation.managedToCash, amount);
    }

    function _setGeneralPoolManagedBalance(
        bytes32 poolId,
        IERC20 token,
        uint128 amount
    ) internal {
        _updateGeneralPoolBalance(poolId, token, BalanceAllocation.setManagedBalance, amount);
    }

    function _updateGeneralPoolBalance(
        bytes32 poolId,
        IERC20 token,
        function(bytes32, uint128) pure returns (bytes32) mutation,
        uint128 amount
    ) internal {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];
        _updateGeneralPoolBalance(poolBalances, token, mutation, amount);
    }

    function _updateGeneralPoolBalance(
        EnumerableMap.IERC20ToBytes32Map storage poolBalances,
        IERC20 token,
        function(bytes32, uint128) pure returns (bytes32) mutation,
        uint128 amount
    ) internal {
        bytes32 currentBalance = _getGeneralPoolBalance(poolBalances, token);
        poolBalances.set(token, mutation(currentBalance, amount));
    }

    /**
     * @dev Returns an array with all the tokens and balances in a General Pool.
     * This order may change when tokens are added to or removed from the Pool.
     */
    function _getGeneralPoolTokens(bytes32 poolId)
        internal
        view
        returns (IERC20[] memory tokens, uint256[] memory balances)
    {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];
        tokens = new IERC20[](poolBalances.length());
        balances = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; ++i) {
            // Because the iteration is bounded by `tokens.length` already fetched from the enumerable map,
            // we can use `unchecked_at` as we know `i` is a valid token index, saving storage reads.
            (IERC20 token, bytes32 balance) = poolBalances.unchecked_at(i);
            tokens[i] = token;
            balances[i] = balance.totalBalance();
        }
    }

    function _getGeneralPoolBalance(bytes32 poolId, IERC20 token) internal view returns (bytes32) {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];
        return _getGeneralPoolBalance(poolBalances, token);
    }

    function _getGeneralPoolBalance(EnumerableMap.IERC20ToBytes32Map storage poolBalances, IERC20 token)
        internal
        view
        returns (bytes32)
    {
        return poolBalances.get(token, "ERR_TOKEN_NOT_REGISTERED");
    }

    function _isGeneralPoolTokenRegistered(bytes32 poolId, IERC20 token) internal view returns (bool) {
        EnumerableMap.IERC20ToBytes32Map storage poolBalances = _generalPoolsBalances[poolId];
        return poolBalances.contains(token);
    }
}
