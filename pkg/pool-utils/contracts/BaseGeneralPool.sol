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

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "@balancer-labs/v2-interfaces/contracts/vault/IGeneralPool.sol";

import "./BasePool.sol";

/**
 * @dev Extension of `BasePool`, adding a handler for `IGeneralPool.onSwap`.
 *
 * Derived contracts must call `BasePool`'s constructor, and implement `_onSwapGivenIn` and `_onSwapGivenOut`
 * along with `BasePool`'s virtual functions. Inheriting from this contract lets derived contracts choose the
 * General specialization setting.
 */
abstract contract BaseGeneralPool is IGeneralPool, BasePool {
    // Swap Hooks

    function onSwap(
        SwapRequest memory swapRequest,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 indexOut
    ) external override onlyVault(swapRequest.poolId) returns (uint256) {
        _beforeSwapJoinExit();

        _validateIndexes(indexIn, indexOut, _getTotalTokens());
        uint256[] memory scalingFactors = _scalingFactors();

        return
            swapRequest.kind == IVault.SwapKind.GIVEN_IN
                ? _swapGivenIn(swapRequest, balances, indexIn, indexOut, scalingFactors)
                : _swapGivenOut(swapRequest, balances, indexIn, indexOut, scalingFactors);
    }

    function _swapGivenIn(
        SwapRequest memory swapRequest,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 indexOut,
        uint256[] memory scalingFactors
    ) internal virtual returns (uint256) {
        // Fees are subtracted before scaling, to reduce the complexity of the rounding direction analysis.
        swapRequest.amount = _subtractSwapFeeAmount(swapRequest.amount, getSwapFeePercentage());

        _upscaleArray(balances, scalingFactors);
        swapRequest.amount = _upscale(swapRequest.amount, scalingFactors[indexIn]);

        uint256 amountOut = _onSwapGivenIn(swapRequest, balances, indexIn, indexOut);

        // amountOut tokens are exiting the Pool, so we round down.
        return _downscaleDown(amountOut, scalingFactors[indexOut]);
    }

    function _swapGivenOut(
        SwapRequest memory swapRequest,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 indexOut,
        uint256[] memory scalingFactors
    ) internal virtual returns (uint256) {
        _upscaleArray(balances, scalingFactors);
        swapRequest.amount = _upscale(swapRequest.amount, scalingFactors[indexOut]);

        uint256 amountIn = _onSwapGivenOut(swapRequest, balances, indexIn, indexOut);

        // amountIn tokens are entering the Pool, so we round up.
        amountIn = _downscaleUp(amountIn, scalingFactors[indexIn]);

        // Fees are added after scaling happens, to reduce the complexity of the rounding direction analysis.
        return _addSwapFeeAmount(amountIn, getSwapFeePercentage());
    }

    /*
     * @dev Called when a swap with the Pool occurs, where the amount of tokens entering the Pool is known.
     *
     * Returns the amount of tokens that will be taken from the Pool in return.
     *
     * All amounts inside `swapRequest` and `balances` are upscaled. The swap fee has already been deducted from
     * `swapRequest.amount`.
     *
     * The return value is also considered upscaled, and will be downscaled (rounding down) before returning it to the
     * Vault.
     */
    function _onSwapGivenIn(
        SwapRequest memory swapRequest,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 indexOut
    ) internal virtual returns (uint256);

    /*
     * @dev Called when a swap with the Pool occurs, where the amount of tokens exiting the Pool is known.
     *
     * Returns the amount of tokens that will be granted to the Pool in return.
     *
     * All amounts inside `swapRequest` and `balances` are upscaled.
     *
     * The return value is also considered upscaled, and will be downscaled (rounding up) before applying the swap fee
     * and returning it to the Vault.
     */
    function _onSwapGivenOut(
        SwapRequest memory swapRequest,
        uint256[] memory balances,
        uint256 indexIn,
        uint256 indexOut
    ) internal virtual returns (uint256);

    function _validateIndexes(
        uint256 indexIn,
        uint256 indexOut,
        uint256 limit
    ) private pure {
        _require(indexIn < limit && indexOut < limit, Errors.OUT_OF_BOUNDS);
    }
}
